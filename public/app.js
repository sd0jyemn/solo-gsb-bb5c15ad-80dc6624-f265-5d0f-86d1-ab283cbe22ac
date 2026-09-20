'use strict';

/* =====================================================================
 * ABX 盲听前端
 *  - Web Audio API 解码播放：A / B 常驻，X 按题懒加载
 *  - 三路切换与跨题切换均保持播放位置和播放/暂停状态
 *  - 提交前答案只保存在本机（内存 + localStorage），映射不下发
 * ===================================================================== */

const $ = (sel) => document.querySelector(sel);

const els = {
  viewUpload: $('#view-upload'),
  viewTest: $('#view-test'),
  viewResult: $('#view-result'),
  fileA: $('#file-a'),
  fileB: $('#file-b'),
  labelA: $('#label-a'),
  labelB: $('#label-b'),
  metaA: $('#meta-a'),
  metaB: $('#meta-b'),
  zoneA: $('#zone-a'),
  zoneB: $('#zone-b'),
  questionCount: $('#question-count'),
  btnCreate: $('#btn-create'),
  uploadError: $('#upload-error'),
  uploadProgress: $('#upload-progress'),

  qNum: $('#q-num'),
  qTotal: $('#q-total'),
  trackBtns: document.querySelectorAll('.track'),
  btnPlay: $('#btn-play'),
  seek: $('#seek'),
  timeCur: $('#time-cur'),
  timeDur: $('#time-dur'),
  ansBtns: document.querySelectorAll('.ans'),
  navDots: $('#nav-dots'),
  btnPrev: $('#btn-prev'),
  btnNext: $('#btn-next'),
  btnSubmit: $('#btn-submit'),
  testError: $('#test-error'),
  xLoadingSub: $('#x-loading-sub'),

  scoreBig: $('#score-big'),
  scorePct: $('#score-pct'),
  scoreVerdict: $('#score-verdict'),
  resultBody: $('#result-body'),
  btnRestart: $('#btn-restart'),
  btnDiscard: $('#btn-discard'),
};

const state = {
  session: null,          // 服务端会话信息
  current: 0,             // 当前题号（0 起）
  answers: [],            // 每题 'A' | 'B' | null
  selected: null,         // 当前选中轨 'a' | 'b' | 'x'
};

/* ------------------------------ 工具 ------------------------------ */

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function showError(node, msg) {
  if (!msg) {
    node.hidden = true;
    node.textContent = '';
  } else {
    node.hidden = false;
    node.textContent = msg;
  }
}

function showView(name) {
  els.viewUpload.hidden = name !== 'upload';
  els.viewTest.hidden = name !== 'test';
  els.viewResult.hidden = name !== 'result';
  if (name === 'test') location.hash = '#/test';
  else if (name === 'result') location.hash = '#/result';
  else if (location.hash) history.replaceState(null, '', location.pathname);
}

function answerStoreKey(sid) {
  return `abx-answers:${sid}`;
}

function loadAnswers(sid, count) {
  try {
    const raw = localStorage.getItem(answerStoreKey(sid));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === count) return parsed;
    }
  } catch { /* ignore */ }
  return new Array(count).fill(null);
}

function saveAnswers() {
  if (state.session) {
    localStorage.setItem(answerStoreKey(state.session.sessionId),
      JSON.stringify(state.answers));
  }
}

/* 用浏览器解码本地文件以获取精确时长（与播放路径一致）。
   复用同一个 AudioContext，避免重复创建上下文。 */
let probeCtx = null;
function getProbeCtx() {
  if (!probeCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    probeCtx = new AC();
  }
  return probeCtx;
}

function probeDuration(file) {
  return file.arrayBuffer().then((buf) => {
    return getProbeCtx().decodeAudioData(buf.slice(0)).then((audio) => {
      return { duration: audio.duration };
    }).catch(async () => {
      // 极少数容器 decodeAudioData 不支持时，退回 <audio> 元数据时长
      return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const au = new Audio();
        au.preload = 'metadata';
        au.onloadedmetadata = () => {
          const d = au.duration;
          URL.revokeObjectURL(url);
          d && isFinite(d) ? resolve({ duration: d })
            : reject(new Error('无法读取该音频时长，请尝试转成 wav/flac'));
        };
        au.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取该音频文件')); };
        au.src = url;
      });
    });
  });
}

