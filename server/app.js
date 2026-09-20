'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
// 会话在数据目录中保留的时长（毫秒），默认 24 小时，启动时清理过期会话
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_MB || '1024', 10) * 1024 * 1024;
const DATA_DIR = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 允许的同格式音频扩展名（A、B 必须使用同一扩展名 / 容器）
const AUDIO_MIME = {
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
};

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/* ----------------------------- 会话存储 ----------------------------- */

function newSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function isSafeSessionId(id) {
  return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
}

function sessionDir(id) {
  return path.join(SESSIONS_DIR, id);
}

function metaPath(id) {
  return path.join(sessionDir(id), 'meta.json');
}

function readMeta(id) {
  return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
}

function writeMeta(id, meta) {
  const tmp = metaPath(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, metaPath(id));
}

function cleanupExpiredSessions() {
  const now = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSessionId(entry.name)) continue;
    const dir = path.join(SESSIONS_DIR, entry.name);
    try {
      const stat = fs.statSync(path.join(dir, 'meta.json'));
      if (now - stat.mtimeMs > SESSION_TTL_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // 不完整的会话目录也清理掉
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }
}

cleanupExpiredSessions();

/* ----------------------------- 上传处理 ----------------------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(SESSIONS_DIR, req._sessionId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();
      // 以表单字段名（a / b）直接落盘，避免原始文件名带来的信息泄漏
      cb(null, file.fieldname + ext);
    },
  }),
  limits: {
    files: 2,
    fileSize: MAX_UPLOAD_BYTES,
  },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!(file.fieldname === 'a' || file.fieldname === 'b')) {
      return cb(new Error('只接受字段 a 与 b'));
    }
    if (!Object.prototype.hasOwnProperty.call(AUDIO_MIME, ext)) {
      return cb(new Error('不支持的音频格式：' + (ext || '(无扩展名)')));
    }
    cb(null, true);
  },
});

/* ------------------------------- 应用 ------------------------------- */

const app = express();
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

/**
 * 创建会话：返回 sessionId，随后以 multipart 上传 a、b 两个文件。
 * 先建会话目录，便于上传过程中直接流式落盘（音频不会进入内存）。
 */
app.post('/api/sessions', (req, res, next) => {
  const sessionId = newSessionId();
  req._sessionId = sessionId;
  fs.mkdirSync(path.join(SESSIONS_DIR, sessionId), { recursive: true });

  upload.fields([{ name: 'a', maxCount: 1 }, { name: 'b', maxCount: 1 }])(req, res, (err) => {
    if (err) {
      fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `音频过大（单文件上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`
        : err.message;
      return res.status(400).json({ error: msg });
    }

    try {
      if (!req.files || !req.files.a || !req.files.b) {
        throw new Error('必须同时上传 A、B 两段音频');
      }
      const fileA = req.files.a[0];
      const fileB = req.files.b[0];
      const extA = path.extname(fileA.originalname).toLowerCase();
      const extB = path.extname(fileB.originalname).toLowerCase();
      if (extA !== extB) {
        throw new Error(`A、B 必须是同格式音频（当前为 ${extA} 与 ${extB}）`);
      }

      const durationA = parseFloat(req.body.durationA);
      const durationB = parseFloat(req.body.durationB);
      if (!Number.isFinite(durationA) || !Number.isFinite(durationB) ||
          durationA <= 0 || durationB <= 0) {
        throw new Error('缺少有效的音频时长信息');
      }

      let questionCount = parseInt(req.body.questionCount, 10);
      if (!Number.isInteger(questionCount)) questionCount = 10;
      if (questionCount < 2 || questionCount > 20) {
        throw new Error('题目数量必须在 2 - 20 之间');
      }

      const timelineDuration = Math.min(durationA, durationB);

      // 服务端生成随机题序：每题的 X 独立取自 A 或 B；映射在提交前不下发
      const questions = Array.from({ length: questionCount }, (_, i) => ({
        index: i,
        xIs: crypto.randomInt(2) === 0 ? 'A' : 'B',
      }));

      const meta = {
        sessionId,
        ext: extA,
        mime: AUDIO_MIME[extA],
        durationA,
        durationB,
        timelineDuration,
        questionCount,
        createdAt: Date.now(),
        questions,
        submitted: false,
      };
      writeMeta(sessionId, meta);

      res.status(201).json({
        sessionId,
        ext: meta.ext,
        durationA,
        durationB,
        timelineDuration,
        questionCount,
      });
    } catch (e) {
      fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
      res.status(400).json({ error: e.message });
    }
  });
});

