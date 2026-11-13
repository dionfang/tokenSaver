/**
 * 决策模型本地判定后端(2026-11-08 本地化定档;v3 2026-11-08 双协议):替代远程 decision-model-preview。
 *   ollama —— 探测已开的 Ollama(绝不拉起服务),POST {ollamaBase}/v1/systemone + models.decision(tev1:0.8b):
 *             **decision 能力模型只暴露 systemone 端点**(Ollama 0.40+ 对该模型 /api/generate 与 /api/chat
 *             都回 "does not support generate/chat"),与远程网关 /compatible-mode/v1/systemone 同协议:
 *             state 放待判内容、questions 放类型化问题(choice:选项=标签)、answers 回 choice+probabilities。
 *             端点不可用时回退文本生成(/api/generate + strict JSON),兼容普通 LLM 当判定模型。
 *   local  —— 常驻进程(localResident.mjs)加载 models.localDecision(Strands-Decider-2B ONNX 指针头,
 *             modelSpec='strands:<目录>[:q4f16|q8]',缺省 q4f16):POST /decision{context,question,options}
 *             → 选项概率,不走文本解码(旧 Decision-2.0-Eos 已废删除,权重与实现零兼容)。
 * 判定协议与远程体系同口经:一题一问,选项=criteria 的键;ollama 出 JSON、ONNX 出打分,输出都归一成
 *   {answers:{q1:{choice,confidence,probabilities}}} 交给上层 parseAnswers 做值域四防线。
 * 本模块无挂架副作用:不 import decisionModel.mjs(避免环),状态与断路都留给调用方。
 */
import { loadConfig, OLLAMA_KEEP_ALIVE } from './config.mjs';
import { residentDecide } from './localResident.mjs';
import { gpuOptions } from './ollamaGuard.mjs';
import { embedBusy, EMBED_BUSY_REASON } from './embedGate.mjs';

export const LOCAL_DECISION_JSON_HEADER = '输出**一个** JSON 对象(不要 markdown 围栏、不要解释):';

/** Ollama 本地 systemone 端点(与远程网关 /compatible-mode/v1/systemone 同协议;Ollama 0.40+ 的 decision 能力模型唯一入口)。 */
export const SYSTEMONE_LOCAL_PATH = '/v1/systemone';

/** systemone 请求体:state 放待判内容,questions 每条一题(type=choice、criteria=标签→描述)。
 *  与 decisionModel.buildBody 同形——本模块不 import decisionModel(避免环),故在此保留一份。
 *  ⚠️ 该端点不接受 options.num_gpu(实测静默忽略,模型仍自动上 GPU):强制 CPU 对决策模型无效,
 *  CPU 落位只能靠 auto 模式下 Ollama 显存不足时的自动分层。 */
export function buildSystemoneBody({ items, criteria = null, model = '', keyPrefix = 'q' } = {}) {
  const list = Array.isArray(items) ? items : [];
  const questions = {};
  list.forEach((it, i) => {
    questions[`${keyPrefix}${i + 1}`] = {
      type: 'choice',
      instructions: `\`items\` 中 id 为 ${it.id} 的文本属于哪一类任务？`,
      criteria: { ...(criteria || {}) },
    };
  });
  // keep_alive 与嵌入/精排同口径(systemone 也认),否则判定模型 5 分钟即卸载,每轮判定都重载。
  return { state: { items: list.map((it) => ({ id: it.id, text: it.text })) }, model, questions, keep_alive: OLLAMA_KEEP_ALIVE };
}

/** 判定 prompt:persona + items 原文 + 判据表 + 逐题占位。criteria 的键即合法标签,值域校验仍由上层 parseAnswers 把关。 */
export function buildLocalPrompt({ items, criteria }) {
  const lines = [
    '你是任务分档判定器。读 items 里每条文本,从给定标签中选**一个**最贴切的标签,并给出置信度(0..1)与各标签概率(和为 1)。',
    `可选标签及判据:${Object.entries(criteria || {}).map(([k, v]) => `${k}=${String(v)}`).join(';')}。`,
    '先通读再判定;只按文本内容判定,不要输出标签之外的值。',
    'items:',
    ...(items || []).map((it) => `- id ${it.id}: ${String(it.text).slice(0, 1200)}`),
    LOCAL_DECISION_JSON_HEADER,
    '{"answers":{',
    ...(items || []).map((it, i) => `  "q${i + 1}":{"choice":"标签","confidence":0.0,"probabilities":{"标签":0.0,"标签2":0.0}}${i < items.length - 1 ? ',' : ''}`),
    '}}',
  ];
  return lines.join('\n');
}

