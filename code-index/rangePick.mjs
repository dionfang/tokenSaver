/**
 * 单文件语义选段:read-guard 改写路径的"该读哪段"决策。
 * 意图向量由 prompt-guard 存进 data/read-guard/<session>.intent.json(每次用户输入嵌一次);
 * 候选块来自 data/chunks.jsonl,文档侧向量直接读 data/vectors/<backend>/embeddings.bin 现成行,
 * 不再做任何文档嵌入。余弦 top-N → 精排(qwen3-reranker yes/no 判定,与 search.mjs 同款)
 * → 相邻块合并 → 按政策封顶。模型/索引任一不可用都返回 null,调用方降级。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, OLLAMA_KEEP_ALIVE, HF_CACHE_DIR, loadConfig } from './config.mjs';
import { activeBackend, vectorPaths, readVectorMeta } from './vectorStore.mjs';
import { resolveBase, gpuOptions } from './ollamaGuard.mjs';
import { residentEmbed, residentScorePairs } from './localResident.mjs';
import { embedBusy } from './embedGate.mjs';

const CHUNKS_PATH = path.join(DATA_DIR, 'chunks.jsonl');
const INTENT_DIR = path.join(DATA_DIR, 'read-guard');
export const INTENT_TTL_MS = 30 * 60 * 1000;

/** 纯函数:从打分块里选连续区间。按分取前 topK,再按行号聚簇(相邻块间距 ≤ gap 同簇),
 *  取含最高分块的簇合并为区间;超过 maxLines 时锚定最高分块开窗。返回 {s,e,topScore} 或 null。 */
export function pickSpan(items, { topK = 3, gap = 40, maxLines = 625 } = {}) {
  const cand = (items || []).filter((c) => Number.isFinite(c.s) && Number.isFinite(c.e) && c.e >= c.s && c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (!cand.length) return null;
  const anchor = cand[0];
  // 聚簇:按行号排好序,间距 ≤ gap 并入同簇;远处的孤块不参与合并
  const clusters = [];
  for (const c of [...cand].sort((a, b) => a.s - b.s)) {
    const last = clusters[clusters.length - 1];
    if (last && c.s <= last.e + gap) {
      last.s = Math.min(last.s, c.s);
      last.e = Math.max(last.e, c.e);
      last.score = Math.max(last.score, c.score);
    } else {
      clusters.push({ s: c.s, e: c.e, score: c.score });
    }
  }
  const cluster = clusters.find((cl) => anchor.s >= cl.s && anchor.e <= cl.e) || clusters[0];
  let s = cluster.s;
  let e = cluster.e;
  if (e - s + 1 > maxLines) {
    // 超宽:锚定最高分块,向两侧摊预算(锚块自身可能超宽则截到 maxLines)
    const aS = Math.max(1, anchor.s);
    s = aS;
    e = Math.min(Math.max(aS, anchor.e), aS + maxLines - 1);
    let budget = maxLines - (e - s + 1);
    for (const c of cand) {
      if (budget <= 0) break;
      if (c.e < s || c.s > e) continue;
      if (c.s < s) { const need = s - c.s; s -= Math.min(need, budget); budget -= Math.min(need, budget); }
      if (c.e > e && budget > 0) { const need = c.e - e; e += Math.min(need, budget); budget -= Math.min(need, budget); }
    }
    if (e - s + 1 > maxLines) e = s + maxLines - 1;
  }
  return { s, e, topScore: anchor.score };
}

/** 纯函数:abs 文件路径与块路径 p(仓库名前缀的正斜杠相对路径)是否同一文件。
 *  逐段后缀匹配,避免依赖仓库根位置;p 段数更多的优先由调用方排序。 */
export function pathMatchesChunk(absFile, p) {
  if (!p) return false;
  const norm = String(absFile).replace(/\\/g, '/').toLowerCase();
  const rel = String(p).replace(/\\/g, '/').toLowerCase();
  return norm === rel || norm.endsWith('/' + rel);
}

/** 读会话意图(向量+原文)。找不到/过期返回 null。 */
export function loadIntent(sessionId, { now = Date.now(), dir = INTENT_DIR } = {}) {
  const candidates = [sessionId && `${String(sessionId).replace(/[^\w.-]/g, '_')}.intent.json`, '_global.intent.json'].filter(Boolean);
  for (const name of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (Array.isArray(j.v) && j.v.length && Number.isFinite(j.at) && now - j.at < INTENT_TTL_MS) {
        return { v: j.v, text: String(j.text || ''), at: j.at };
      }
    } catch { /* 下一个候选 */ }
  }
  return null;
}

