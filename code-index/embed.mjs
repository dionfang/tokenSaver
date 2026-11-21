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
import { loadConfig, DATA_DIR, HF_CACHE_DIR, OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX, decisionLocalWanted } from './config.mjs';
import { vectorPaths, readVectorMeta, writeVectorMeta, wantEmbedModel } from './vectorStore.mjs';
import { ensureLocalResident, residentEmbed } from './localResident.mjs';
import { takeJsonLock, releaseJsonLock, pidAlive } from './proc.mjs';
import { onnxWeightsJson } from './onnxWeights.mjs';

// 20261120(测试机静默死亡修复):未捕获级失败也必须留 stderr——弹窗 tail=stderr||stdout,stderr 空时
// 死因全丢。原生级崩溃仍接不住,那条路走 onnxProbe 子进程隔离(见 makeEmbedder local 分支)。
process.on('uncaughtException', (e) => { console.error(`[err] 未捕获异常:${e && e.stack ? e.stack : e}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`[err] 未处理拒绝:${e && e.stack ? e.stack : e}`); process.exit(1); });

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
const BATCH_OPT = Number(getOpt('--batch', backend === 'ollama' ? 32 : 16)); // 2026-11-14 恢复 32(曾 8):WHEA 死机初步排查=显卡供电线材(非 GPU 满载本身),保守化解除;若复发先回 --batch 8 --pace 500 并查线材
const BATCH = Number.isFinite(BATCH_OPT) ? Math.max(1, Math.floor(BATCH_OPT)) : (backend === 'ollama' ? 32 : 16);
const FORCE = args.includes('--force');
// 批间节流(2026-11-11 WHEA 缓解引入;2026-11-14 根因转向显卡供电线材后默认关,0=无限速;--pace 单次覆盖)
const PACE_MS = Math.max(0, Number(getOpt('--pace', 0)) || 0);
// CPU 线程上限(2026-11-14 用户定案:本地 transformers.js 嵌入默认"后台缓慢运行"不拉满 CPU):
//   默认取 config embedCpuThreads(≈核数/4,0=全核=旧行为);--cpu-threads 单次覆盖,仅 local 后端生效。
const EMBED_THREADS = Math.max(0, Number(getOpt('--cpu-threads', loadConfig().embedCpuThreads)) || 0);

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
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(PIDFILE, 'utf8')); } catch { /* 无锁或损坏 */ }
  if (!takeJsonLock(PIDFILE)) {
    console.log(`[warn] 已有嵌入进程在运行(pid ${Number(prev?.pid) || '?'},ts ${Number(prev?.ts) || '?'}),本次退出`);
    process.exit(3); // S4-3(20261119 夜审):锁忙退出码与「已是最新」(0)区分,查退出码的编排不再把没嵌当成功;消费方 auto/tray 均 fire-and-forget 不分支退出码
  }
  if (prev && Number.isFinite(Number(prev.pid)) && !pidAlive(Number(prev.pid))) {
    console.log(`[info] 接管过期嵌入锁(原 pid ${prev.pid} 已不在)`);
  }
  process.on('exit', () => { releaseJsonLock(PIDFILE); });
}

// ---------- 复用表:旧配对快照 × 旧向量,md5(块文本) → 向量 ----------
function buildReuse(expectedDim = null) { // S4-F1(20261118):expectedDim 传入当前嵌入 dim,旧代际不符拒复用
  try {
    if (!fs.existsSync(PAIRED_PATH) || !fs.existsSync(EMB_PATH)) return null;
    const paired = fs.readFileSync(PAIRED_PATH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const buf = fs.readFileSync(EMB_PATH);
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    if (!paired.length || f32.length % paired.length !== 0) return null;
    const dimOld = f32.length / paired.length;
    if (expectedDim != null && dimOld !== expectedDim) return null; // S4-F1:代际不符拒复用(防 NaN/余弦错位)
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
    const { env, pipeline } = await (await import('./transformersLoader.mjs')).loadTransformers();
    env.cacheDir = HF_CACHE_DIR;
    env.allowLocalModels = true; // 2026-11-19 修(测试机同步报错):packed 布局权重已由向导/托盘下载到 hf-cache,
    // 允许本地命中,离线/受限网络不再强制远端解析;transformers 自行下载时仍会落同一 cacheDir。
    // 常驻进程不在时才在本进程加载。jina 不需要输入前缀,也不访问 Ollama
    console.log(`[info] local 常驻进程不可用,改为本进程加载 ${MODEL_ID},threads=${EMBED_THREADS || '全核'}`);
    const sopt = EMBED_THREADS > 0 ? { session_options: { intraOpNumThreads: EMBED_THREADS, interOpNumThreads: 1 } } : {};
    // 2026-11-19 修(测试机同步报错):加载前核嵌入权重完整——不完整给明确指引(托盘会自动补下载),
    // 不裸抛 transformers 下载异常;完整才进 pipeline(allowLocalModels=true 本地命中优先,受限网络不强制远端)。
    {
      // 完整性门=存在+字节数(20261120 测试机回归:双写竞态/懒下载中断留半截文件,存在性门放过→
      // onnx 原生崩 0xC0000005、探针误判静默死。期望字节单源 onnx-weights.json(S14-F3 20261120 夜:
      // 原三处字面量双写收敛;tray weightsOnline 字面量由 embedProbe.test 三方一致性门对账);
      // config* 无预置字节只查存在。
      const jinaBytes = onnxWeightsJson()['Xenova/jina-embeddings-v2-base-zh'] || {};
      const WFILES = [
        ...Object.entries(jinaBytes).map(([f, bytes]) => ({ f, bytes })),
        { f: 'config.json' },
        { f: 'tokenizer_config.json' },
      ];
      const miss = WFILES.filter(({ f, bytes }) => {
        let st; try { st = fs.statSync(path.join(HF_CACHE_DIR, MODEL_ID, f)); } catch { return true; }
        return bytes ? st.size !== bytes : false;
      });
      if (miss.length) {
        console.error(`[err] 嵌入权重未齐或不完整(${MODEL_ID}: ${miss.map((m) => m.f).join(', ')};目录 ${HF_CACHE_DIR})。`);
        console.error('      请等待托盘自动补权重完成(面板模型灯转绿),或重开安装向导重新下载;权重齐后再次「立即同步」。');
        console.error('      检索暂以 bm25 词法模式服务,不影响其他功能。');
        process.exit(1);
      }
    }
    let pipe;
    // onnx 崩溃隔离探针(20261120 测试机静默死亡修复):本进程 native 会话创建的原生级死亡(stderr 空)
    // 任何 try/catch 接不住 ⇒ 先在子进程创建一次会话:静默死=隔离回退 wasm EP(纯 wasm 不 dlopen 原生 .node);
    // 带错死=stderr 原样 surfaced 定罪;活=本进程照旧 native(零回归)。结论按 ort+node 版本缓存,稳态零开销。
    const onnxProbe = await import('./onnxProbe.mjs');
    let useWasm = false; // 20261120:原生崩⇒纯 wasm 后路(wasmEmbed 接管);'cpu' 不是出路——transformers v4 node 的 cpu EP 仍走 onnxruntime-node 原生库,该机必崩(干净文件复锤)
    const pKey = onnxProbe.probeKey();
    const pCache = onnxProbe.readProbeCache(DATA_DIR, pKey);
    if (pCache) {
      if (pCache.action === 'wasm') { useWasm = true; console.log('[info] onnx 探针缓存:native 曾静默崩溃/超时 → 纯 wasm 后路(wasmEmbed 接管)'); }
      else console.log('[info] onnx 探针缓存:native 可用');
    } else {
      console.log('[info] onnx native 探针(子进程崩溃隔离,仅首跑,结论缓存)…');
      const pr = await onnxProbe.runOnnxProbe({ modelId: MODEL_ID, cacheDir: HF_CACHE_DIR, threads: EMBED_THREADS });
      const dec = onnxProbe.decideProbeOutcome(pr);
      if (dec.action === 'fail') {
        console.error(`[err] onnx native 探针失败:${dec.reason}`);
        console.error('      本次嵌入失败,检索降级 bm25。不改换 Ollama 路径。');
        process.exit(1);
      }
      if (dec.action === 'wasm') { useWasm = true; console.warn(`[warn] ${dec.reason}(回退纯 wasm 后路)`); }
      else console.log('[info] onnx native 探针通过');
      onnxProbe.writeProbeCache(DATA_DIR, pKey, dec.action);
    }
    if (useWasm) {
      // 纯 wasm 后路(20261120 测试机复锤:干净文件仍 0xC0000005 ⇒ onnxruntime-node 原生库在该机必崩,
      // 而 transformers v4 node 构建无可用 wasm 后端,cpu EP=同一原生库)。tokenizers+onnxruntime-web
      // 直推 model_quantized.onnx,零原生 .node,绕开 CPU 指令集/注入/驱动三变量。仅探针实证崩才走,原生优先不变。
      console.log('[info] 切换纯 wasm 后路(tokenizers+onnxruntime-web 直推,零原生 .node)…');
      try {
        const we = await (await import('./wasmEmbed.mjs')).createWasmEmbedder({ modelId: MODEL_ID, cacheDir: HF_CACHE_DIR, threads: EMBED_THREADS || 2 });
        console.log(`[info] 纯 wasm 后路就绪(dim=${we.dim})`);
        return { model: MODEL_ID, dim: we.dim, embed: we.embed };
      } catch (e) {
        console.error(`[err] 纯 wasm 后路就绪失败(${e.message})。本次嵌入失败,检索降级 bm25。不改换 Ollama 路径。`);
        process.exit(1);
      }
    }
    const failPipe = (e) => {
      console.error(`[err] local 嵌入模型拉起失败(${e.message},device=native)。本次嵌入失败,检索降级 bm25。不改换 Ollama 路径。`);
      console.error('      若为离线/受限网络:确认托盘权重灯为绿(权重已齐)后重试;仍失败请把本段报错与弹窗退出码反馈维护者。');
      process.exit(1);
    };
    console.log('[info] 创建 onnx session(device=native cpu)…');
    try {
      pipe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', ...sopt });
    } catch (e) {
      console.warn(`[warn] HuggingFace 下载失败(${e.message}),切换 hf-mirror.com 重试...`);
      env.remoteHost = 'https://hf-mirror.com';
      try { pipe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', ...sopt }); } catch (e2) { failPipe(e2); }
    }
    console.log('[info] session ok,dim 探针…');
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
const reuse = FORCE ? null : buildReuse(emb.dim); // S4-F1:传入当前 dim
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
  // 分批 + 部分落盘(2026-11-10):每 16 批把已嵌入行写到正式路径(paired 只含已完成块)。
  // 崩溃后 rerun 的复用表(md5(块文本)→向量)会跳过已完成块,只补剩余——不再从 0 重来。
  // 完成后的全量写仍在下方(全量 vec + 全量 chunks 配对),部分文件只存在于中途。
  // 20261120-S4-F4:间隔 8→16——每 8 批全量重写已完成行,4000 块全量重嵌累计 IO≈15×全量(写放大);
  // 崩溃可续语义不变(EMB/PAIRED 对组非原子窗由 buildReuse 字节数校验+代际守卫兜底)。
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
  try {
    for (let b = 0; b * BATCH < misses.length; b++) {
      const idxs = misses.slice(b * BATCH, (b + 1) * BATCH);
      const rowsPart = await emb.embed(idxs.map(i => chunks[i].t));
      if (rowsPart.length !== idxs.length) { console.error(`[err] 嵌入返回 ${rowsPart.length} 行,期望 ${idxs.length}`); process.exit(1); }
      rowsPart.forEach((row, k) => { vec.set(row, idxs[k] * emb.dim); doneRows.push(row); });
      doneIdx.push(...idxs);
      console.log(`[progress] 嵌入 ${doneRows.length}/${misses.length}`);
      if ((b + 1) % 16 === 0 && b * BATCH + BATCH < misses.length) flushPartial();
      if (PACE_MS && (b + 1) * BATCH < misses.length) await new Promise(r => setTimeout(r, PACE_MS)); // 批间喘息(WHEA 缓解)
    }
  } catch (e) {
    console.error(`[err] 嵌入中断(${String(e?.message || e).slice(0, 200)}),释放锁;冷却结束后自动续嵌`);
    process.exit(1);
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
