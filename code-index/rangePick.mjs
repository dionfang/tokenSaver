/**
 * 单文件语义选段:read-guard 改写路径的"该读哪段"决策。
 * 意图向量由 prompt-guard 存进 data/read-guard/<session>.intent.json(每次用户输入嵌一次);
 * 候选块来自 data/chunks.jsonl,文档侧向量直接读 data/vectors/<backend>/embeddings.bin 现成行,
 * 不再做任何文档嵌入。余弦 top-N → 精排(qwen3-reranker yes/no 判定,与 search.mjs 同款)
 * → 相邻块合并 → 按政策封顶。模型/索引任一不可用都返回 null,调用方降级。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, OLLAMA_KEEP_ALIVE } from './config.mjs';
import { activeBackend, vectorPaths, readVectorMeta } from './vectorStore.mjs';
import { resolveBase, gpuOptions } from './ollamaGuard.mjs';
import { residentEmbed, residentScorePairs } from './localResident.mjs';

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

/** 精排:qwen3-reranker 对(意图,块正文)做 yes/no 判定,与 search.mjs 同款提示。
 *  返回与 docs 等长的分数数组;失败返回 null(调用方沿用余弦序)。 */
export async function judgeIntentDocs(queryText, docs) {
  const backend = activeBackend();
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
  const mine = chunks.map((c, i) => ({ c, i })).filter(({ c }) => pathMatchesChunk(absFile, c.p));
  if (!mine.length) return null;

  const backend = activeBackend();
  const vmeta = readVectorMeta(backend);
  const embPath = vectorPaths(backend).emb;
  if (!vmeta?.dim || !fs.existsSync(embPath)) return null;
  if (Number(vmeta.chunks) !== chunks.length) return null; // 块清单与向量不配对,宁可不算
  const buf = new Float32Array(fs.readFileSync(embPath).buffer, 0, fs.statSync(embPath).size / 4);
  const dim = vmeta.dim;
  const scored = mine.map(({ c, i }) => {
    let dot = 0;
    const off = i * dim;
    for (let d = 0; d < dim; d++) dot += intent.v[d] * buf[off + d];
    return { s: c.s, e: c.e, score: dot, body: String(c.t || ''), i };
  }).filter((x) => Number.isFinite(x.score));
  if (!scored.length) return null;

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
