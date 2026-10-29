/**
 * 本地模型部署状态(status.mjs 现场判定,auto.mjs 写入会话注入)。
 * 只探测:不拉起 Ollama、不 pull、不建索引。
 * 「运行正常」:modelIn=ollama 时要 Ollama 在听、两个 Ollama 模型已下载且正在驻留(/api/ps)、
 * 索引后端与模型名一致,且向量签名与当前块清单一致。已下载但 ollama ps 里没有,不算启动成功。本模块不拉起模型。
 * modelIn=local 时当前路径的向量须是 jina,权重在 hf-cache,且常驻进程里的嵌入和精排都已拉起;local 不探测 Ollama。
 * 向量只认 data/vectors/<当前路径>/,不看另一条路径。两条路径都还要求块清单在、签名未过期、没有进行中的嵌入进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig } from './config.mjs';
import { ollamaProcessesRunning, resolveBase } from './ollamaGuard.mjs';
import { localOnnxCached } from './localRerank.mjs';
import { activeBackend, vectorPaths, readVectorMeta, vectorSignatureStale } from './vectorStore.mjs';
import { residentHealth } from './localResident.mjs';
import { pidAlive, LOCK_TTL_MS } from './proc.mjs';
import { loadTokenizer, lookupModel } from 'tokenizer-core';

const CHUNKS_PATH = path.join(DATA_DIR, 'chunks.jsonl');
const IDX_PATH = path.join(DATA_DIR, 'index.json');
const PIDFILE = path.join(DATA_DIR, '.embed.pid');
const SAVINGS_PATH = path.join(DATA_DIR, 'session-savings.json');
const TOKEN_CACHE = path.join(DATA_DIR, 'tokenizers');
const TOKEN_MODEL = 'qwen'; // exact,与本仓库 Qwen 嵌入/精排同一族

function fileReady(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

function readEmbedPid() {
  try {
    const prev = JSON.parse(fs.readFileSync(PIDFILE, 'utf8'));
    if (pidAlive(prev.pid) && Number.isFinite(prev.ts) && Date.now() - prev.ts < LOCK_TTL_MS) return prev.pid;
  } catch { /* 无 pidfile */ }
  return null;
}