/** 括号平衡地提取第一个合法 JSON 对象;失败回退"首 { 到末 }";再失败 null。 */
export function extractJson(text) {
  const s = String(text || '');
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (start < 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        const cand = s.slice(start, i + 1);
        try { return JSON.parse(cand); } catch { start = -1; }
      }
    }
  }
  if (start >= 0 && s.lastIndexOf('}') > start) {
    try { return JSON.parse(s.slice(start, s.lastIndexOf('}') + 1)); } catch { /* 落到 null */ }
  }
  return null;
}

/** 解析出的 JSON 归一为远程同形 {answers:{qN:{choice,confidence,probabilities}}}。给出裸问题图也包一层。 */
export function shapeAnswers(json, valid) {
  if (!json || typeof json !== 'object') return null;
  const body = json.answers && typeof json.answers === 'object' ? json.answers : json;
  const answers = {};
  for (const [k, v] of Object.entries(body)) {
    if (!/^q\d+$/i.test(String(k))) continue;
    if (!v || typeof v !== 'object' || typeof v.choice === 'undefined') continue;
    // 先 trim 再校验(与 parseAnswers 同口径):模型常回 ' multi ' 这类带空白的标签,
    // 用原始值校验会把合法答案整条丢弃 → 分片假失败走重试/回退。
    if (valid && !valid.test(String(v.choice).trim())) continue;
    const conf = Number(v.confidence ?? 0);
    const probs = v.probabilities && typeof v.probabilities === 'object' ? v.probabilities : {};
    // id=题号(parseAnswers 用它把答案键位对齐回本分片 items,键位对不上就整条丢弃——四防线②)
    answers[k] = {
      type: 'choice', id: Number(String(k).replace(/^\D+/, '')),
      choice: String(v.choice).trim(), confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0, probabilities: probs,
    };
  }
  return { answers };
}

/** JSON 提取失败兜底:整串扫首个合法标签。扫不到=分片失败(下游按弃权/记错处理)。 */
function fallbackFromText(text, items, valid) {
  const s = String(text || '');
  const flags = String((valid && valid.flags) || 'i').replace(/g/g, '') + 'g';
  const re = valid && valid.source ? new RegExp(`(${valid.source})`, flags) : null;
  if (!re) return null;
  // 按序抽取全部标签逐题对位(2026-11-10 二次审计 P1-11.3):旧实现把首标签赋给全部题目,
  // 多题分片时后序题被"张冠李戴";无对应标签的题沿用最后一个已见标签(兼容整批同答的退化语义)。
  const found = [];
  let m;
  const cap = Math.max((items || []).length * 2, 8);
  while ((m = re.exec(s)) !== null && found.length < cap) {
    found.push(m[1]);
    if (m.index === re.lastIndex) re.lastIndex += 1; // 零宽匹配防死循环
  }
  if (!found.length) return null;
  const answers = {};
  (items || []).forEach((it, i) => {
    const choice = found[i] || found[found.length - 1];
    answers[`q${i + 1}`] = { type: 'choice', choice, confidence: 0.5, probabilities: {} };
  });
  return { answers };
}

/** 按 cfg.modelIn 定夺后端名:ollama | local。远端 in cfg 不存在旧的本地配置一律按 local。 */
export function localBackendOf(cfg) {
  return cfg && cfg.modelIn === 'ollama' ? 'ollama' : 'local';
}

/** systemone 不可用标记:端点 404(老版本 Ollama 无此路由)后一段时间内不再重试,直接走文本生成回退。
 *  S2-F4(2026-11-10 夜审):原恒 true 进程内永久粘性——Ollama 热升级/换版本后端点回来也永不恢复;
 *  改时间戳 + TTL,窗口过后自动重探自愈。 */
let systemoneUnsupportedAt = 0;
const SYSTEMONE_STICKY_TTL_MS = 10 * 60 * 1000;

/** 判定分片(systemone 协议):POST {base}/v1/systemone → {answers:{qN:{choice,probabilities,confidence}}}。
 *  成功返回 {shaped,usage},失败 null。 */
