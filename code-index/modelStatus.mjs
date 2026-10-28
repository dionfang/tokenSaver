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
import { countTokens } from 'token-estimator';

const CHUNKS_PATH = path.join(DATA_DIR, 'chunks.jsonl');
const IDX_PATH = path.join(DATA_DIR, 'index.json');
const PIDFILE = path.join(DATA_DIR, '.embed.pid');
const SAVINGS_PATH = path.join(DATA_DIR, 'session-savings.json');
const TOKENS_PER_LINE = 8;

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

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function readSavingsState() {
  try {
    const j = JSON.parse(fs.readFileSync(SAVINGS_PATH, 'utf8'));
    const sameDay = Number.isFinite(j.updatedAt) && localDay(j.updatedAt) === localDay(Date.now());
    return sameDay && Number.isFinite(j.savedTokens) ? Math.max(0, Math.round(j.savedTokens)) : 0;
  } catch {
    return 0;
  }
}

function writeSavingsState(savedTokens) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SAVINGS_PATH, JSON.stringify({
    savedTokens: Math.max(0, Math.round(savedTokens)),
    updatedAt: Date.now(),
  }));
}

/** 按本机日期结算:每天 24:00 后从 0 重新累计。只含检索少读的输入侧。 */
export function readSessionSavings() {
  return readSavingsState();
}

export function addSessionSavings(tokens) {
  const n = Math.round(tokens);
  const saved = readSavingsState();
  if (!Number.isFinite(n) || n <= 0) return saved;
  try { writeSavingsState(saved + n); } catch { /* 记账失败不影响检索 */ }
  return saved + n;
}

function chunkBody(text) {
  const raw = String(text || '');
  const nl = raw.indexOf('\n');
  return nl >= 0 ? raw.slice(nl + 1) : raw;
}

/** 用命中块代替整文件阅读的粗算:按命中正文的 token 密度外推同文件未读行。只供状态句,同一文件只计一次。 */
export function estimateSavedTokens(kept, chunks, idx) {
  const fileLines = new Map((idx?.files || []).map(f => [f.p, Number(f.lines) || 0]));
  const byFile = new Map();
  for (const i of kept || []) {
    const c = chunks[i];
    if (!c?.p) continue;
    const span = Math.max(1, (Number(c.e) || 0) - (Number(c.s) || 0) + 1);
    const tokens = countTokens(chunkBody(c.t));
    const cur = byFile.get(c.p) || { span: 0, lines: fileLines.get(c.p) || 0, tokens: 0 };
    cur.span += span;
    cur.tokens += Number.isFinite(tokens) && tokens > 0 ? tokens : span * TOKENS_PER_LINE;
    byFile.set(c.p, cur);
  }
  let saved = 0;
  for (const v of byFile.values()) {
    const unread = Math.max(0, (v.lines > 0 ? v.lines : v.span) - v.span);
    saved += unread * (v.tokens / v.span);
  }
  return Math.round(saved);
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
  const reason = likelyReason(p, emb, rr);
  const hint = reason.includes('未拉起') ? '。请重启会话或者 agent 恢复 TokenSaver服务' : '';
  const relay = healthy
    ? `⚙ TokenSaver服务已启动成功。${names}。本次会话今日已节约了 ${formatTokenCount(p.savedTokens)} tokens`
    : `⚙ TokenSaver服务未启动成功。${names}。最可能原因:${reason}${hint}`;
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
    savedTokens: readSessionSavings(),
    models,
    modelIn,
    localEmbeddingReady: localOnnxCached(models.localEmbedding),
    localRerankerReady: localOnnxCached(models.localReranker),
  });
}