/** 意图嵌入:local 走常驻进程;ollama 走 /api/embed(查询侧加 Instruct 前缀,同 search.mjs)。失败返回 null。 */
export async function embedIntent(text) {
  const q = String(text || '').slice(0, 1000);
  if (!q.trim()) return null;
  const backend = activeBackend();
  // 批量嵌入让行(2026-11-10):ollama 单队列,重嵌期间意图嵌入直接弃权(调用方沿用词法/余弦降级)
  if (backend === 'ollama' && embedBusy()) return null;
  try {
    if (backend === 'local') {
      const hosted = await residentEmbed([q]);
      return hosted ? hosted[0] : null;
    }
    const vmeta = readVectorMeta('ollama');
    if (!vmeta?.model) return null;
    const base = resolveBase();
    const resp = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: vmeta.model,
        input: [`Instruct: Given a search query, retrieve relevant code chunks from the codebase\nQuery: ${q}`],
        keep_alive: OLLAMA_KEEP_ALIVE,
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const v = (await resp.json()).embeddings?.[0];
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}

/** 向量重建专用嵌入(2026-11-10):常驻可用 → 走常驻;**不可用 → 进程内兜底**——
 *  兜底模型是本地 jina,**仅当目标模型就是本地 jina 时才允许**(wantModel 校验):
 *  否则会在"目标=ollama、常驻挂了"时产出 jina 向量冒充 ollama 库(实测 228 条 768 维污染事件)。
 *  与 embed.mjs 的 local 后端同参(dtype q8 / pooling mean / normalize / HF 缓存 + 镜像回退)。
 *  热路径 embedIntent 不加兜底——否则每轮 prompt 在常驻重启窗口都会白加载一次模型。 */
let _directPipe = null;
export async function embedIntentResilient(text, wantModel = null) {
  const hosted = await embedIntent(text);
  if (hosted) return hosted;
  const q = String(text || '').slice(0, 1000);
  if (!q.trim()) return null;
  const cfgL = (() => { try { return loadConfig(); } catch { return null; } })();
  const localModel = cfgL ? `local/${cfgL.models.localEmbedding}` : null;
  if (wantModel && localModel && wantModel !== localModel) return null; // 模型守卫:目标不是本地 jina → 拒绝兜底
  try {
    if (!_directPipe) {
      const { env, pipeline } = await (await import('./transformersLoader.mjs')).loadTransformers();
      env.cacheDir = HF_CACHE_DIR;
      env.allowLocalModels = true; // S4-F2(20261120 夜):与 2026-11-19 embed 修同口径统一——本地 cacheDir 命中优先,离线/受限网络不强制远端解析
      const modelId = cfgL ? cfgL.models.localEmbedding : 'Xenova/jina-embeddings-v2-base-zh';
      try { _directPipe = await pipeline('feature-extraction', modelId, { dtype: 'q8' }); }
      catch {
        env.remoteHost = 'https://hf-mirror.com';
        _directPipe = await pipeline('feature-extraction', modelId, { dtype: 'q8' });
      }
    }
    const out = await _directPipe([q], { pooling: 'mean', normalize: true });
    const row = out.tolist()[0];
    return Array.isArray(row) && row.length ? row : null;
  } catch { return null; }
}

/** 精排:qwen3-reranker 对(意图,块正文)做 yes/no 判定,与 search.mjs 同款提示。
 *  返回与 docs 等长的分数数组;失败返回 null(调用方沿用余弦序)。 */
export async function judgeIntentDocs(queryText, docs) {
  const backend = activeBackend();
  // 批量嵌入让行(2026-11-10):ollama 精排也走同一队列,重嵌期间降级为余弦序
  if (backend === 'ollama' && embedBusy()) return null;
  const judgePrompt = (q, doc) =>
    '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n' +
    `<|im_start|>user\n<Instruct>: Given a code search query, retrieve relevant code chunks from the codebase\n<Query>: ${q}\n<Document>: ${doc}<|im_end|>\n` +
    '<|im_start|>assistant\n<think>\n\n</think>\n\n';
  const verdict = (lps) => {
    const first = lps?.[0];
    if (!first) return null;
    const tok = String(first.token || '').trim().toLowerCase();
    if (tok === 'yes') return Math.exp(first.logprob);
    if (tok === 'no') return 1 - Math.exp(first.logprob);
    return null;
  };
  try {
    if (backend === 'local') {
      const hosted = await residentScorePairs(docs.map((d) => ({ query: queryText, doc: d.slice(0, 1600) })));
      return hosted ? hosted.map((s) => (s == null ? null : s)) : null;
    }
    const { loadConfig } = await import('./config.mjs');
    const rrModel = loadConfig().models.reranker;
    const base = resolveBase();
    const out = await Promise.all(docs.map(async (d) => {
      const resp = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: rrModel,
          prompt: judgePrompt(queryText, d.slice(0, 1600)),
          raw: true, stream: false, think: false,
          options: { num_predict: 1, temperature: 0, ...gpuOptions() },
          logprobs: true, keep_alive: OLLAMA_KEEP_ALIVE,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return null;
      return verdict((await resp.json()).logprobs);
    }));
    return out;
  } catch { return null; }
}

/**
 * 主入口:给 absFile 挑语义区间。chunks/vectors/意图任一缺失或全零分 → null。
 * 返回 {s,e,score,src}:src ∈ vec(余弦)/rerank(精排) 标明依据。
 */
export async function pickRangeForFile(absFile, sessionId, { maxLines = 625, cosTop = 8, minScore = 0.15 } = {}) {
  const intent = loadIntent(sessionId);
  if (!intent) return null;
  let chunks;
  try {
    chunks = fs.readFileSync(CHUNKS_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return null; }
  let mine = chunks.map((c, i) => ({ c, i })).filter(({ c }) => pathMatchesChunk(absFile, c.p));
  if (!mine.length) return null;

  const backend = activeBackend();
  const vmeta = readVectorMeta(backend);
  const embPath = vectorPaths(backend).emb;
  if (!vmeta?.dim || !fs.existsSync(embPath)) return null;
  const dim = Number(vmeta.dim);
  // S4-F3(20261122):intent 维度必须与库 dim 一致——后端切换 TTL 窗(1024 vs 768)长 intent 截断=半维点积静默错分;
  // 短 intent→NaN→null 本就安全,长 intent 是错位方向,统一按维度守卫拒
  if (!Array.isArray(intent.v) || intent.v.length !== dim) return null;
  let onSnapshot = false;
  if (Number(vmeta.chunks) !== chunks.length) {
    // S4-2(20261119)+S4-F1/F2(20261122):重嵌窗口回退嵌入时快照(与 search 同口径+同款覆盖度守卫)
    try {
      const paired = fs.readFileSync(vectorPaths(backend).paired, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const raw0 = fs.readFileSync(embPath);
      if (paired.length && paired.length * 2 >= chunks.length && Math.abs(raw0.byteLength - paired.length * vmeta.dim * 4) <= 4) {
        chunks = paired;
        // S4-F1:快照回退必须按快照重挑 mine——旧实现沿用当前块清单的 {c,i},当前文本×快照向量错位打分,新块 NaN 静默丢弃
        mine = chunks.map((c, i) => ({ c, i })).filter(({ c }) => pathMatchesChunk(absFile, c.p));
        if (!mine.length) return null;
        onSnapshot = true;
      } else return null;
    } catch { return null; }
  }
  const raw = fs.readFileSync(embPath);
  // 必须带 byteOffset:小文件读出的 Buffer 常落在共享内存池里,漏掉偏移会读到其他对象的数据
  if (raw.byteLength % 4 !== 0) return null;
  const buf = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const scored = mine.map(({ c, i }) => {
    let dot = 0;
    const off = i * dim;
    for (let d = 0; d < dim; d++) dot += intent.v[d] * buf[off + d];
    return { s: c.s, e: c.e, score: dot, body: String(c.t || ''), i };
  }).filter((x) => Number.isFinite(x.score));
  if (!scored.length) return null;
  // S4-F2:快照回退时行区间=嵌入时旧行号,按当前文件行数过滤越界段(防错位行写进 read-guard 区间改写)
  if (onSnapshot) {
    let lineCount = 0;
    try { lineCount = fs.readFileSync(absFile, 'utf8').split('\n').length; } catch { return null; }
    const inRange = scored.filter((x) => Number(x.s) >= 1 && Number(x.e) <= lineCount);
    if (!inRange.length) return null;
    scored.splice(0, scored.length, ...inRange);
  }

  const byCos = [...scored].sort((a, b) => b.score - a.score).slice(0, cosTop);
  if (byCos[0].score < minScore) return null; // 意图与文件不相关(可能只是想浏览),交回 deny
  let items = byCos.map((x) => ({ s: x.s, e: x.e, score: x.score }));
  let src = 'vec';
  const rr = await judgeIntentDocs(intent.text, byCos.map((x) => x.body));
  if (rr && rr.some((v) => v != null)) {
    const judged = byCos.map((x, n) => ({ s: x.s, e: x.e, score: rr[n] == null ? x.score * 0.5 : rr[n] }));
    items = judged;
    src = 'rerank';
  }
  const span = pickSpan(items, { maxLines });
  return span ? { ...span, src } : null;
}
