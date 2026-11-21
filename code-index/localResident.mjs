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
import { DATA_DIR, HF_CACHE_DIR, loadConfig, OLLAMA_KEEP_ALIVE, decisionLocalWanted } from './config.mjs';
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
  // decision 也参与比对(2026-11-08):旧版本状态文件缺该键即视为不匹配 → 换新常驻加载 /decision;
  // decisionLocalWanted=false(开关关/显式远程)时 wanted=null,写到状态文件也是 null,同口径比对
  return state?.embedding === cfg.localEmbedding && state?.reranker === cfg.localReranker
    && state?.decision === (decisionLocalWanted() ? cfg.localDecision : null);
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
  const { env, pipeline } = await (await import('./transformersLoader.mjs')).loadTransformers();
  env.cacheDir = HF_CACHE_DIR;
  env.allowLocalModels = true; // S4-F2(20261120 夜):与 2026-11-19 embed 修同口径统一——本地 cacheDir 命中优先,离线/受限网络不强制远端解析
  // CPU 线程上限(2026-11-14 用户定案):常驻会话同时承接 embed.mjs 的批量复用路径——批量在此跑时
  // 不允许拉满 CPU;查询单条本就轻,限线程无感。0=全核(旧行为)。
  const cap = Math.max(0, Number(loadConfig().embedCpuThreads) || 0);
  const sopt = cap > 0 ? { session_options: { intraOpNumThreads: cap, interOpNumThreads: 1 } } : {};
  console.error(`[info] 嵌入模型会话 threads=${cap || '全核'}`);
  try {
    return await pipeline('feature-extraction', modelId, { dtype: 'q8', ...sopt });
  } catch (e) {
    console.error(`[warn] HuggingFace 下载失败(${e.message}),切换 hf-mirror.com 重试...`);
    env.remoteHost = 'https://hf-mirror.com';
    return pipeline('feature-extraction', modelId, { dtype: 'q8', ...sopt });
  }
}

/** local 决策模型(2026-11-09 切换定档):Strands-Decider-2B ONNX 指针头(q4f16 默认档)。
 *  分词与 offsets 走官方 tokenizers Rust binding(与 Python 官方栈同一 crate,逐 token 一致,
 *  见 test/strands-align.test.mjs 金标准对照);前向走 onnxruntime-node 直跑图
 *  (input_ids+attention_mask+answer_pos+option_pos → logits)。
 *  modelSpec = 'strands:<hf-cache 目录名>[:档位]'(档位缺省 q4f16,可选 q8);旧 Decision-2.0-Eos 已删(零兼容)。
 *  档位对照(同批 60 条):q4f16 73.3%/1.77s/1.04GB vs q8 70.0%/3.76s/1.72GB——q4f16 全面胜出。 */
export async function loadLocalDecision(modelSpec) {
  const m = /^strands:([^:]+)(?::(q4f16|q8|quantized))?$/.exec(String(modelSpec || ''));
  if (!m) throw new Error(`localDecision 暂只支持 strands:<目录>[:档位](收到 ${modelSpec})`);
  const dir = path.join(HF_CACHE_DIR, m[1]);
  const quant = m[2] === 'q8' ? 'quantized' : (m[2] || 'q4f16');
  const onnxPath = path.join(dir, quant === 'quantized' ? 'model_quantized.onnx' : `model_${quant}.onnx`);
  if (!fs.existsSync(onnxPath)) throw new Error(`strands 权重缺失: ${onnxPath}(应位于 code-index/hf-cache/${m[1]}/)`);
  const { loadStrandsTokenizer, STRANDS_CHOICE_TEMPERATURE } = await import('./strandsAlign.mjs');
  const ort = (await import('onnxruntime-node')).default;
  const t0 = Date.now();
  const session = await ort.InferenceSession.create(onnxPath);
  const tokenizer = loadStrandsTokenizer(dir);
  console.error(`[info] strands ONNX ${quant} 会话就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s(${m[1]},input=${session.inputNames.join(',')})`);
  return { tokenizer, session, ort, temperature: STRANDS_CHOICE_TEMPERATURE, backend: `strands-onnx-${quant}` };
}

/** Strands 指针头前向打分:返回 {keys,scores,probabilities}(logits 先除 choice 温度再 softmax,和为 1)。 */
export async function decisionScorePairs(decision, { context, question, options }) {
  const { renderStrandsChoice } = await import('./strandsAlign.mjs');
  const rq = renderStrandsChoice({ state: context, instructions: question, options });
  const { ids, optionPos, answerPos } = await decision.tokenizer.encodePrompt(rq, 4096);
  const L = ids.length;
  const K = optionPos.length;
  const feeds = {
    input_ids: new decision.ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, L]),
    attention_mask: new decision.ort.Tensor('int64', BigInt64Array.from(new Array(L).fill(1), BigInt), [1, L]),
    answer_pos: new decision.ort.Tensor('int64', BigInt64Array.from([answerPos], BigInt), [1]),
    option_pos: new decision.ort.Tensor('int64', BigInt64Array.from(optionPos, BigInt), [1, K]),
  };
  const out = await decision.session.run(feeds);
  const t = out[decision.session.outputNames[0]];
  const raw = Array.from(t.data, Number).slice(0, K).map((v) => v / decision.temperature);
  const mx = Math.max(...raw);
  const exps = raw.map((v) => Math.exp(v - mx));
  const sum = exps.reduce((a, b) => a + b, 0);
  return { keys: rq.keys, scores: raw, probabilities: exps.map((v) => v / sum) };
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
  try { return spawnLogged(path.join(here, 'localResident.mjs'), LOG_PATH, here).pid; }
  catch (e) { console.error(`[warn] localResident 拉起失败:${e && e.message ? e.message : e}`); throw e; } // S7-9:拉起失败补告警
}

