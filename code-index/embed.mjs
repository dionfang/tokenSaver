#!/usr/bin/env node
/**
 * 向量生成器(增量嵌入):只为新增/变更的块调用模型,未变化的块复用既有向量。
 *
 * 复用机制:vectors/<路径>/chunks.paired.jsonl 快照记录"与该目录 embeddings.bin 逐位置配对"的块文本,
 *           以 md5(块文本) 为键复用;块序变化只重排向量、不触发推理。
 *           HEAD 变更或当前路径模型变更时只嵌入差量块。
 *
 * 后端只认 init.mjs --model-in 写入的 modelIn,未配置则为 local。不接受命令行切换路径。
 *   ollama —— 本地 Ollama,qwen3-embedding:0.6b(1024维)
 *   local  —— transformers.js jina-embeddings-v2-base-zh(768维)。优先打常驻进程,不在时本进程加载,不依赖 Ollama
 * 模型名只认 config.mjs,不接受命令行热切换。换路径只走 init.mjs --model-in。
 * ollama 与 local 的向量分目录存放(data/vectors/ollama|local),切换时只增量更新当前目录。
 * 所选路径拉起失败则本进程退出,检索降级 bm25,不自动改换另一条路径。
 *
 * 用法: node embed.mjs [--batch 8] [--pace 500] [--force]
 *   Ollama 地址只认 config.mjs 的 ollamaBase,命令行不填
 *   --force  忽略新鲜度短路与向量复用,全量重嵌入
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureOllama, gpuOptions, resolveGpuMode, ensureModelPlacement, releaseReplacedOllamaModels } from './ollamaGuard.mjs';
import { loadConfig, DATA_DIR, HF_CACHE_DIR, OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX, OLLAMA_EMBED_PACE_MS, decisionLocalWanted } from './config.mjs';
import { vectorPaths, readVectorMeta, writeVectorMeta, wantEmbedModel } from './vectorStore.mjs';
import { ensureLocalResident, residentEmbed } from './localResident.mjs';
import { takeJsonLock, releaseJsonLock } from './proc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS_PATH = path.join(DATA_DIR, 'chunks.jsonl');
const PIDFILE = path.join(DATA_DIR, '.embed.pid');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const args = process.argv.slice(2);
if (args.includes('--model')) {
  console.error('[err] embed.mjs 不接受 --model。模型名只认 config.mjs;换路径请运行 node init.mjs --model-in ollama|local');
  process.exit(1);
}
const getOpt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const { backend } = wantEmbedModel();
const store = vectorPaths(backend);
const PAIRED_PATH = store.paired;
const EMB_PATH = store.emb;
const BATCH_OPT = Number(getOpt('--batch', backend === 'ollama' ? 8 : 16)); // ollama 32→8(2026-11-10):大批次在显存紧张时会 >5 分钟无响应,触发 undici 300s headers 超时崩溃
const BATCH = Number.isFinite(BATCH_OPT) ? Math.max(1, Math.floor(BATCH_OPT)) : (backend === 'ollama' ? 8 : 16);
const FORCE = args.includes('--force');
// 批间节流(2026-11-11 WHEA 缓解):默认 ollama 500ms(config.OLLAMA_EMBED_PACE_MS)、local 0;--pace 单次覆盖,0=关。
const PACE_MS = Math.max(0, Number(getOpt('--pace', backend === 'ollama' ? OLLAMA_EMBED_PACE_MS : 0)) || 0);

if (!fs.existsSync(CHUNKS_PATH)) {
  console.error('未找到 data/chunks.jsonl,请先运行 node build.mjs');
  process.exit(1);
}
const chunksRaw = fs.readFileSync(CHUNKS_PATH, 'utf8');
const chunks = chunksRaw.split('\n').filter(Boolean).map(l => JSON.parse(l));
const curSig = md5(chunksRaw);
const meta = readVectorMeta(backend) || {};
console.log(`[info] 载入 ${chunks.length} 个块,后端 = ${backend},目录 = vectors/${backend}${FORCE ? '(--force 全量)' : ''}`);

/** 估算 token 数:中日韩字符≈1,其他≈1/4 */
function estTokens(s) {
  let cjk = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e7f) cjk++;
  return cjk + Math.floor((s.length - cjk) / 4);
}
// 块最长约 120 行。2048 能装下整块,且低于 jina 上下文和 Ollama num_ctx。两条路径用同一个上限。
const EMBED_TOKEN_BUDGET = 2048;
function trimToBudget(text, budget = EMBED_TOKEN_BUDGET) {
  const lines = text.split('\n');
  const out = [];
  let used = 0;
  for (const ln of lines) {
    const cost = estTokens(ln) + 1;
    if (used + cost > budget && out.length) break;
    out.push(ln);
    used += cost;
  }
  return out.join('\n');
}