/* ----------------------- Web Audio 播放引擎 ----------------------- */

class ABXPlayer {
  constructor(timelineDuration) {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.duration = timelineDuration;   // 统一时间轴 = min(时长 A, 时长 B)
    this.buffers = { a: null, b: null, x: null };
    this.xQuestion = -1;               // 当前 x buffer 对应的题号
    this.xToken = 0;                   // 防止切题时旧请求回灌
    this.track = 'x';                  // 当前监听轨
    this.isPlaying = false;
    this.position = 0;                 // 时间轴位置（秒）
    this.source = null;
    this.startedAt = 0;                // ctx.currentTime 基准
    this.startedOffset = 0;
    this._raf = null;
    this.onbusy = null;                // (busy: boolean) => void
  }

  async loadAB(sessionId) {
    const [a, b] = await Promise.all([
      this._fetchDecode(`/api/sessions/${sessionId}/audio/a?r=ab`),
      this._fetchDecode(`/api/sessions/${sessionId}/audio/b?r=ab`),
    ]);
    this.buffers.a = a;
    this.buffers.b = b;
  }

  async ensureX(sessionId, questionIndex) {
    if (this.buffers.x && this.xQuestion === questionIndex) return;
    const token = ++this.xToken;
    this.onbusy && this.onbusy(true);
    try {
      const buf = await this._fetchDecode(
        `/api/sessions/${sessionId}/audio/q${questionIndex}`);
      if (token !== this.xToken) return;   // 已切到别的题，丢弃
      this.buffers.x = buf;
      this.xQuestion = questionIndex;
    } catch (e) {
      if (token === this.xToken) {
        this.buffers.x = null;
        this.xQuestion = -1;
        throw e;
      }
    } finally {
      if (token === this.xToken) this.onbusy && this.onbusy(false);
    }
  }

  /** 作废进行中的 X 加载并清空缓冲（翻题时调用） */
  dropX() {
    this.xToken++;
    this.buffers.x = null;
    this.xQuestion = -1;
    this.onbusy && this.onbusy(false);
  }

  async _fetchDecode(url) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error('音频加载失败（' + resp.status + '）');
    const arr = await resp.arrayBuffer();
    return await this.ctx.decodeAudioData(arr);
  }

  /**
   * 切换监听轨。
   * 关键行为：不改变 position；若正在播放，新轨从同一位置无缝续播，
   * 若处于暂停则保持暂停。
   */
  switchTrack(track, sessionId) {
    this.track = track;
    if (track === 'x') {
      // 异步加载完成后由 selectTrack 在 buffer 就绪时重挂
      this.ensureX(sessionId, state.current).then(() => {
        if (this.track === 'x' && this.isPlaying) this._resumeSource();
      }).catch(() => { /* 错误已在界面层提示 */ });
    }
    if (this.isPlaying && this._bufferReady(track)) {
      this._resumeSource();
    }
  }

  _bufferReady(track) {
    return !!(track === 'x' && this.xQuestion === state.current
      ? this.buffers.x
      : this.buffers[track]);
  }

  play() {
    if (this.isPlaying) return;
    if (!this._bufferReady(this.track)) return;   // X 尚未加载完
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.isPlaying = true;
    this._resumeSource();
    this._loop();
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this._teardownSource();
    cancelAnimationFrame(this._raf);
  }

  toggle() {
    this.isPlaying ? this.pause() : this.play();
  }

  seekTo(seconds) {
    const wasPlaying = this.isPlaying;
    this._teardownSource();
    this.position = Math.min(Math.max(seconds, 0), this.duration);
    if (wasPlaying && this._bufferReady(this.track)) this._resumeSource();
  }

  _resumeSource() {
    this._teardownSource();
    const buffer = this.track === 'x' && this.xQuestion === state.current
      ? this.buffers.x
      : this.buffers[this.track];
    if (!buffer) return;

    const offset = Math.min(this.position, this.duration, buffer.duration);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    src.start(0, offset);
    this.source = src;
    this.startedAt = this.ctx.currentTime;
    this.startedOffset = offset;

    src.onended = () => {
      // 仅在自然播完（非手动 teardown）时回到暂停态
      if (this.source === src) {
        this.source = null;
        this.isPlaying = false;
        this.position = 0;   // 播完后回到时间轴起点，便于再次对比
        cancelAnimationFrame(this._raf);
        this._tick();
        this._notifyState();
      }
    };
  }

  _teardownSource() {
    if (this.source) {
      const src = this.source;
      this.source = null;
      this.position = this._currentPosition();
      try { src.onended = null; src.stop(); } catch { /* 已停止 */ }
    }
  }

  _currentPosition() {
    if (this.source) {
      return Math.min(
        this.startedOffset + (this.ctx.currentTime - this.startedAt),
        this.duration);
    }
    return this.position;
  }

  _loop() {
    this._tick();
    if (this.isPlaying) this._raf = requestAnimationFrame(() => this._loop());
  }

  onstate = null;
  _notifyState() { this.onstate && this.onstate(); }

  _tick() {
    const pos = this._currentPosition();
    // 到达统一时间轴终点：停在末尾（暂停态）
    if (this.isPlaying && pos >= this.duration - 0.01) {
      this.pause();
      this.position = this.duration;
      this._notifyState();
      return;
    }
    this._notifyState();
  }
}

