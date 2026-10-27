/**
 * local 路径的常驻进程:把 jina 嵌入和 bge 精排留在这个进程里。
 * warm.mjs 拉起后自己会退出;检索和嵌入连 127.0.0.1,避免每次重新加载。
 * 空闲时限读 config.mjs 的 OLLAMA_KEEP_ALIVE(默认 2h),与 Ollama 驻留一致。模型名只认 config.mjs。
 * 直接运行即当服务;被 import 时只提供客户端。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, HF_CACHE_DIR, loadConfig, OLLAMA_KEEP_ALIVE } from './config.mjs';
import { loadLocalReranker, scorePair } from './localRerank.mjs';
import { pidAlive, spawnLogged } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(DATA_DIR, '.local-resident.json');
const LOCK_PATH = path.join(DATA_DIR, '.local-resident.lock');
const LOG_PATH = path.join(DATA_DIR, 'local-resident.log');
const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

function keepAliveMs(text) {
  const m = /^(\d+)(h|m|s)$/.exec(String(text || ''));
  if (!m) return 2 * 60 * 60 * 1000;
  const n = Number(m[1]);
  if (m[2] === 'h') return n * 60 * 60 * 1000;
  if (m[2] === 'm') return n * 60 * 1000;
  return n * 1000;
}

function readStateFile() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

function modelsMatch(state) {
  const cfg = loadConfig().models;
  return state?.embedding === cfg.localEmbedding && state?.reranker === cfg.localReranker;
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

async function loadEmbedder(modelId) {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = HF_CACHE_DIR;
  env.allowLocalModels = false;
  try {
    return await pipeline('feature-extraction', modelId, { dtype: 'q8' });
  } catch (e) {
    console.error(`[warn] HuggingFace 下载失败(${e.message}),切换 hf-mirror.com 重试...`);
    env.remoteHost = 'https://hf-mirror.com';
    return pipeline('feature-extraction', modelId, { dtype: 'q8' });
  }
}

async function fetchHealth(state, ms) {
  const resp = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(ms) });
  if (!resp.ok) return null;
  return resp.json();
}

async function waitReady(ms, childPid = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (childPid && !pidAlive(childPid)) return null;
    const state = readStateFile();
    if (state && !pidAlive(state.pid)) return null;
    if (state?.port && modelsMatch(state)) {
      try {
        const health = await fetchHealth(state, 1500);
        if (health?.ready) return health;
      } catch { /* 还在加载 */ }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

function claimStart() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      const cur = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (!pidAlive(cur.pid) || Date.now() - cur.ts > 200000) {
        fs.unlinkSync(LOCK_PATH);
        return claimStart();
      }
    } catch { /* 锁文件不可读时让对方继续等 */ }
    return false;
  }
}

function releaseStart() {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* 锁已不在 */ }
}