function getJson(url, ms) {
  return Promise.race([
    (async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function zeroBucket() {
  return { originalTokens: 0, compressedTokens: 0, savedTokens: 0, readInputTokens: 0 };
}

function bucketOf(raw) {
  const originalTokens = Math.max(0, Math.round(Number(raw?.originalTokens) || 0));
  const compressedTokens = Math.max(0, Math.round(Number(raw?.compressedTokens) || 0));
  const savedTokens = Math.max(0, Math.round(Number(raw?.savedTokens) || 0));
  // Read/Bash 工具结果实际进入上下文的量(信息字段),独立于节约三件套
  const readInputTokens = Math.max(0, Math.round(Number(raw?.readInputTokens) || 0));
  return { originalTokens, compressedTokens, savedTokens, readInputTokens };
}

/** 旧的平铺账(含 basisSaved)收成按日记录。没有原文分母的纯估算不带入。 */
export function normalizeSavings(j, now = Date.now()) {
  const updatedAt = Number.isFinite(j?.updatedAt) ? j.updatedAt : now;
  if (j?.days && typeof j.days === 'object' && !Array.isArray(j.days)) {
    const days = {};
    for (const [k, v] of Object.entries(j.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      days[k] = bucketOf(v);
    }
    return { updatedAt, days };
  }
  const originalTokens = Math.max(0, Math.round(Number(j?.originalTokens) || 0));
  const basis = Math.max(0, Math.round(Number(j?.basisSaved) || 0));
  let savedTokens = Math.max(0, Math.round(Number(j?.savedTokens) || 0));
  if (basis) savedTokens = Math.max(0, savedTokens - basis);
  else if (!(originalTokens > 0)) savedTokens = 0;
  const compressedTokens = Number.isFinite(Number(j?.compressedTokens))
    ? Math.max(0, Math.round(Number(j.compressedTokens)))
    : Math.max(0, originalTokens - savedTokens);
  if (!(originalTokens > 0) && !(compressedTokens > 0)) return { updatedAt, days: {} };
  return {
    updatedAt,
    days: {
      [dayKey(updatedAt)]: {
        originalTokens,
        compressedTokens,
        savedTokens: Math.max(0, originalTokens - compressedTokens),
      },
    },
  };
}

function readDoc() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(SAVINGS_PATH, 'utf8')); } catch { /* 尚无账 */ }
  const doc = normalizeSavings(j || {}, Date.now());
  if (j && !j.days) {
    try { writeDoc(doc); } catch { /* 迁移失败不影响读取 */ }
  }
  return doc;
}

function writeDoc(doc) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const days = {};
  for (const k of Object.keys(doc.days || {}).sort()) days[k] = bucketOf(doc.days[k]);
  fs.writeFileSync(SAVINGS_PATH, JSON.stringify({ updatedAt: Date.now(), days }));
}

function readSavingsState() {
  const doc = readDoc();
  const date = dayKey(Date.now());
  return { ...(doc.days[date] || zeroBucket()), date, days: doc.days };
}

/** 今天的节约。过了本机 24:00 显示 0,以往日期仍留在文件里。 */
export function readSessionSavings() {
  return readSavingsState().savedTokens;
}

/** 一次请求:原文 token、压缩后 token。节约 = 原文 − 压缩后。 */
export function savingsFromCounts(originalTokens, compressedTokens) {
  const original = Math.max(0, Math.round(Number(originalTokens) || 0));
  const compressed = Math.max(0, Math.round(Number(compressedTokens) || 0));
  const saved = Math.max(0, original - compressed);
  return { original, compressed, saved, percent: original > 0 ? saved / original : 0 };
}

/** 累加进 state.date 那一天,其它日期不动。原文为 0 则原样返回。savedTokens 由当天两个累计相减。 */
export function accumulateSavings(state, originalTokens, compressedTokens) {
  const counted = savingsFromCounts(originalTokens, compressedTokens);
  if (counted.original <= 0) return state;
  const date = state.date || dayKey(Date.now());
  const days = { ...(state.days || {}) };
  const bucket = {
    originalTokens: (state.originalTokens || 0) + counted.original,
    compressedTokens: (state.compressedTokens || 0) + counted.compressed,
    savedTokens: 0,
    // 信息字段必须透传,否则一次搜索/拦截记账会把当日 readInputTokens 清零
    readInputTokens: state.readInputTokens || 0,
  };
  bucket.savedTokens = Math.max(0, bucket.originalTokens - bucket.compressedTokens);
  days[date] = bucket;
  return { ...bucket, date, days };
}

export function addInputSavings(originalTokens, compressedTokens) {
  const state = readSavingsState();
  const next = accumulateSavings(state, originalTokens, compressedTokens);
  if (next === state) return state.savedTokens;
  try { writeDoc(next); } catch { /* 记账失败不影响检索 */ }
  return next.savedTokens;
}

/** 工具结果实际进入上下文的量(Read/Bash,bytes/4 折算)。信息字段,不影响 savedTokens。 */
export function addReadInputTokens(tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n <= 0) return;
  const state = readSavingsState();
  const date = state.date || dayKey(Date.now());
  const days = { ...(state.days || {}) };
  const bucket = bucketOf(days[date]);
  bucket.readInputTokens += n;
  days[date] = bucket;
  try { writeDoc({ updatedAt: Date.now(), days }); } catch { /* 记账失败不影响调用方 */ }
}

/** 当日实际读入的 token(信息口径)。 */
export function readDayReadInputTokens() {
  return readSavingsState().readInputTokens || 0;
}