// ---------- 新鲜度短路:签名一致且向量文件在且模型未变,直接返回 ----------
// 生效模型名只认 config.mjs,不接受命令行覆盖
const effModel = wantEmbedModel().model;
if (!FORCE && meta.signature === curSig && fs.existsSync(EMB_PATH) && meta.model === effModel) {
  if (!fs.existsSync(PAIRED_PATH)) fs.copyFileSync(CHUNKS_PATH, PAIRED_PATH); // 首次建立配对快照
  // 刷新保鲜时间戳:签名一致=向量对当前代码有效,不刷新会让 auto 对非 git 目录误判过期
  writeVectorMeta(backend, { ...meta, builtAt: new Date().toISOString() });
  console.log('[ok] 向量索引已是最新,无需嵌入(已刷新保鲜时间戳)');
  process.exit(0);
}

// ---------- 单实例守卫:已有嵌入进程在跑则直接退出(auto 后台分离场景防重) ----------
// S4-F1(2026-11-11 夜审):旧"读-查-直写"两步非原子,与 --build-vectors 的 wx 锁交叉互拆 → 双嵌入竞跑。
// 统一走 takeJsonLock(wx-first + 陈旧接管,2026-11-10 修的原语;写 {pid,ts} 与 embedBusy 读形一致),持有至退出。
{
  if (!takeJsonLock(PIDFILE)) {
    let prev = { pid: NaN, ts: 0 };
    try { prev = JSON.parse(fs.readFileSync(PIDFILE, 'utf8')); } catch { /* 锁主读不出 */ }
    console.log(`[warn] 已有嵌入进程在运行(pid ${Number(prev.pid) || '?'},ts ${Number(prev.ts) || '?'}),本次退出`);
    process.exit(0);
  }
  process.on('exit', () => { releaseJsonLock(PIDFILE); });
}