function loadSessionParam(req, res) {
  const id = req.params.id;
  if (!isSafeSessionId(id)) {
    res.status(400).json({ error: '会话 ID 无效' });
    return null;
  }
  let meta;
  try {
    meta = readMeta(id);
  } catch {
    res.status(404).json({ error: '会话不存在或已过期' });
    return null;
  }
  return meta;
}

/** 会话信息：未提交时不包含每题的 X 映射 */
app.get('/api/sessions/:id', (req, res) => {
  const meta = loadSessionParam(req, res);
  if (!meta) return;

  const base = {
    sessionId: meta.sessionId,
    ext: meta.ext,
    durationA: meta.durationA,
    durationB: meta.durationB,
    timelineDuration: meta.timelineDuration,
    questionCount: meta.questionCount,
    submitted: meta.submitted,
  };
  if (meta.submitted) {
    base.submission = meta.submission;
    base.questions = meta.questions;
  }
  res.json(base);
});

/**
 * 试听音频：
 *   track = a | b       -> 已知参考音
 *   track = x / q{N}    -> 第 N 题的随机 X（N 从 0 开始）
 * X 的响应中不包含任何可推断来源的信息：统一文件名、统一 MIME、内联返回。
 */
app.get('/api/sessions/:id/audio/:track', (req, res) => {
  const meta = loadSessionParam(req, res);
  if (!meta) return;

  const id = meta.sessionId;
  const { track } = req.params;
  let filePath;
  if (track === 'a') {
    filePath = path.join(sessionDir(id), 'a' + meta.ext);
  } else if (track === 'b') {
    filePath = path.join(sessionDir(id), 'b' + meta.ext);
  } else {
    const m = /^q(\d+)$/.exec(track);
    if (!m) {
      return res.status(400).json({ error: '音轨标识无效' });
    }
    const q = parseInt(m[1], 10);
    if (q < 0 || q >= meta.questionCount) {
      return res.status(400).json({ error: '题号越界' });
    }
    // 提交后不允许再试听 X，防止“边看答案边验证”
    if (meta.submitted) {
      return res.status(403).json({ error: '会话已提交' });
    }
    filePath = path.join(sessionDir(id),
      (meta.questions[q].xIs === 'A' ? 'a' : 'b') + meta.ext);
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '音频文件缺失' });
  }

  // 统一中立标识，避免从文件名 / MIME 差异推断 X 来源
  res.setHeader('Content-Type', meta.mime);
  res.setHeader('Content-Disposition', `inline; filename="track${meta.ext}"`);
  if (track !== 'a' && track !== 'b') {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.sendFile(filePath, { acceptRanges: true });
});

/** 提交全部答案：提交后一次性揭示正确率与逐题映射 */
app.post('/api/sessions/:id/submit', (req, res) => {
  const meta = loadSessionParam(req, res);
  if (!meta) return;

  if (meta.submitted) {
    return res.status(409).json({
      error: '该会话已提交',
      result: meta.submission,
      questions: meta.questions,
    });
  }

  const answers = req.body && req.body.answers;
  if (!Array.isArray(answers) || answers.length !== meta.questionCount) {
    return res.status(400).json({ error: `答案数量必须为 ${meta.questionCount} 题` });
  }

  const detail = meta.questions.map((q, i) => {
    const given = answers[i];
    if (given !== 'A' && given !== 'B') {
      const err = new Error(`第 ${i + 1} 题答案无效`);
      err.statusCode = 400;
      throw err;
    }
    return {
      index: i,
      answer: given,
      xIs: q.xIs,
      correct: given === q.xIs,
    };
  }).filter(Boolean);

  const correctCount = detail.filter((d) => d.correct).length;
  const submission = {
    submittedAt: Date.now(),
    correctCount,
    questionCount: meta.questionCount,
    accuracy: correctCount / meta.questionCount,
    detail,
  };

  meta.submitted = true;
  meta.submission = submission;
  writeMeta(meta.sessionId, meta);

  res.json({ result: submission, questions: meta.questions });
});

// submit 路由内答案非法时的错误兜底
app.use((err, req, res, next) => {
  if (err) {
    return res.status(err.statusCode || 500).json({ error: err.message || '服务器错误' });
  }
  next();
});

app.delete('/api/sessions/:id', (req, res) => {
  const id = req.params.id;
  if (!isSafeSessionId(id)) {
    return res.status(400).json({ error: '会话 ID 无效' });
  }
  fs.rmSync(sessionDir(id), { recursive: true, force: true });
  res.status(204).end();
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, HOST, () => {
  console.log(`ABX 盲听服务已启动: http://localhost:${PORT}`);
  console.log(`数据目录（仅本机）: ${DATA_DIR}`);
});