async function runChunkSystemone({ items, criteria, valid, modelName, fetchFn, ollamaBase, retries, timeoutMs }) {
  const body = buildSystemoneBody({ items, criteria, model: modelName });
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchFn(`${ollamaBase}${SYSTEMONE_LOCAL_PATH}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.status === 404) { systemoneUnsupportedAt = Date.now(); return null; }
      if (!resp.ok) continue;
      const j = await resp.json();
      const shaped = shapeAnswers(j, valid);
      if (shaped && Object.keys(shaped.answers || {}).length) return { shaped, usage: j.usage || null };
    } catch { /* 单次失败重试 */ }
  }
  return null;
}

/** 本地判定分片:ollama generate(文本+JSON 解析)。成功返回 {text} 原始文本,失败 null。 */
async function runChunk({ items, criteria, valid, modelName, fetchFn, ollamaBase, retries, timeoutMs }) {
  // decision 能力模型(tev1:0.8b)只吃 systemone;普通 LLM 判定模型才走文本生成(端点 404 后 10 分钟降级,过期重探)。
  if (!(Date.now() - systemoneUnsupportedAt < SYSTEMONE_STICKY_TTL_MS)) {
    const sys = await runChunkSystemone({ items, criteria, valid, modelName, fetchFn, ollamaBase, retries, timeoutMs });
    if (sys) return sys;
  }
  const prompt = buildLocalPrompt({ items, criteria });
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchFn(`${ollamaBase}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName, prompt, stream: false, format: 'json', think: false,
          options: { num_predict: 200, ...gpuOptions() },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) continue;
      const j = await resp.json();
      const r = String(j && j.response ? j.response : '');
      if (j && j.done === false) continue;
      if (!r) continue;
      const shaped = shapeAnswers(extractJson(r), valid)
        || fallbackFromText(r, items, valid);
      if (shaped) return { text: r };
    } catch { /* 单次失败重试 */ }
  }
  return null;
}

/** Decision2 打分(ONNX/local 路径):一题一判,选项=criteria 的 label→description。返回归一答案或 null。 */
async function scoreItemResident({ item, criteria, valid, timeoutMs }) {
  const options = Object.entries(criteria || {}).map(([key, description]) => ({ key, description: String(description) }));
  if (options.length < 2) return null;
  const d = await residentDecide({
    context: '你是任务分档判定器,只从给定选项中选一个最贴切的标签,并给出各选项置信概率。',
    question: String(item.text || '').slice(0, 1200),
    options,
  }, timeoutMs);
  if (!d) return null;
  const probs = {};
  let best = null;
  let bestP = -1;
  d.keys.forEach((k, i) => {
    probs[k] = Number(d.probabilities[i] ?? 0);
    if (probs[k] > bestP) { bestP = probs[k]; best = k; }
  });
  if (!best) return null;
  if (valid instanceof RegExp && !valid.test(best)) return null;
  return { choice: best, confidence: Number(bestP.toFixed(4)), probabilities: probs };
}