let player = null;

/* ------------------------------ 上传页 ------------------------------ */

const picked = { a: null, b: null };

async function onPick(which, file) {
  picked[which] = file;
  const label = which === 'a' ? els.labelA : els.labelB;
  const meta = which === 'a' ? els.metaA : els.metaB;
  const zone = which === 'a' ? els.zoneA : els.zoneB;
  label.textContent = file.name;
  meta.textContent = '读取时长中…';
  zone.classList.add('has-file');
  try {
    const { duration } = await probeDuration(file);
    file._duration = duration;
    meta.textContent = `${fmtTime(duration)} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    warnFormatMismatch();
  } catch (e) {
    file._duration = null;
    meta.textContent = '';
    label.textContent = file.name + '（无法读取）';
    showError(els.uploadError, e.message);
  }
  refreshCreateButton();
}

function extOf(file) {
  const m = /\.[^.]+$/.exec(file.name);
  return m ? m[0].toLowerCase() : '';
}

function warnFormatMismatch() {
  if (picked.a && picked.b) {
    if (extOf(picked.a) !== extOf(picked.b)) {
      showError(els.uploadError,
        `两段音频格式不同（${extOf(picked.a)} 与 ${extOf(picked.b)}），请选择同格式文件。`);
    } else {
      showError(els.uploadError, null);
    }
  }
}

function refreshCreateButton() {
  const n = parseInt(els.questionCount.value, 10);
  const ok = picked.a && picked.b
    && picked.a._duration && picked.b._duration
    && extOf(picked.a) === extOf(picked.b)
    && Number.isInteger(n) && n >= 2 && n <= 20;
  els.btnCreate.disabled = !ok;
}

els.fileA.addEventListener('change', (e) => e.target.files[0] && onPick('a', e.target.files[0]));
els.fileB.addEventListener('change', (e) => e.target.files[0] && onPick('b', e.target.files[0]));
els.questionCount.addEventListener('input', refreshCreateButton);

els.btnCreate.addEventListener('click', async () => {
  showError(els.uploadError, null);
  els.btnCreate.disabled = true;
  els.uploadProgress.hidden = false;
  try {
    const fd = new FormData();
    fd.append('a', picked.a);
    fd.append('b', picked.b);
    fd.append('durationA', String(picked.a._duration));
    fd.append('durationB', String(picked.b._duration));
    fd.append('questionCount', String(parseInt(els.questionCount.value, 10)));

    const resp = await fetch('/api/sessions', { method: 'POST', body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '创建会话失败');
    await startTest(data);
  } catch (e) {
    showError(els.uploadError, e.message);
  } finally {
    els.uploadProgress.hidden = true;
    refreshCreateButton();
  }
});

/* ------------------------------ 答题页 ------------------------------ */

async function startTest(session) {
  state.session = session;
  state.current = 0;
  state.answers = loadAnswers(session.sessionId, session.questionCount);
  state.selected = null;

  showView('test');
  showError(els.testError, null);
  els.qTotal.textContent = String(session.questionCount);
  els.timeDur.textContent = fmtTime(session.timelineDuration);

  player = new ABXPlayer(session.timelineDuration);
  player.onstate = renderPlayerState;
  player.onbusy = (busy) => {
    document.querySelector('.track.x').classList.toggle('busy', busy);
    els.xLoadingSub.textContent = busy ? '加载中…' : '待判音频';
  };

  renderDots();
  try {
    await player.loadAB(session.sessionId);
    await selectTrack('x');
    els.btnPrev.disabled = true;
    els.btnNext.disabled = session.questionCount === 1;
  } catch (e) {
    showError(els.testError, e.message + '，请返回上传页重试。');
  }
}

async function selectTrack(track) {
  state.selected = track;
  els.trackBtns.forEach((b) =>
    b.classList.toggle('active', b.dataset.track === track));
  try {
    if (track === 'x') {
      await player.ensureX(state.session.sessionId, state.current);
    }
    // 保持当前播放/暂停状态与位置：播放中切轨则新轨同位置续播
    player.switchTrack(track, state.session.sessionId);
    showError(els.testError, null);
  } catch (e) {
    showError(els.testError, 'X 音频加载失败：' + e.message);
  }
  renderPlayerState();
}

els.trackBtns.forEach((btn) => {
  btn.addEventListener('click', () => selectTrack(btn.dataset.track));
});

els.btnPlay.addEventListener('click', () => player.toggle());

els.seek.addEventListener('input', () => {
  const t = (els.seek.value / 1000) * player.duration;
  player.seekTo(t);
  renderPlayerState();
});

function renderPlayerState() {
  const pos = player ? player._currentPosition() : 0;
  els.timeCur.textContent = fmtTime(pos);
  els.seek.value = String(Math.round((pos / (player ? player.duration : 1)) * 1000));
  els.btnPlay.textContent = player && player.isPlaying ? '⏸ 暂停' : '▶ 播放';
}

/* 作答 */
els.ansBtns.forEach((btn) => {
  btn.addEventListener('click', () => answer(btn.dataset.answer));
});

function answer(value) {
  state.answers[state.current] = value;
  saveAnswers();
  renderDots();
  renderAnswerButtons();
}

function renderAnswerButtons() {
  const cur = state.answers[state.current];
  els.ansBtns.forEach((b) =>
    b.classList.toggle('selected', b.dataset.answer === cur));
}

/* 题目导航：切题保持位置与暂停状态，仅更换 X 的内容 */
async function gotoQuestion(idx) {
  if (idx < 0 || idx >= state.session.questionCount) return;
  state.current = idx;
  els.qNum.textContent = String(idx + 1);
  renderDots();
  renderAnswerButtons();
  showError(els.testError, null);

  // X 缓冲属于上一题：作废加载并清空，保证不会播错内容
  if (player) {
    player.dropX();
    if (state.selected === 'x') {
      try {
        await player.ensureX(state.session.sessionId, idx);
        if (player.isPlaying) player.switchTrack('x', state.session.sessionId);
      } catch (e) {
        showError(els.testError, 'X 音频加载失败：' + e.message);
      }
    }
  }
  els.btnPrev.disabled = idx === 0;
  els.btnNext.disabled = idx === state.session.questionCount - 1;
}

function renderDots() {
  els.navDots.innerHTML = '';
  state.answers.forEach((ans, i) => {
    const dot = document.createElement('button');
    dot.className = 'dot'
      + (ans ? ' answered' : '')
      + (i === state.current ? ' current' : '');
    dot.textContent = String(i + 1);
    dot.title = `第 ${i + 1} 题${ans ? '（已作答：' + ans + '）' : ''}`;
    dot.addEventListener('click', () => gotoQuestion(i));
    els.navDots.appendChild(dot);
  });
}

els.btnPrev.addEventListener('click', () => gotoQuestion(state.current - 1));
els.btnNext.addEventListener('click', () => gotoQuestion(state.current + 1));

els.btnSubmit.addEventListener('click', async () => {
  const unanswered = state.answers.reduce(
    (n, a) => n + (a === null ? 1 : 0), 0);
  if (unanswered > 0) {
    showError(els.testError, `还有 ${unanswered} 题未作答，请答完所有题目后再提交。`);
    const firstUnanswered = state.answers.indexOf(null);
    if (firstUnanswered >= 0) gotoQuestion(firstUnanswered);
    return;
  }
  const ok = confirm('确定提交全部答案？提交后将一次性揭示映射，且不能再返回修改。');
  if (!ok) return;

  els.btnSubmit.disabled = true;
  try {
    const resp = await fetch(`/api/sessions/${state.session.sessionId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: state.answers }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '提交失败');
    await showResult(data);
  } catch (e) {
    showError(els.testError, e.message);
    els.btnSubmit.disabled = false;
  }
});