export async function stopLocalResident() {
  const state = readStateFile();
  if (state?.port && pidAlive(state.pid)) {
    try {
      await fetch(`http://127.0.0.1:${state.port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1500) });
    } catch { /* 下面再按 pid 结束 */ }
    await new Promise(r => setTimeout(r, 300));
    if (pidAlive(state.pid)) {
      try { process.kill(state.pid); } catch { /* 已退出 */ }
    }
  }
  try { fs.unlinkSync(STATE_PATH); } catch { /* 没有状态文件 */ }
}

function startDetached() {
  return spawnLogged(path.join(here, 'localResident.mjs'), LOG_PATH, here).pid;
}

/** 保证与当前 config 模型一致的常驻进程在跑。返回 /health;超时或失败为 null。 */
export async function ensureLocalResident(onInfo = () => {}) {
  const state = readStateFile();
  if (state && pidAlive(state.pid) && modelsMatch(state)) {
    const health = await waitReady(180000);
    if (health?.ready) return health;
    onInfo('[warn] local 常驻进程无响应,将重新拉起');
    await stopLocalResident();
  } else if (state && pidAlive(state.pid)) {
    onInfo('[info] local 常驻进程的模型与配置不一致,将重新拉起');
    await stopLocalResident();
  } else if (state) {
    try { fs.unlinkSync(STATE_PATH); } catch { /* 残留状态 */ }
  }
  if (!claimStart()) {
    onInfo('[info] 另一个预热正在拉起 local 常驻进程');
    return waitReady(180000);
  }
  try {
    const pid = startDetached();
    onInfo(`[info] 已分离 local 常驻进程(pid ${pid}),模型留在该进程供后续检索复用。日志 data/local-resident.log`);
    const health = await waitReady(180000, pid);
    if (!health?.ready) onInfo('[fail] local 常驻进程在时限内没有完成加载');
    return health;
  } finally {
    releaseStart();
  }
}

async function postJson(pathname, body, ms = 600000) {
  const state = readStateFile();
  if (!state?.port || !pidAlive(state.pid) || !modelsMatch(state)) return null;
  try {
    const resp = await fetch(`http://127.0.0.1:${state.port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch { return null; }
}

/** 常驻进程已加载且模型与配置一致时返回 /health,否则 null。 */
export async function residentHealth(ms = 800) {
  const state = readStateFile();
  if (!state?.port || !pidAlive(state.pid) || !modelsMatch(state)) return null;
  try {
    const health = await fetchHealth(state, ms);
    return health?.ready ? health : null;
  } catch { return null; }
}

/** 常驻进程可用时返回向量行,否则 null(调用方改在本进程加载)。 */
export async function residentEmbed(texts) {
  if (!Array.isArray(texts) || !texts.length) return null;
  const json = await postJson('/embed', { texts }, 120000);
  if (!Array.isArray(json?.embeddings) || json.embeddings.length !== texts.length) return null;
  return json.embeddings;
}

/** 常驻精排可用时返回与 pairs 等长的分数,否则 null。 */
export async function residentScorePairs(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const json = await postJson('/rerank', { pairs }, 120000);
  if (!Array.isArray(json?.scores) || json.scores.length !== pairs.length) return null;
  return json.scores;
}

if (directRun) {
  const cfg = loadConfig();
  const embeddingId = cfg.models.localEmbedding;
  const rerankerId = cfg.models.localReranker;
  let pipe = null;
  let reranker = null;
  let embedOk = false;
  let rerankOk = false;
  let ready = false;
  let idleTimer = null;

  function touchIdle() {
    if (!idleTimer) return;
    idleTimer.refresh();
  }

  const server = http.createServer(async (req, res) => {
    try {
      touchIdle();
      const url = req.url || '/';
      if (req.method === 'GET' && url === '/health') {
        send(res, 200, { ready, embedOk, rerankOk, embedding: embeddingId, reranker: rerankerId });
        return;
      }
      if (req.method === 'POST' && url === '/shutdown') {
        send(res, 200, { ok: true });
        server.close();
        process.exit(0);
      }
      if (!ready) {
        send(res, 503, { error: '模型仍在加载' });
        return;
      }
      if (req.method === 'POST' && url === '/embed') {
        if (!pipe) { send(res, 503, { error: '嵌入模型未就绪' }); return; }
        const body = await readBody(req);
        const texts = Array.isArray(body.texts) ? body.texts.map(t => String(t)) : null;
        if (!texts?.length || texts.length > 64) { send(res, 400, { error: 'texts 须为 1 到 64 条' }); return; }
        const out = await pipe(texts, { pooling: 'mean', normalize: true });
        send(res, 200, { embeddings: out.tolist() });
        return;
      }
      if (req.method === 'POST' && url === '/rerank') {
        if (!reranker) { send(res, 503, { error: '精排模型未就绪' }); return; }
        const body = await readBody(req);
        const pairs = Array.isArray(body.pairs) ? body.pairs : null;
        if (!pairs?.length || pairs.length > 64) { send(res, 400, { error: 'pairs 须为 1 到 64 条' }); return; }
        const scores = [];
        for (const pair of pairs) {
          try {
            scores.push(await scorePair(reranker.tokenizer, reranker.model, String(pair.query || ''), String(pair.doc || '')));
          } catch { scores.push(null); }
        }
        send(res, 200, { scores });
        return;
      }
      send(res, 404, { error: '未知路径' });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: e.message });
    }
  });

  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ pid: process.pid, port, embedding: embeddingId, reranker: rerankerId }));
    console.error(`[info] local 常驻进程监听 127.0.0.1:${port}`);
    try {
      pipe = await loadEmbedder(embeddingId);
      await pipe(['warm'], { pooling: 'mean', normalize: true });
      embedOk = true;
      console.error(`[ok] ${embeddingId} 已加载`);
    } catch (e) {
      console.error(`[fail] local 嵌入模型拉起失败(${e.message})`);
    }
    try {
      reranker = await loadLocalReranker(rerankerId);
      await scorePair(reranker.tokenizer, reranker.model, 'warm', 'warm');
      rerankOk = true;
      console.error(`[ok] ${rerankerId} 已加载`);
    } catch (e) {
      console.error(`[fail] local 精排模型拉起失败(${e.message})`);
    }
    if (!embedOk && !rerankOk) {
      console.error('[fail] 嵌入和精排都没拉起,常驻进程退出');
      try { fs.unlinkSync(STATE_PATH); } catch { /* 状态文件可能已被清掉 */ }
      process.exit(1);
    }
    ready = true;
    idleTimer = setTimeout(() => {
      console.error('[info] local 常驻进程空闲到期,退出');
      try { fs.unlinkSync(STATE_PATH); } catch { /* 同上 */ }
      process.exit(0);
    }, keepAliveMs(OLLAMA_KEEP_ALIVE));
    console.error('[done] local 常驻进程可接受检索与嵌入');
  });
}