/** 决策模型预热(systemone 协议):decision 能力模型加载即驻留,成功返回 {ok:true,endpoint}。 */
export async function warmDecisionModel({ base, model, fetchFn = fetch, timeoutMs = 60000 } = {}) {
  if (!base || !model) return { ok: false, error: '缺少 base/model' };
  const body = buildSystemoneBody({ items: [{ id: 1, text: 'warm' }], criteria: { yes: '是', no: '否' }, model });
  try {
    const resp = await fetchFn(`${base}${SYSTEMONE_LOCAL_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    const j = await resp.json();
    const shaped = shapeAnswers(j, null);
    if (!shaped || !Object.keys(shaped.answers || {}).length) {
      return { ok: false, error: '无答案(该模型不支持 systemone 判定)' };
    }
    return { ok: true, endpoint: `${base}${SYSTEMONE_LOCAL_PATH}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 本地批量判定(单机版 judgeBatch):ollama 恒并发 1(单服务串行),local 常驻同为串行。
 * 分片粒度由调用方(decisionModel.judgeBatch)切好:items 已是分片列表,每片一次判定。
 * 只做透传+形状把关,**值域四防线仍由调用方 parseAnswers 做**(本模块不 import decisionModel,无环)。
 * 返回 {rawChunks:[{chunk,text}], usage, latencyMs, endpoint, chunks, failedChunks, error?, backend}。
 * config 缺省 loadConfig();fetchFn 可注入(测试,ollama 路径用)。
 */
export async function judgeLocal({ items, criteria = null, valid = null, config = null, fetchFn = fetch, timeoutMs = 30000, retries = 1 } = {}) {
  if (!items || !items.length) return { rawChunks: [], usage: null, backend: 'local:未触发' };
  // S12-C13(2026-11-10 夜审落地):判定热路径禁用 process.exit——坏 config 时判定层返回 error,
  // 上层(modelRouteProxy catch)fail-open 到词法定档;CLI 面 loadConfig 默认仍硬 exit 提醒修复。
  const base = loadConfig({ soft: true });
  if (base._configError) return { rawChunks: [], usage: null, latencyMs: 0, endpoint: null, chunks: items.length, failedChunks: items.length, retriedChunks: 0, backend: 'local:配置损坏', error: `config 解析失败(${base._configError}):判定不可用,fail-open` };
  // 传入的 config 常是 data JSON 局部对象(无 models/modelIn/ollamaBase 键),与默认配置合并补齐(2026-11-08 修)
  const cfg = config ? { ...base, ...config } : base;
  const isOllama = localBackendOf(cfg) === 'ollama';
  const modelName = isOllama ? (cfg && cfg.models && cfg.models.decision) : (cfg && cfg.models && cfg.models.localDecision);
  const ollamaBase = isOllama ? String((cfg && cfg.ollamaBase) || 'http://localhost:11434').replace(/\/+$/, '') : null;
  if (!modelName) return { rawChunks: [], error: 'config.mjs 未配置本地决策模型名(decision/localDecision)', backend: 'local:未配置' };
  // 批量嵌入让行(2026-11-10):ollama 单队列,重嵌期间判定票主动跳过——带上 skipped 标记,
  // 调用方据此**不触发断路器**(忙跳过≠故障),三票照常、完全离线可签。
  if (isOllama && embedBusy()) {
    return { rawChunks: [], usage: null, latencyMs: 0, endpoint: null, chunks: items.length, failedChunks: items.length, retriedChunks: 0, backend: `ollama:${modelName}`, error: EMBED_BUSY_REASON, skipped: true };
  }
  const started = Date.now();
  const rawChunks = [];
  let failedChunks = 0;
  let usage = null;
  for (const chunk of items) {
    if (ollamaBase) {
      const got = await runChunk({ items: chunk, criteria, valid, modelName, fetchFn, ollamaBase, retries, timeoutMs });
      if (!got) { failedChunks += 1; continue; }
      // 只透传原始文本:分片 id 还原与值域四防线由调用方(decisionModel.parseAnswers)统一做
      rawChunks.push({ chunk, text: got.text || '', shaped: got.shaped || null });
      if (got.usage) {
        usage = {
          input_tokens: (usage?.input_tokens || 0) + (got.usage.input_tokens || 0),
          output_tokens: (usage?.output_tokens || 0) + (got.usage.output_tokens || 0),
        };
      }
      continue;
    }
    // ONNX Decision2 打分路径:每 item 一次前向(一题一判),直接给归一答案图
    const shaped = { answers: {} };
    let answered = 0;
    for (const [i, item] of chunk.entries()) {
      const a = await scoreItemResident({ item, criteria, valid, timeoutMs });
      if (!a) { failedChunks += 1; continue; }
      shaped.answers[`q${i + 1}`] = { type: 'choice', id: i + 1, ...a };
      answered += 1;
    }
    if (answered) rawChunks.push({ chunk, shaped });
  }
  const backend = isOllama ? `ollama:${modelName}` : `local:${modelName}`;
  const endpoint = ollamaBase ? `${ollamaBase}${SYSTEMONE_LOCAL_PATH}` : 'http://127.0.0.1:(resident)/decision';
  const elapsed = Date.now() - started;
  if (rawChunks.length === 0) {
    return { rawChunks: [], usage: null, latencyMs: elapsed, endpoint, chunks: items.length, failedChunks, retriedChunks: 0, backend, error: `本地决策模型不可用(${modelName}):${ollamaBase ? 'Ollama 未就绪或模型未 pull(decision 能力模型只走 systemone 端点)' : 'local 常驻进程未就绪(重跑 node init.mjs 或 node warm.mjs 预热)'}` };
  }
  return { rawChunks, usage, latencyMs: elapsed, endpoint, chunks: items.length, failedChunks, retriedChunks: 0, backend };
}