let encodePromise = null;
async function cacheTokenizer(model) {
  const entry = lookupModel(model);
  if (!entry || entry.source !== 'hf') return;
  const tokPath = path.join(TOKEN_CACHE, `${model}.json`);
  const cfgPath = path.join(TOKEN_CACHE, `${model}.config.json`);
  const files = [['tokenizer.json', tokPath], ['tokenizer_config.json', cfgPath]];
  fs.mkdirSync(TOKEN_CACHE, { recursive: true });
  for (const [name, dest] of files) {
    if (fileReady(dest)) continue;
    let err;
    for (const host of ['https://huggingface.co', 'https://hf-mirror.com']) {
      try {
        const res = await fetch(`${host}/${entry.repo}/resolve/${entry.sha}/${name}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        JSON.parse(text);
        fs.writeFileSync(dest, text);
        err = null;
        break;
      } catch (e) { err = e; }
    }
    if (!fileReady(dest)) throw err;
  }
}
function encoder() {
  if (!encodePromise) {
    encodePromise = cacheTokenizer(TOKEN_MODEL).then(() => loadTokenizer(TOKEN_MODEL, TOKEN_CACHE)).then((tok) => {
      if (!tok) throw new Error(`无法加载 ${TOKEN_MODEL} tokenizer`);
      return (text) => (text ? tok.encode(text).ids.length : 0);
    }).catch((err) => { encodePromise = null; throw err; });
  }
  return encodePromise;
}

/** 先计原文 token,再计压缩后 token,差额并入当日累计。 */
export async function measureInputSavings(originalText, compressedText) {
  const original = String(originalText || '');
  const compressed = String(compressedText || '');
  if (!original) return readSessionSavings();
  const count = await encoder();
  return addInputSavings(count(original), count(compressed));
}

export function formatSavedClause(state) {
  const saved = Math.max(0, Math.round(state?.savedTokens || 0));
  const original = Math.max(0, Math.round(state?.originalTokens || 0));
  const compressed = Math.max(0, Math.round(state?.compressedTokens || 0));
  const tokens = formatTokenCount(saved);
  if (original <= 0) return `${tokens} tokens`;
  const pct = Math.min(100, Math.max(0, (original - compressed) / original * 100));
  const text = (Math.round(pct * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return `${tokens} tokens(压缩率 ${text}%)`;
}

function formatTokenCount(n) {
  const v = Math.max(0, Math.round(n || 0));
  if (v < 10000) return String(v);
  const wan = v / 10000;
  const text = wan >= 10 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, '');
  return `${text} 万`;
}

function likelyReason(p, emb, rr) {
  if (p.modelIn === 'local') {
    if (p.embedPid && !p.indexOk) return '向量索引正在建立';
    if (!p.chunks) return '代码块清单未建立';
    if (p.indexError) return 'index.json 无法解析';
    if (!p.indexOk) return 'local 向量索引未建立,检索降级 bm25';
    if (p.backend !== 'local' || p.indexModel !== p.models.localEmbedding) return `索引仍是 ${p.indexModel || p.backend || '旧路径'},尚未切换到 local`;
    if (p.signatureStale && p.embedPid) return '代码块已变更,向量正在重嵌';
    if (p.signatureStale) return '代码块已变更,向量尚未重嵌';
    if (!p.localEmbeddingReady) return `嵌入模型 ${p.models.localEmbedding} 的权重不在 hf-cache`;
    if (!p.localRerankerReady) return `精排模型 ${p.models.localReranker} 的权重不在 hf-cache`;
    if (p.embedPid) return '嵌入进程仍在运行,索引可能不是最新';
    if (!p.residentReady) return 'local 常驻进程未拉起';
    return 'local 嵌入模型未就绪';
  }
  if (p.ollama === 'down') return 'Ollama 未启动';
  if (p.ollama === 'process-only') return `Ollama 没有在 ${p.base} 响应`;
  if (p.embedPid && !p.indexOk) return '向量索引正在建立';
  if (p.embedInstalled === null || p.rerankInstalled === null) return 'Ollama 未响应,无法确认模型是否已下载';
  if (p.embedInstalled === false) return `嵌入模型 ${emb} 未下载`;
  if (p.rerankInstalled === false) return `精排模型 ${rr} 未下载`;
  if (!p.chunks) return '代码块清单未建立';
  if (p.indexError) return 'index.json 无法解析';
  if (!p.indexOk) return '向量索引未建立';
  if (p.backend === 'local') return `当前索引是 ${p.indexModel},与配置的 ollama 嵌入路径不一致`;
  if (p.indexModel !== emb) return `索引模型 ${p.indexModel} 与配置的嵌入模型不一致`;
  if (p.signatureStale && p.embedPid) return '代码块已变更,向量正在重嵌';
  if (p.signatureStale) return '代码块已变更,向量尚未重嵌';
  if (p.embedPid) return '嵌入进程仍在运行,索引可能不是最新';
  if (p.embedRunning == null || p.rerankRunning == null) return '无法确认模型是否已拉起';
  if (!p.embedRunning && !p.rerankRunning) return `嵌入模型 ${emb} 与精排模型 ${rr} 都未拉起`;
  if (!p.embedRunning) return `嵌入模型 ${emb} 未拉起`;
  if (!p.rerankRunning) return `精排模型 ${rr} 未拉起`;
  return '模型未就绪';
}

function installedSet(tags) {
  const set = new Set();
  for (const m of tags?.models || []) {
    if (m?.name) set.add(m.name);
    if (m?.model) set.add(m.model);
  }
  return set;
}

/** 全名命中,或双方只差未写标签 / :latest。别的标签不算同一个模型。 */
function modelListed(set, wanted) {
  if (set.has(wanted)) return true;
  const colon = wanted.lastIndexOf(':');
  const bare = colon > 0 ? wanted.slice(0, colon) : wanted;
  return set.has(bare) || set.has(`${bare}:latest`);
}

/** /api/tags 或 /api/ps 的模型列表里是否有 wanted(含未写标签与 :latest)。 */
export function ollamaHasModel(tags, wanted) {
  return modelListed(installedSet(tags), wanted);
}

/** 对外只留一句:是否启动成功、两个模型名、失败原因或本会话大约省下的 tokens。 */
export function renderModelStatus(p) {
  const wantLocal = p.modelIn === 'local';
  const emb = wantLocal ? p.models.localEmbedding : p.models.embedding;
  const rr = wantLocal ? p.models.localReranker : p.models.reranker;
  const names = `嵌入模型 ${emb},精排模型 ${rr}`;
  const healthy = wantLocal
    ? (p.chunks && p.indexOk && p.backend === 'local' && p.indexModel === p.models.localEmbedding && p.localEmbeddingReady && p.localRerankerReady && p.residentReady && !p.signatureStale && !p.embedPid && !p.indexError)
    : (p.ollama === 'up'
      && p.embedInstalled === true
      && p.rerankInstalled === true
      && p.chunks && p.indexOk
      && p.backend !== 'local'
      && p.indexModel === emb
      && !p.signatureStale
      && p.embedRunning === true
      && p.rerankRunning === true
      && !p.embedPid
      && !p.indexError);
  const relay = healthy
    ? `⚙ 本地模型已启动成功。${names}。TokenSaver今日已经帮你在输入端节约 ${formatSavedClause(p)}`
    : `⚙ 本地模型未启动成功。${names}。最可能原因:${likelyReason(p, emb, rr)}`;
  return { relay, detail: relay, healthy };
}

export async function assessModelStatus() {
  const models = loadConfig().models;
  const modelIn = activeBackend();
  const base = resolveBase();
  let ollama = 'down';
  let embedInstalled = null;
  let rerankInstalled = null;
  let embedRunning = null;
  let rerankRunning = null;
  let residentReady = false;
  if (modelIn === 'local') {
    const health = await residentHealth();
    residentReady = !!(health?.embedOk && health?.rerankOk);
  } else {
    const [tagsRes, versionUp, psRes] = await Promise.all([
      getJson(`${base}/api/tags`, 2000).then(j => ({ ok: true, j })).catch(() => ({ ok: false })),
      getJson(`${base}/api/version`, 2000).then(() => true).catch(() => false),
      getJson(`${base}/api/ps`, 2000).then(j => ({ ok: true, j })).catch(() => ({ ok: false })),
    ]);
    if (tagsRes.ok || versionUp) ollama = 'up';
    else if (ollamaProcessesRunning()) ollama = 'process-only';
    if (tagsRes.ok) {
      const names = installedSet(tagsRes.j);
      embedInstalled = modelListed(names, models.embedding);
      rerankInstalled = modelListed(names, models.reranker);
    }
    if (psRes.ok) {
      const running = installedSet(psRes.j);
      embedRunning = modelListed(running, models.embedding);
      rerankRunning = modelListed(running, models.reranker);
    }
  }

  const meta = readVectorMeta(modelIn);
  let indexError = null;
  if (fileReady(IDX_PATH)) {
    try { JSON.parse(fs.readFileSync(IDX_PATH, 'utf8')); }
    catch (e) { indexError = e.message; }
  }
  const embeddings = fileReady(vectorPaths(modelIn).emb);
  return renderModelStatus({
    ollama,
    base,
    embedInstalled,
    rerankInstalled,
    embedRunning,
    rerankRunning,
    chunks: fileReady(CHUNKS_PATH),
    indexOk: !!(embeddings && meta?.model) && !indexError,
    indexError,
    indexModel: meta?.model || null,
    backend: meta?.backend || null,
    signatureStale: vectorSignatureStale(meta),
    residentReady,
    embedPid: readEmbedPid(),
    ...readSavingsState(),
    models,
    modelIn,
    localEmbeddingReady: localOnnxCached(models.localEmbedding),
    localRerankerReady: localOnnxCached(models.localReranker),
  });
}