/** 保证与当前 config 模型一致的常驻进程在跑。返回 /health;超时或失败为 null。
 *  retryDecision(2026-11-08,预热路径专用):常驻匹配但决策模型未就绪时,停旧拉新重试一次
 *  (决策模型只在常驻启动时加载,不重启就永远弃权);嵌入/精排正常时仅 warm 传 true,其余调用方默认不打断。 */
export async function ensureLocalResident(onInfo = () => {}, { retryDecision = false } = {}) {
  const state = readStateFile();
  if (state && pidAlive(state.pid) && modelsMatch(state)) {
    const health = await waitReady(180000);
    if (health?.ready) {
      // decisionLocalWanted=false(开关关/显式远程)时 decisionOk 恒 false 属预期,不算需要重拉
      if (retryDecision && decisionLocalWanted() && health.decisionOk !== true) {
        onInfo('[info] local 常驻决策模型未就绪,将重启常驻重拉');
        await stopLocalResident();
      } else {
        return health;
      }
    } else {
      onInfo('[warn] local 常驻进程无响应,将重新拉起');
      await stopLocalResident();
    }
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

/** 常驻进程已加载且模型与配置一致时返回 /health,否则 null。
 *  ⚠️ 预算别给太小(2026-11-09 实测):undici 首次建连要 ~600ms,800ms 预算一冷就超时
 *  → 误判"常驻没就绪" → 自愈去拉起第二个常驻(实测双常驻 4.8GB 的起因)。 */
export async function residentHealth(ms = 3000) {
  const state = readStateFile();
  if (!state?.port || !pidAlive(state.pid) || !modelsMatch(state)) return null;
  try {
    const health = await fetchHealth(state, ms);
    return health?.ready ? health : null;
  } catch { return null; }
}

/** 常驻进程可用时返回向量行,否则 null(调用方改在本进程加载)。 */
/** L2 融合票(可选)的常驻嵌入请求预算(20261120 用户裁定修复「auto 经常无响应」):
 *  常驻 /embed 卡死(死 pid 错配/runner 挂起)时旧预算 120s 每回合白等 ⇒ 收紧到 10s,
 *  到点 fail-open 弃权(embedIntent 侧既有的 6s/8s 预算同族)。黄金值锚:residentEmbed.test 恒断言。 */
export const RESIDENT_EMBED_TIMEOUT_MS = 10_000;

export async function residentEmbed(texts, ms = RESIDENT_EMBED_TIMEOUT_MS) {
  if (!Array.isArray(texts) || !texts.length) return null;
  const json = await postJson('/embed', { texts }, ms);
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

/** 常驻本地决策模型可用时返回最优/概率,否则 null(调用方弃权/跳闸,绝不拖回本进程)。 */
export async function residentDecide({ context, question, options }, ms = 120000) {
  const json = await postJson('/decision', { context, question, options }, ms);
  if (!json?.ok || !Array.isArray(json?.probabilities) || !json.probabilities.length) return null;
  return { keys: json.keys, scores: json.scores, probabilities: json.probabilities };
}

if (directRun) {
  const cfg = loadConfig();
  const embeddingId = cfg.models.localEmbedding;
  const rerankerId = cfg.models.localReranker;
  const decisionWanted = decisionLocalWanted();
  const decisionId = decisionWanted ? cfg.models.localDecision : null;
  let pipe = null;
  let reranker = null;
  let decision = null;
  let embedOk = false;
  let rerankOk = false;
  let decisionOk = false;
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
        send(res, 200, { ready, embedOk, rerankOk, decisionOk, embedding: embeddingId, reranker: rerankerId, decision: decisionId });
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
      if (req.method === 'POST' && url === '/decision') {
        if (!decision) { send(res, 503, { error: '本地决策模型未就绪' }); return; }
        const body = await readBody(req);
        const options = Array.isArray(body.options) ? body.options.slice(0, 16) : null;
        const question = String(body.question || '');
        const context = String(body.context || '');
        if (!question || !options || options.length < 2) { send(res, 400, { error: '需 question 与 2..16 个 options;一题一判' }); return; }
        const out = await decisionScorePairs(decision, { context, question, options });
        send(res, 200, { ok: true, ...out });
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
    fs.writeFileSync(STATE_PATH, JSON.stringify({ pid: process.pid, port, embedding: embeddingId, reranker: rerankerId, decision: decisionId }));
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
    if (decisionId) {
      try {
        decision = await loadLocalDecision(decisionId);
        const probe = await decisionScorePairs(decision, { context: '健康探活', question: '这条探活文本属于哪类任务?', options: [{ key: 'a', description: '甲类' }, { key: 'b', description: '乙类' }] });
        if (!probe || probe.probabilities.length !== 2) throw new Error('打分输出形状异常');
        decisionOk = true;
        console.error(`[ok] ${decisionId} 已加载(Decision2 选项打分判定)`);
      } catch (e) {
        // 2026-11-12 ④:失败行补 e.stack 首帧——20261110 首装窗口期(权重/tokenizer 资产未齐)
        // 出现过无法定位的 undefined.length 崩溃,当时日志只有 message 无位置;资产齐后未再复现。
        // 补位置后若再复发可直接定位(探活/加载/分词任一层)。
        const at = e.stack ? String(e.stack).split('\n')[1]?.trim() || '' : '';
        console.error(`[fail] local 决策模型拉起失败(${e.message}${at ? ';at ' + at : ''}),决策票将弃权(fail-open)`);
      }
    } else {
      console.error('[info] 决策模型走显式远程(providers 已配/开关关),常驻不加载本地决策模型');
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
