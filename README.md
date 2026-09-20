# ABX 盲听测试

一个纯本地的音频 ABX 双盲对比 Web 应用。上传 A、B 两段同格式音频后，服务端生成随机 X 题序（提交前映射完全隐藏），你在 A / B / X 之间自由切换试听并逐题作答，提交后一次性揭晓正确率与逐题映射。

- 后端：Node.js + Express
- 前端：浏览器 Web Audio API（无框架、无构建步骤）
- 数据：音频与会话**仅保存在本机**，不经过任何外部服务

## 功能特性

- 上传 A、B 两个**同格式**音频（WAV / MP3 / FLAC / OGG / M4A / AAC / OPUS / WebM / AIFF）
- 统一时间轴：自动以较短音频的时长为准
- 服务端用加密随机数生成每题 X = A 或 B 的映射，提交前任何接口都不泄露
- X 音频以 chunked 流式下发（无 Content-Length / 文件名），避免按文件大小猜测
- 试听页在 A / B / X 间切换时**保持播放位置与暂停状态**，可拖动进度条
- 逐题作答，可随时返回任意题目修改答案；全部作答后才能提交
- 提交后一次性揭示：总正确率 + 逐题「X 实际是 / 你的答案 / 对错」
- 会话默认 24 小时过期自动清理，也可手动删除

## 快速开始

### 方式一：Docker（推荐，单条命令）

```bash
docker compose up --build
```

启动后访问：**http://localhost:3000**（端口 `3000`）

更换宿主机端口：

```bash
PORT=8080 docker compose up --build
```

停止并清理数据卷：`docker compose down -v`

### 方式二：本地 Node.js（单条命令）

```bash
npm install && npm start
```

启动后访问：**http://localhost:3000**（端口 `3000`，可用 `PORT` 环境变量覆盖）

要求 Node.js ≥ 18。

## 使用流程

1. 打开首页，选择音频 A 和音频 B（需同格式），设置题目数量（1–50，默认 8）
2. 点击「开始测试」，浏览器解码音频并进入试听页
3. 每题中点击 **A / B / X** 切换音源对比试听，切换时播放位置与暂停状态保持不变
4. 对每题选择「X = A」或「X = B」，可通过「上一题 / 下一题」或进度圆点返回修改
5. 全部作答后点击「提交并揭晓答案」，一次性查看正确率与逐题映射

## 实现原理

- **统一时间轴**：前端用 `decodeAudioData` 解码 A、B 后取 `min(durationA, durationB)` 作为播放上限，所有音源共用该时间轴
- **进度保持**：播放引擎记录「起始偏移 + AudioContext 起始时刻」，切换音源时在原偏移处重建 `AudioBufferSourceNode` 继续播放；暂停状态下切换只换缓冲
- **映射隐藏**：X 映射只存在于服务端内存；`/trial/:n/x` 接口以 `application/octet-stream` + chunked 传输下发音频，不暴露文件大小与文件名
- **本地存储**：音频写入本机 `./data/<sessionId>/`（Docker 中为命名卷 `abx-data`），会话状态仅存内存，默认 24 小时过期清理

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/session` | 上传 A/B（multipart 字段 `a`、`b`、`numTrials`），创建会话与随机题序 |
| GET | `/api/session/:id` | 会话状态（题数、已答情况；不含 X 映射） |
| GET | `/api/session/:id/audio/A`（或 `B`） | 下载参考音频 |
| GET | `/api/session/:id/trial/:n/x` | 下载第 n 题的 X（按隐藏映射返回 A 或 B 的内容） |
| POST | `/api/session/:id/answer` | 保存/修改某题答案 `{trial, answer}` |
| POST | `/api/session/:id/submit` | 提交，一次性返回正确率与逐题映射（幂等） |
| DELETE | `/api/session/:id` | 删除会话及其音频文件 |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口 |
| `DATA_DIR` | `./data`（容器内 `/app/data`） | 音频文件保存目录 |
| `SESSION_TTL_MS` | `86400000`（24h） | 会话过期时间（毫秒） |

## 目录结构

```
├── server.js            # Express 服务端（会话、随机映射、音频下发、判分）
├── public/
│   ├── index.html       # 单页应用（上传 / 测试 / 结果三个视图）
│   ├── app.js           # Web Audio 播放引擎与交互逻辑
│   └── style.css
├── data/                # 运行时生成：本机音频存储（已 gitignore）
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## 说明与限制

- 音频格式支持取决于浏览器的解码能力（`decodeAudioData`）
- 会话保存在内存中，服务重启后进行中的会话会失效（音频文件会随过期清理机制删除）
- 本工具面向本机自测场景；刻意抓包比对字节流理论上可推断 X，正常使用界面则完全盲测