/* ------------------------------ 结果页 ------------------------------ */

async function showResult(data) {
  const { result, questions } = data;
  if (player) {
    player.pause();
    try { await player.ctx.close(); } catch { /* ignore */ }
  }
  showView('result');

  els.scoreBig.textContent = `${result.correctCount}/${result.questionCount}`;
  els.scorePct.textContent = `正确率 ${Math.round(result.accuracy * 100)}%`;
  els.scoreVerdict.textContent = verdictText(result);

  els.resultBody.innerHTML = '';
  result.detail.forEach((d) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${d.index + 1}</td>` +
      `<td>${d.answer}</td>` +
      `<td>${questions[d.index].xIs}</td>` +
      `<td class="${d.correct ? 'tag-good' : 'tag-bad'}">` +
        `${d.correct ? '✓ 正确' : '✗ 错误'}</td>`;
    els.resultBody.appendChild(tr);
  });

  localStorage.removeItem(answerStoreKey(state.session.sessionId));
}

function verdictText(result) {
  const pct = result.accuracy;
  if (pct === 1) return '全部答对：你几乎可以稳定区分 A 与 B。';
  if (pct >= 0.8) return '大多数正确：差异很可能可闻。';
  if (pct >= 0.6) return '略好于猜测：建议增加题量再测一轮。';
  return '接近随机猜测（50%）：在该素材上差异可能不可闻。';
}

els.btnRestart.addEventListener('click', () => {
  location.hash = '';
  location.reload();
});

els.btnDiscard.addEventListener('click', async () => {
  if (!state.session) return location.reload();
  if (!confirm('将删除服务器上本组音频与会话数据，确定吗？')) return;
  try {
    await fetch(`/api/sessions/${state.session.sessionId}`, { method: 'DELETE' });
  } catch { /* 即使删除失败也回到首页 */ }
  localStorage.removeItem(answerStoreKey(state.session.sessionId));
  location.hash = '';
  location.reload();
});

/* ------------------------------ 快捷键 ------------------------------ */

document.addEventListener('keydown', (e) => {
  if (!els.viewTest.hidden) {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === '1') return selectTrack('a');
    if (k === '2') return selectTrack('x');
    if (k === '3') return selectTrack('b');
    if (k === 'a') return answer('A');
    if (k === 'b') return answer('B');
    if (k === ' ') { e.preventDefault(); return player && player.toggle(); }
    if (k === 'arrowleft') return gotoQuestion(state.current - 1);
    if (k === 'arrowright') return gotoQuestion(state.current + 1);
  }
});

/* 刷新后不保留测试态（答案仍存于 localStorage 仅在同会话内存态中使用） */
showView('upload');