// ---------- 复用表:旧配对快照 × 旧向量,md5(块文本) → 向量 ----------
function buildReuse() {
  try {
    if (!fs.existsSync(PAIRED_PATH) || !fs.existsSync(EMB_PATH)) return null;
    const paired = fs.readFileSync(PAIRED_PATH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const buf = fs.readFileSync(EMB_PATH);
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    if (!paired.length || f32.length % paired.length !== 0) return null;
    const dimOld = f32.length / paired.length;
    const map = new Map();
    for (let i = 0; i < paired.length; i++) map.set(md5(paired[i].t), f32.subarray(i * dimOld, (i + 1) * dimOld));
    return { map, dimOld };
  } catch { return null; }
}

// ---------- 后端工厂:统一返回 { model, dim, embed(texts[]) => 向量行 } ----------
const OLLAMA_BASE = loadConfig().ollamaBase;
const OLLAMA_MODEL = loadConfig().models.embedding;

async function ollamaEmbed(texts) {
  let lastErr;
  // 韧性(2026-11-10):显式 180s 请求超时(替代 undici 300s 默认,且失败可重试而非整进程崩溃);
  // 5 次重试、指数回退——显存挤占/队列卡顿的瞬时 stall 不再打断整轮嵌入。
  for (let retry = 0; retry < 5; retry++) {
    try {
      const resp = await fetch(`${OLLAMA_BASE}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, input: texts, options: { num_ctx: OLLAMA_NUM_CTX, ...gpuOptions() }, keep_alive: OLLAMA_KEEP_ALIVE }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      const j = await resp.json();
      if (!j.embeddings?.length) throw new Error('响应缺少 embeddings 字段');
      return j.embeddings;
    } catch (e) {
      lastErr = e;
      if (retry === 4) break;
      const wait = [5_000, 15_000, 45_000, 90_000][retry];
      console.log(`[warn] ollama embed 失败(${String(e && e.cause && e.cause.code || e.message).slice(0, 80)}),${wait / 1000}s 后重试 ${retry + 1}/4(批次 ${texts.length} 条)`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function makeEmbedder() {
  if (backend === 'ollama') {
    const g = await ensureOllama({ base: OLLAMA_BASE, onInfo: console.log });
    if (!g.up) {
      console.error(`[err] Ollama 嵌入路径不可用(${OLLAMA_BASE},不自动拉起服务,也不改换 local)。本次嵌入失败,检索降级 bm25。切换路径请运行: node init.mjs --model-in local`);
      process.exit(1);
    }
    // keep 名单含决策模型:re-embed 期间不卸它(否则每次重建向量都把判定模型踢出显存,下一轮判定重载 ~1s)
    const decModel = decisionLocalWanted() ? loadConfig().models.decision : null;
    await releaseReplacedOllamaModels([OLLAMA_MODEL, loadConfig().models.reranker, decModel], console.log);
    await ensureModelPlacement([OLLAMA_MODEL], console.log); // 先同步驻留位置,探测请求才会按目标模式加载
    const probe = await ollamaEmbed(['dimension probe']);
    const dim = probe[0].length;
    console.log(`[info] Ollama ${OLLAMA_MODEL} @ ${OLLAMA_BASE},dim=${dim},batch=${BATCH},pace=${PACE_MS}ms | [gpu] ${resolveGpuMode().reason}`);
    return {
      model: OLLAMA_MODEL, dim,
      async embed(texts) {
        const rows = [];
        for (let b = 0; b * BATCH < texts.length; b++) {
          const slice = texts.slice(b * BATCH, (b + 1) * BATCH);
          // qwen3-embedding 文档侧不加指令前缀,直接嵌入原文
          rows.push(...await ollamaEmbed(slice.map(t => trimToBudget(t))));
          console.log(`[progress] 嵌入 ${Math.min((b + 1) * BATCH, texts.length)}/${texts.length}`);
        }
        return rows;
      },
    };
  }
  if (backend === 'local') {
    const MODEL_ID = loadConfig().models.localEmbedding;
    const hostedProbe = await residentEmbed(['dim probe']);
    if (hostedProbe?.[0]?.length) {
      const dim = hostedProbe[0].length;
      console.log(`[info] local 嵌入复用常驻进程 ${MODEL_ID},dim=${dim},batch=${BATCH}`);
      return {
        model: MODEL_ID, dim,
        async embed(texts) {
          const rows = [];
          for (let b = 0; b * BATCH < texts.length; b++) {
            const slice = texts.slice(b * BATCH, (b + 1) * BATCH).map(t => trimToBudget(t));
            const part = await residentEmbed(slice);
            if (!part) throw new Error('local 常驻进程中断');
            rows.push(...part);
            console.log(`[progress] 嵌入 ${Math.min((b + 1) * BATCH, texts.length)}/${texts.length}`);
          }
          return rows;
        },
      };
    }
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = HF_CACHE_DIR;
    env.allowLocalModels = false;
    // 常驻进程不在时才在本进程加载。jina 不需要输入前缀,也不访问 Ollama
    console.log(`[info] local 常驻进程不可用,改为本进程加载 ${MODEL_ID}`);
    let pipe;
    try {
      try {
        pipe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
      } catch (e) {
        console.warn(`[warn] HuggingFace 下载失败(${e.message}),切换 hf-mirror.com 重试...`);
        env.remoteHost = 'https://hf-mirror.com';
        pipe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
      }
    } catch (e) {
      console.error(`[err] local 嵌入模型拉起失败(${e.message})。本次嵌入失败,检索降级 bm25。不改换 Ollama 路径。`);
      process.exit(1);
    }
    // 维度不猜测——探测推理实测(不同家族/规格输出维度不同,硬编码会导致 vec.set 越界)
    const probe = await pipe(['dim probe'], { pooling: 'mean', normalize: true });
    const dim = probe.tolist()[0].length;
    return {
      model: MODEL_ID, dim,
      async embed(texts) {
        const rows = [];
        for (let b = 0; b * BATCH < texts.length; b++) {
          const slice = texts.slice(b * BATCH, (b + 1) * BATCH).map(t => trimToBudget(t));
          const out = await pipe(slice, { pooling: 'mean', normalize: true });
          rows.push(...out.tolist());
          console.log(`[progress] 嵌入 ${Math.min((b + 1) * BATCH, texts.length)}/${texts.length}`);
        }
        return rows;
      },
    };
  }
  console.error(`[err] modelIn 只能是 ollama 或 local,当前为 ${backend}`);
  process.exit(1);
}

// ---------- 主流程:复用 → 差量嵌入 → 落盘 ----------
const t0 = Date.now();
const emb = await makeEmbedder();

let reuseMap = null;
const reuse = FORCE ? null : buildReuse();
if (reuse) {
  if (reuse.dimOld === emb.dim) reuseMap = reuse.map;
  else console.warn(`[warn] 旧向量维度 ${reuse.dimOld} ≠ 本次 ${emb.dim},改为全量嵌入`);
}

const vec = new Float32Array(chunks.length * emb.dim);
const misses = [];
let hit = 0;
chunks.forEach((c, i) => {
  const v = reuseMap?.get(md5(c.t));
  if (v) { vec.set(v, i * emb.dim); hit++; }
  else misses.push(i);
});
console.log(`[info] 增量:复用 ${hit} / 待嵌入 ${misses.length}(共 ${chunks.length})`);

if (misses.length) {
  // 分批 + 部分落盘(2026-11-10):每 8 批把已嵌入行写到正式路径(paired 只含已完成块)。
  // 崩溃后 rerun 的复用表(md5(块文本)→向量)会跳过已完成块,只补剩余——不再从 0 重来。
  // 完成后的全量写仍在下方(全量 vec + 全量 chunks 配对),部分文件只存在于中途。
  const doneRows = []; const doneIdx = [];
  const flushPartial = () => {
    fs.mkdirSync(store.dir, { recursive: true });
    const parts = doneRows.map((row) => Buffer.from(Float32Array.from(row).buffer, Float32Array.from(row).byteOffset, Float32Array.from(row).byteLength));
    fs.writeFileSync(EMB_PATH + '.' + process.pid + '.tmp', Buffer.concat(parts));
    fs.renameSync(EMB_PATH + '.' + process.pid + '.tmp', EMB_PATH);
    const pairedTxt = doneIdx.map((i) => JSON.stringify(chunks[i])).join('\n') + '\n';
    fs.writeFileSync(PAIRED_PATH + '.' + process.pid + '.tmp', pairedTxt);
    fs.renameSync(PAIRED_PATH + '.' + process.pid + '.tmp', PAIRED_PATH);
    console.log(`[info] 部分进度已落盘(${doneRows.length}/${misses.length},崩溃可续)`);
  };
  for (let b = 0; b * BATCH < misses.length; b++) {
    const idxs = misses.slice(b * BATCH, (b + 1) * BATCH);
    const rowsPart = await emb.embed(idxs.map(i => chunks[i].t));
    if (rowsPart.length !== idxs.length) { console.error(`[err] 嵌入返回 ${rowsPart.length} 行,期望 ${idxs.length}`); process.exit(1); }
    rowsPart.forEach((row, k) => { vec.set(row, idxs[k] * emb.dim); doneRows.push(row); });
    doneIdx.push(...idxs);
    console.log(`[progress] 嵌入 ${doneRows.length}/${misses.length}`);
    if ((b + 1) % 8 === 0 && b * BATCH + BATCH < misses.length) flushPartial();
    if (PACE_MS && (b + 1) * BATCH < misses.length) await new Promise(r => setTimeout(r, PACE_MS)); // 批间喘息(WHEA 缓解)
  }
}

fs.mkdirSync(store.dir, { recursive: true });
// tmp + 同盘 rename:嵌入动辄几分钟,中途被 Ctrl+C 不能留下半截向量文件(下次读就是脏数据)
fs.writeFileSync(EMB_PATH + '.' + process.pid + '.tmp', Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
fs.renameSync(EMB_PATH + '.' + process.pid + '.tmp', EMB_PATH);
// 配对快照用**内存中的 chunks**(2026-11-11 修竞态):旧实现重读 CHUNKS_PATH 文件,若 chunks 在
// 嵌入期间被 build.mjs 重新生成(行数变化),EMB 行数与 PAIRED 行数错位 → 下次 buildReuse 判 null,复用全失效
fs.writeFileSync(PAIRED_PATH + '.' + process.pid + '.tmp', chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
fs.renameSync(PAIRED_PATH + '.' + process.pid + '.tmp', PAIRED_PATH); // 配对快照原子替换(2026-11-10 二次审计 P1-3+M2 漏列):copyFileSync 中途断电=向量与快照错位,下次重嵌被固化
writeVectorMeta(backend, { model: emb.model, dim: emb.dim, backend, chunks: chunks.length, signature: curSig, builtAt: new Date().toISOString() });
console.log(`[ok] 完成:复用 ${hit} + 新嵌入 ${misses.length} = ${chunks.length} × ${emb.dim} 维,耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s(模型仅处理 ${misses.length} 块)`);
if (backend === 'local') {
  const health = await ensureLocalResident(console.log);
  if (!health?.embedOk || !health?.rerankOk) console.warn('[warn] 嵌入已完成,local 常驻进程未就绪');
}
