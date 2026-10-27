#!/usr/bin/env node
/**
 * 混合语义检索 CLI(BM25 词法 + 向量余弦 + 可选 qwen3-reranker 精排)
 *
 * 用法:
 *   node search.mjs 海报正文分页 二维码
 *   node search.mjs "lazy insert restaurant" --k 12
 *   node search.mjs 懒入库 --mode bm25          # 显式纯词法(不依赖模型)
 *   node search.mjs 奖章图标绘制 --rerank       # 先混合检索取前14,再本地 reranker 精排
 *   node search.mjs 限流 --json                 # 机器可读输出(供 agent 消费)
 *
 * 降级链(自动,带警告):嵌入路径在 init.mjs --model-in 选定,运行时不互为后备。
 *   ollama 路径:Ollama 不可用 → bm25。local 路径:优先用常驻进程,不在时本进程加载,不要求 Ollama,拉起失败 → bm25。
 *   精排跟随同一条路径:ollama 用 models.reranker,local 用 models.localReranker(同样优先常驻进程)。
 *   精排拉起失败则沿用第一阶段排序,不改换另一条路径。
 *   bm25 为纯 JS 词法统计(非模型),只要索引数据在就可用。
 * 精排:ollama 无原生 rerank 端点,采用 Qwen3-Reranker 官方判定模板 +
 *       /api/generate(logprobs) 取首 token yes/no 置信度:score = P(yes) 或 1-P(no)。
 *       ollama 精排只认 config.mjs 的 models.reranker(单次命令可用 --rr-model)。
 *       local 精排只认 models.localReranker(Xenova/bge-reranker-base,q8),优先打常驻进程,查询与代码块成对打分。
 *       精排分按 config.mjs 的 rerankBlend(默认 0.275)与一阶段分加权混合后排序,不做全量接管。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOllama, gpuOptions, resolveGpuMode, ensureModelPlacement, resolveBase } from './ollamaGuard.mjs';
import { loadConfig, DATA_DIR, HF_CACHE_DIR, OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX } from './config.mjs';
import { addSessionSavings, assessModelStatus, estimateSavedTokens, ollamaHasModel } from './modelStatus.mjs';
import { loadLocalReranker, scorePair } from './localRerank.mjs';
import { residentEmbed, residentScorePairs } from './localResident.mjs';
import { activeBackend, vectorPaths, readVectorMeta, vectorSignatureStale } from './vectorStore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--k', '--mode', '--rr-k', '--rr-model']);
const queryArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { if (VALUE_FLAGS.has(args[i])) i++; }
  else queryArgs.push(args[i]);
}
const flags = args.filter(a => a.startsWith('--'));
const query = queryArgs.join(' ');
const getOpt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const K = Number(getOpt('--k', 8));
const MODE = getOpt('--mode', 'hybrid'); // hybrid | vec | bm25
const RERANK = flags.includes('--rerank');
const RRK = Number(getOpt('--rr-k', 14));
const AS_JSON = flags.includes('--json');

if (!query) { console.error('用法: node search.mjs <查询词> [--k 8] [--mode hybrid|vec|bm25] [--json]'); process.exit(1); }

const chunksPath = path.join(DATA_DIR, 'chunks.jsonl');
if (!fs.existsSync(chunksPath)) {
  console.error('[err] 索引尚未建立(data/chunks.jsonl 不存在):请运行 node build.mjs 建立块清单(免模型),再运行 node embed.mjs 生成向量;或等待下次会话启动时 auto.mjs 自动构建');
  process.exit(1);
}
const chunks = fs.readFileSync(chunksPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// ---------- 分词:标识符拆分 + CJK 二元组 ----------
function tokenize(text) {
  const tokens = [];
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*|\d+/g)) {
    const w = m[0];
    tokens.push(w.toLowerCase());
    // camelCase / snake_case / kebab-case 拆出的子词也入索引
    for (const part of w.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_\-\s]+/)) {
      if (part && part !== w) tokens.push(part.toLowerCase());
    }
  }
  for (const m of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) tokens.push(run);
    else for (let i = 0; i < run.length - 1; i++) tokens.push(run[i] + run[i + 1]);
  }
  return tokens;
}

// ---------- BM25 ----------
const docTokens = chunks.map(c => tokenize(c.t));
const N = chunks.length;
const avgdl = docTokens.reduce((s, d) => s + d.length, 0) / N || 1;
const df = new Map();
docTokens.forEach(d => {
  const seen = new Set(d);
  for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
});
function bm25Score(qTokens, d) {
  const tf = new Map();
  for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
  let score = 0;
  const k1 = 1.2, b = 0.75;
  for (const qt of qTokens) {
    const f = tf.get(qt);
    if (!f) continue;
    const idf = Math.log(1 + (N - (df.get(qt) || 0) + 0.5) / ((df.get(qt) || 0) + 0.5));
    score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgdl));
  }
  return score;
}

const qTokens = tokenize(query);
let bm25 = chunks.map((c, i) => bm25Score(qTokens, docTokens[i]));
const bm25Max = Math.max(...bm25, 1e-9);
bm25 = bm25.map(s => s / bm25Max);

// ---------- 向量 ----------
// 只读当前 modelIn 的 data/vectors/<路径>/。另一条路径的向量不参与,也不被本次检索改写。
// ollama:必须已有 Ollama 服务。local:优先常驻进程,不在时本进程加载,不探测 Ollama。
// 当前路径拉起失败 → bm25,不改换另一条路径。精排跟随 modelIn。
let idx = {};
try { idx = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8')); }
catch { console.error('[warn] index.json 缺失或损坏,向量通道不可用(运行 node build.mjs && node embed.mjs 重建)'); }
const indexBackend = activeBackend();
const vmeta = readVectorMeta(indexBackend);
const embPath = vectorPaths(indexBackend).emb;

let ollamaUp = false;
const wantVector = MODE !== 'bm25';
const useLocalRerank = loadConfig().modelIn === 'local';
const vectorNeedsOllama = wantVector && indexBackend === 'ollama' && !!vmeta;
const rerankNeedsOllama = RERANK && !useLocalRerank;
if (vectorNeedsOllama || rerankNeedsOllama) {
  const g = await ensureOllama({ onInfo: m => console.error(m) });
  ollamaUp = g.up;
  if (!g.up && vectorNeedsOllama) console.error(`[warn] Ollama 服务不可用(${g.base}),向量检索降级 bm25`);
  else if (!g.up && rerankNeedsOllama) console.error(`[warn] Ollama 服务不可用(${g.base}),精排跳过`);
  else if (g.up) {
    console.error(`[gpu] ${resolveGpuMode().reason}`);
    const cfgModels = loadConfig().models;
    const place = [];
    if (vectorNeedsOllama) place.push(cfgModels.embedding);
    if (rerankNeedsOllama) place.push(cfgModels.reranker);
    await ensureModelPlacement(place, console.error);
  }
}

let vecScores = null;
const canVector = wantVector && vmeta && fs.existsSync(embPath)
  && (vmeta.backend === 'local' || vmeta.backend === 'ollama')
  && (indexBackend === 'local' || (indexBackend === 'ollama' && ollamaUp));
if (canVector) {
  try {
    // 指纹校验:块清单已变而当前路径向量未重生成时,拒绝使用过期向量
    if (vectorSignatureStale(vmeta)) {
      throw new Error('向量与块清单不一致(代码已变更未重嵌入),请运行 node embed.mjs');
    }
    let q = null;
    const be = vmeta.backend || indexBackend;
    if (be === 'local') {
      const hosted = await residentEmbed([query]);
      if (hosted) {
        q = hosted[0];
      } else {
        const { env, pipeline } = await import('@huggingface/transformers');
        env.cacheDir = HF_CACHE_DIR;
        env.allowLocalModels = false;
        let pipe;
        try {
          pipe = await pipeline('feature-extraction', vmeta.model, { dtype: 'q8' });
        } catch (e) {
          console.error(`[warn] HuggingFace 下载失败(${e.message}),切换 hf-mirror.com 重试...`);
          env.remoteHost = 'https://hf-mirror.com';
          pipe = await pipeline('feature-extraction', vmeta.model, { dtype: 'q8' });
        }
        // 常驻进程不在时才在本进程加载。jina 不需要输入前缀,也不访问 Ollama
        q = (await pipe([query], { pooling: 'mean', normalize: true })).tolist()[0];
      }
    } else if (be === 'ollama') {
      // qwen3-embedding 检索场景官方格式:查询侧加 Instruct 前缀,文档侧为原文
      const base = resolveBase();
      const resp = await fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: vmeta.model,
          input: [`Instruct: Given a search query, retrieve relevant code chunks from the codebase\nQuery: ${query}`],
          options: { num_ctx: OLLAMA_NUM_CTX, ...gpuOptions() },
          keep_alive: OLLAMA_KEEP_ALIVE,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      q = (await resp.json()).embeddings[0];
    } else {
      throw new Error(`索引后端 ${be} 已不再使用,请按 modelIn 重跑 node embed.mjs`);
    }
    if (!q) throw new Error('查询向量生成失败');
    const file = fs.readFileSync(embPath);
    const buf = new Float32Array(file.buffer, file.byteOffset, file.byteLength / 4);
    const dim = vmeta.dim;
    vecScores = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let dot = 0;
      const off = i * dim;
      for (let d = 0; d < dim; d++) dot += q[d] * buf[off + d];
      vecScores[i] = dot; // jina 与 qwen3-embedding 输出均已归一化,点积即余弦
    }
  } catch (e) {
    console.error(`[warn] 向量检索不可用(${e.message}),降级 bm25`);
  }
} else if (wantVector && vmeta && vmeta.backend !== 'local' && vmeta.backend !== 'ollama') {
  console.error(`[warn] 索引后端 ${vmeta.backend} 已不再使用,降级 bm25。请按 modelIn 重跑 node embed.mjs`);
} else if (wantVector && !(indexBackend === 'ollama' && vmeta && !ollamaUp)) {
  console.error('[warn] 当前路径的向量索引缺失,降级 bm25(只重建该路径: node embed.mjs)');
}

// ---------- 混合打分 + 去重叠 ----------
let scores;
if (MODE === 'bm25' || !vecScores) scores = bm25;
else if (MODE === 'vec') scores = vecScores;
else scores = chunks.map((_, i) => 0.6 * vecScores[i] + 0.4 * bm25[i]);

const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]);
function rangesOverlap(a, b) {
  return a.s <= b.e && b.s <= a.e;
}
const deduped = [];
for (const i of order) {
  const c = chunks[i];
  const dup = deduped.some(j => chunks[j].p === c.p && rangesOverlap(chunks[j], c));
  if (!dup && scores[i] > 0) deduped.push(i);
}

// ---------- 可选精排(qwen3-reranker via Ollama) ----------
let rrScores = null;
if (RERANK) rrScores = await rerankCandidates(query, deduped.slice(0, Math.max(K, RRK)), scores, chunks);
if (rrScores) {
  // 精排分只按 rerankBlend 小幅纠偏,不做全量接管:实测精排直接重排会把一阶段的好序翻坏,
  // 降权混合后 fileR5/MRR 同时为正收益(2026-10-27 固定池评测,scripts/data/exp-2026-10-26/rerank-bench)
  const w = loadConfig().rerankBlend;
  for (const [i, v] of rrScores) rrScores.set(i, w * v + (1 - w) * scores[i]);
}

let kept = deduped.slice(0, K);
if (rrScores) {
  kept = [...rrScores.keys()].sort((a, b) => rrScores.get(b) - rrScores.get(a)).slice(0, K);
}

async function rerankLocal(query, pool, firstStage, chunks) {
  const rrModel = loadConfig().models.localReranker;
  try {
    const hosted = await residentScorePairs(pool.map(i => ({ query, doc: chunks[i].t.slice(0, 1600) })));
    if (hosted) {
      const results = new Map();
      let failedCount = 0;
      pool.forEach((i, n) => {
        if (hosted[n] == null) { results.set(i, firstStage[i] * 0.5); failedCount++; }
        else results.set(i, hosted[n]);
      });
      process.stderr.write(`  模型:${rrModel}(常驻)${failedCount ? `(失败${failedCount}已回退)` : ''}\n`);
      return results;
    }
    const { tokenizer, model } = await loadLocalReranker(rrModel);
    const results = new Map();
    let failedCount = 0;
    for (let n = 0; n < pool.length; n++) {
      const i = pool[n];
      try {
        results.set(i, await scorePair(tokenizer, model, query, chunks[i].t.slice(0, 1600)));
      } catch {
        results.set(i, firstStage[i] * 0.5);
        failedCount++;
      }
      process.stderr.write(`\r[rerank] ${n + 1}/${pool.length}`);
    }
    process.stderr.write(`  模型:${rrModel}${failedCount ? `(失败${failedCount}已回退)` : ''}\n`);
    return results;
  } catch (e) {
    console.error(`\n[warn] 精排不可用(${e.message}),沿用第一阶段排序`);
    return null;
  }
}

async function rerankCandidates(query, pool, firstStage, chunks) {
  if (loadConfig().modelIn === 'local') return rerankLocal(query, pool, firstStage, chunks);
  if (!ollamaUp) return null;
  const base = resolveBase();
  try {
    // 固定模型,不做其他 reranker 的探测/回退;名字只来自 config.mjs
    const rrModel = getOpt('--rr-model', null) || loadConfig().models.reranker;
    const tags = await (await fetch(`${base}/api/tags`)).json();
    if (!ollamaHasModel(tags, rrModel)) {
      throw new Error(`未安装 ${rrModel},请先运行: ollama pull ${rrModel}`);
    }

    const judge = (q, doc) =>
      '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n' +
      `<|im_start|>user\n<Instruct>: Given a code search query, retrieve relevant code chunks from the codebase\n<Query>: ${q}\n<Document>: ${doc}<|im_end|>\n` +
      '<|im_start|>assistant\n<think>\n\n</think>\n\n';

    // 首 token 为判定:yes → P(yes);no → 1-P(no);其他 → 无法判定,退回半权第一阶段分
    const verdict = (lps) => {
      const first = lps?.[0];
      if (!first) return null;
      const tok = first.token.trim().toLowerCase();
      if (tok === 'yes') return Math.exp(first.logprob);
      if (tok === 'no') return 1 - Math.exp(first.logprob);
      return null;
    };

    const results = new Map();
    const queue = [...pool];
    let done = 0;
    let failedCount = 0;
    async function worker() {
      while (queue.length) {
        const i = queue.shift();
        try {
          const resp = await fetch(`${base}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: rrModel,
              prompt: judge(query, chunks[i].t.slice(0, 1600)),
              raw: true, stream: false, think: false,
              options: { num_predict: 1, temperature: 0, ...gpuOptions() },
              logprobs: true, keep_alive: OLLAMA_KEEP_ALIVE,
            }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const v = verdict((await resp.json()).logprobs);
          // 首 token 非 yes/no 的个别块回退半权一阶段分
          results.set(i, v == null ? firstStage[i] * 0.5 : v);
        } catch { results.set(i, firstStage[i] * 0.5); failedCount++; }
        done++;
        process.stderr.write(`\r[rerank] ${done}/${pool.length}`);
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    process.stderr.write(`  模型:${rrModel}${failedCount ? `(失败${failedCount}已回退)` : ''}\n`);
    return results;
  } catch (e) {
    console.error(`\n[warn] 精排不可用(${e.message}),沿用第一阶段排序`);
    return null;
  }
}

// ---------- 输出 ----------
function snippet(c) {
  const body = c.t.split('\n').slice(1);
  const lower = query.toLowerCase();
  const hit = lower.split(/\s+/).filter(Boolean);
  let at = body.findIndex(ln => hit.some(h => ln.toLowerCase().includes(h)));
  if (at < 0) at = body.findIndex(ln => ln.trim() !== '');
  const from = Math.max(at - 1, 0);
  return body.slice(from, from + 3).map(ln => ln.trim().slice(0, 180)).filter(Boolean).join('\n    ');
}

let toolOutput = '';
if (AS_JSON) {
  toolOutput = JSON.stringify(kept.map(i => ({
    score: Number((rrScores ? rrScores.get(i) : scores[i]).toFixed(4)),
    ...(rrScores ? { firstStage: Number(scores[i].toFixed(4)) } : {}),
    file: chunks[i].p,
    lines: [chunks[i].s, chunks[i].e],
    symbol: chunks[i].y || '',
  })), null, 1);
} else {
  const modeUsed = (MODE === 'bm25' || !vecScores) ? 'bm25' : MODE;
  const lines = [`# 查询: ${query}  (模式:${modeUsed}${rrScores ? '+rerank' : ''}, 命中 ${kept.length}/${chunks.length} 块)`];
  kept.forEach((i, r) => {
    const c = chunks[i];
    const sc = rrScores ? `混排 ${rrScores.get(i).toFixed(3)} | 一段 ${scores[i].toFixed(3)}` : scores[i].toFixed(3);
    lines.push('', `${r + 1}. [${sc}] ${c.p}:${c.s}-${c.e}${c.y ? `  (${c.y})` : ''}`, `    ${snippet(c)}`);
  });
  toolOutput = lines.join('\n');
}

if (vecScores && kept.length) addSessionSavings(estimateSavedTokens(kept, chunks, idx));

if (AS_JSON) console.log(toolOutput);
else {
  const { relay } = await assessModelStatus();
  console.log(`${toolOutput}\n\n${relay}`);
}
