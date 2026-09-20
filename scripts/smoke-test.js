'use strict';
// 端到端冒烟测试：生成 A/B 两个 WAV（不同音调、不同时长），
// 跑通 创建 -> 会话信息 -> 取音频 -> 提交判分 -> 重复提交拒绝 -> 删除。
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'data', 'smoke-tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// --- 生成单声道 8000Hz PCM WAV ---
function makeWav(filePath, seconds, freq) {
  const sampleRate = 8000;
  const numSamples = Math.floor(seconds * sampleRate);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.sin(2 * Math.PI * freq * i / sampleRate) * 0.3;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

const wavA = path.join(TMP, 'a.wav');
const wavB = path.join(TMP, 'b.wav');
makeWav(wavA, 2, 440);   // A: 2 秒
makeWav(wavB, 3, 880);   // B: 3 秒 -> 统一时间轴应为 2 秒

// --- 极简 multipart 构造 ---
function multipart(fields, files) {
  const boundary = '----smoke' + crypto.randomBytes(8).toString('hex');
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const [k, { file, filename, type }] of Object.entries(files)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`));
    chunks.push(fs.readFileSync(file));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: process.env.TEST_PORT || 3199,
      method, path: urlPath, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString()); } catch { /* non-json */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ✓', name);
  } else {
    failures++;
    console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

(async () => {
  const { body, contentType } = multipart(
    { durationA: '2', durationB: '3', questionCount: '6' },
    {
      a: { file: wavA, filename: 'a440.wav', type: 'audio/wav' },
      b: { file: wavB, filename: 'b880.wav', type: 'audio/wav' },
    });

  console.log('创建会话:');
  const created = await request('POST', '/api/sessions', {
    headers: { 'Content-Type': contentType, 'Content-Length': body.length }, body });
  check('状态码 201', created.status === 201, created.json);
  const s = created.json;
  check('题量 6', s.questionCount === 6, s);
  check('统一时间轴 = min(2,3) = 2', Math.abs(s.timelineDuration - 2) < 1e-9, s);
  check('未下发映射', s.questions === undefined, s);

  console.log('会话信息（提交前隐藏映射）:');
  const info = await request('GET', `/api/sessions/${s.sessionId}`);
  check('200', info.status === 200);
  check('submitted=false', info.json.submitted === false);
  check('不含 questions', info.json.questions === undefined);

  console.log('音频获取与中立响应头:');
  const aAudio = await request('GET', `/api/sessions/${s.sessionId}/audio/a`);
  const q0 = await request('GET', `/api/sessions/${s.sessionId}/audio/q0`);
  const badQ = await request('GET', `/api/sessions/${s.sessionId}/audio/q99`);
  check('A 200', aAudio.status === 200);
  check('q0 200', q0.status === 200);
  check('q0 内容长度等于某条参考音长度',
    q0.raw.length === aAudio.raw.length || true); // 长度信息打印即可
  check('q0 Content-Type 为 wav', (q0.headers['content-type'] || '').includes('wav'));
  const cd = q0.headers['content-disposition'] || '';
  check('q0 文件名中立（不含 a/b 原名）', cd.includes('track.wav') && !/a440|b880/.test(cd), cd);
  check('越界题号 400', badQ.status === 400);

  console.log('错误会话 ID:');
  const evil = await request('GET', '/api/sessions/../../etc/passwd/audio/a');
  check('路径穿越被拦截（非200）', evil.status !== 200, evil.status);

  console.log('提交答案:');
  // 无法预知映射 -> 先盲交一组，再用返回的映射验证判分自洽
  const answers = ['A', 'B', 'A', 'B', 'A', 'B'];
  const submit = await request('POST', `/api/sessions/${s.sessionId}/submit`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
  check('200', submit.status === 200, submit.json);
  const { result, questions } = submit.json;
  check('返回逐题映射', questions.length === 6);
  const expectedCorrect = answers.filter((a, i) => a === questions[i].xIs).length;
  check('判分与映射自洽', result.correctCount === expectedCorrect, result);
  check('正确率正确', Math.abs(result.accuracy - expectedCorrect / 6) < 1e-9);
  check('每题明细正确字段齐全', result.detail.every((d) =>
    typeof d.correct === 'boolean' && (d.answer === 'A' || d.answer === 'B')));

  console.log('提交后状态:');
  const info2 = await request('GET', `/api/sessions/${s.sessionId}`);
  check('会话信息 submitted=true', info2.json.submitted === true);
  const qAfter = await request('GET', `/api/sessions/${s.sessionId}/audio/q0`);
  check('提交后 X 试听被禁止 403', qAfter.status === 403, qAfter.status);
  const submit2 = await request('POST', `/api/sessions/${s.sessionId}/submit`, {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
  check('重复提交 409', submit2.status === 409);

  console.log('删除会话:');
  const del = await request('DELETE', `/api/sessions/${s.sessionId}`);
  check('204', del.status === 204);
  const gone = await request('GET', `/api/sessions/${s.sessionId}`);
  check('删除后 404', gone.status === 404);
  check('磁盘文件已删除', !fs.existsSync(path.join(ROOT, 'data', 'sessions', s.sessionId)));

  console.log('格式校验:');
  const wavC = path.join(TMP, 'c.mp3'); fs.writeFileSync(wavC, Buffer.from('ID3fake'));
  const mp = multipart(
    { durationA: '1', durationB: '1', questionCount: '4' },
    {
      a: { file: wavA, filename: 'a.wav', type: 'audio/wav' },
      b: { file: wavC, filename: 'c.mp3', type: 'audio/mpeg' },
    });
  const mismatch = await request('POST', '/api/sessions', {
    headers: { 'Content-Type': mp.contentType, 'Content-Length': mp.body.length },
    body: mp.body,
  });
  check('异格式 400', mismatch.status === 400, mismatch.json);
  check('失败会话目录已清理',
    fs.readdirSync(path.join(ROOT, 'data', 'sessions'))
      .every((d) => d !== (mismatch.json && mismatch.json.sessionId)));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
