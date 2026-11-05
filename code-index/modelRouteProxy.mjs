/**
 * 动态模型路由·本地代理(model-routing.md 执行层最终形态):
 * ZCode 主会话的所有请求经本代理转发,按 turn 分类改写 model 字段——
 * 客户端交互与正常会话完全一致(同会话、同上下文、无确认窗),仅后台决定由哪个模型执行。
 *
 * 协议适配层(2026-11-01 重构):线上协议(Anthropic Messages / OpenAI Chat Completions)全部
 * 收敛到 PROTOCOL_ADAPTERS 的适配器对象里——端点识别、turn 检测、会话键材料、鉴权头、
 * usage 提取、请求体准备各一个钩子;决策内核(decideTarget/pickUpstream/健康冷却/记账)
 * 不感知协议,新增接口规范=新增一个适配器,核心零改动。
 *
 * 双端隔离(2026-11-04):/apps/qoder=Qoder 宿主、其余(/apps/anthropic)=ZCode;快照逐供应商带 host 标签,
 * 各宿主只在自己的路由清单里决策(auto 不再混入另一端配置的模型);旧快照无标签退回合并池,重抓后自动隔离。
 *
 * 策略(默认,保守;与协议无关;2026-11-03 用户终裁:role 两档制已废,tier 四档难度制唯一):
 *   - 四档难度路由:classifyDifficulty 定档(R1 日常主力/R2 增强能力/R3 最强=仅 P2 上梯/R4 奢侈=仅显式点名)→ resolveTier
 *     从目标档沿 R4→R3→R2→R1 降档级联,档内按品牌优先序+档位序数滑动。
 *   - 新的人类 turn(最后一条消息是用户文本,非工具结果):
 *       难度 R2-R4 → resolveTier 解析该档模型并建立"阶段"(state Map 按会话驻留);
 *       难度 R1 且 sticky 基准在 R2-R4 → 降档换到 R1 档模型(2026-11-04;不建阶段、终结现有阶段);
 *       歧义轮(难度判定的"无信号兜底/过短"R1,confidence ≤0.5,2026-11-04 用户定策)跳过 R1 宽限,
 *       立即降档到 R1 档模型——"评审有歧义就判定为便宜档";明确 R1 轮(提问/杂务/单点编辑,置信≥0.6)宽限照旧;
 *       难度 R1 且基准已在 R1(auto 会话基准/自定义 R1 模型)或判不出档位 → 保持请求原模型(sticky);
 *       阶段内后续人类轮 → 沿用阶段档(反复升降每轮各付一次切换税,#3),R1 或轮数到顶即收尾。
 *       客户端只能选 auto 虚拟档,不能人工指定档位。
 *   - 工具续接(最后一条是工具结果):阶段内沿用本阶段模型,否则 sticky。
 *   - 证据升级(P2,2026-11-04 逐级上梯):连续 2 个工具轮含报错 tool_result → 从当前服务档上梯一档
 *     (R1→R2→R3 封顶 R3,不越级——资费语义"R2 明确无法解决才上 R3";上梯成功 errStreak 清零重新积累;
 *     受切换税门控,门控抑制不标记下轮重试;目标档不可达则本轮沿用现档)。
 *   - 切换税门控(modelRouting.switchGuard.enabled,默认 true,2026-11-05 用户定档):估算上下文 tokens(标定口径 bytes/3.2)
 *     超阈值时不升档——**只拦升档**(2026-11-04 成本复算修正#5:降档当轮即省钱,拦降档是纯自伤),
 *     R1 降档一律放行。阈值 200000 tokens(≈640KB 请求体),只在极厚上下文才拦。
 *     R1↔R3 交替振荡(自定义 R2-R4 基准 + 难度交替,每轮各付一次冷读)由"档内滑链 + 缓存热窗口"承接,
 *     不做迟滞(hysteresis)——迟滞会让真正的 R1 杂务轮继续跑高价档,方向比策略更重要。
 *   - 运行时 429/5xx/连接失败(netError)同轮重选:失败轮同轮冷却失败模型→重跑 resolveTier(档内滑/降档)
 *     →换模型重发;2xx 只要带正常对话载荷即视为干净成功(助手正文里讨论报错不冷却模型,2026-11-04 修复)。
 * 记账:每次请求落 data/usage/proxy-usage.jsonl(实际服务模型/用量/门控与冷却结果),解决"记账失真"。
 *
 * CLI:node modelRouteProxy.mjs --port 8117 [--upstreams-file data/routing/proxy-upstreams.json]
 *     --snapshot-upstreams(从 provider_config 抓真实 baseUrl/key 快照,切 baseUrl 前先跑一次)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { classifyPrompt } from './classify.mjs';
import { classifyDifficulty, loadTierCalibration } from './tierClassify.mjs';
import { readHealth, markHealth as markHealthCool, clearHealth, isProxyReachable, inventoryFromUpstreams, ingressProviders, deriveTierChains, resolveTier, tierOfModel, logTierShadow, DEFAULT_BRAND_PRIORITY } from './modelRoute.mjs';

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const HOME = os.homedir();
const UPSTREAMS_FILE = path.join(DATA_DIR, 'routing', 'proxy-upstreams.json');
const PROXY_USAGE_LOG = path.join(DATA_DIR, 'usage', 'proxy-usage.jsonl');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// 阶段/切换税策略默认值:门控默认开启(2026-11-05 用户定档——极厚上下文升档的冷读税不值得付,默认拦;
// 要放行改 data 配置 switchGuard.enabled=false),阶段轮数上限恒生效。
// maxPhaseTurns(2026-11-04 迁移):语义属阶段生命周期、不受门控开关控制,配置新家=modelRouting.maxPhaseTurns
// (旧位置 switchGuard.maxPhaseTurns 仍兼容读取);此处保留作为 decideTarget 无配置时的兜底默认。
const DEFAULT_GUARD = { enabled: true, maxContextTokens: 200000, maxPhaseTurns: 4 };

// 门控疲劳放行(2026-11-05 用户定档):同会话被门控连续拦截满 N 次 ⇒ 放行一次升档(证据消耗,计数随新阶段归零)。
// 疲劳 = "反复想升档却一直被拦"的会话级证据,兜住 R1 干完了但质量差、无 P2 报错信号的场景;
// 缓存冷(>5min 空闲,新工作会话)或上下文已压缩(比首次拦截缩水 >30%)则清零重新攒。
const GATE_FATIGUE_RELEASE = 3;
const GATE_COMPRESS_RATIO = 0.7;

// 缓存热窗口(修正#4):显式缓存有效期 5min 确定性过期;隐式缓存 TTL 不确定,按同值保守处理。
// 距上一轮超过该窗口 → 宽限/粘住偏好全部关闭(热缓存假设不成立,换档不再有额外税,黏旧档只是多花钱)。
const CACHE_TTL_MS = 5 * 60 * 1000;

// 冷却 TTL 分级(2026-11-03 用户定档,按错误性质而非单纯状态码;从低到高 5min/30min/2h/5h):
//   transient 临时限流/并发超限/引擎过载/超时/5xx(可重试,很快恢复)                              → 5min
//   billing   配额耗尽/余额不足/欠费等账单问题(需充值或等额度重置;含裸 429 观察期默认)            → 30min
//   config    配置错误导致模型不通(模型不存在/拼错/下线/未开通、Key 无效或过期、无权访问、地区受限)→ 2h
//   unknown   未知错误兜底(≥400 且带错误信封但无法归类的其它错误响应)                            → 5h
// 客户端请求内容错(参数缺失/JSON 非法/上下文超限/内容安全拦截/方法不允许)不冷却——那是请求方的问题,
// 拉黑模型无济于事,反而会误伤健康模型(见 shouldCoolDown 的 CLIENT_FAULT 兜底)。
const COOL_TTL = { config: 2 * 60 * 60 * 1000, transient: 5 * 60 * 1000, billing: 30 * 60 * 1000, unknown: 5 * 60 * 60 * 1000 };

// 渐进退避上限(2026-11-04):同一 provider/model 连续失败 N 次,冷却=基础 TTL×2^(N-1),按族封顶。
// 目的:额度墙等持久故障不再每 30min 被"探"一次(每次探测连带一次滑档冷读,R2 ≈6.2M R1 等效);
// config/unknown 封顶=基础值(确定性错误探测成本低,过久冷却反而延迟恢复)。成功服务一次即清零(见转发成功路径)。
const COOL_CAP = { config: 2 * 60 * 60 * 1000, transient: 60 * 60 * 1000, billing: 8 * 60 * 60 * 1000, unknown: 5 * 60 * 60 * 1000 };
// billing 族(配额墙)直降映射(2026-11-04 用户定案):额度耗尽时跳过同档同价重试,从低一档重解析。
const NEXT_LOWER_TIER = { R1: 'R1', R2: 'R1', R3: 'R2', R4: 'R3' };

/** 冷却 TTL:按错误族分级;未知族名兜底到 unknown(5h)。 */
export function coolTtlMs(kind) {
  return COOL_TTL[kind] || COOL_TTL.unknown;
}

// 阶段驻留:空闲 30 分钟即视为另起会话,阶段表上限 200 条(超出按最旧淘汰)——旧实现用 hash%65535
// 且永不回收,理论上跨会话碰撞、且长跑进程里单调累积(H6)。
const PHASE_IDLE_MS = 30 * 60 * 1000;
const PHASE_MAX = 200;

// ---------- 协议适配层 ----------
// 适配器契约(全部为纯函数/纯数据变换,不碰网络):
//   isChatRequest(url)              识别本协议的对话端点(决策门);null 分派=透传不改写
//   lastMessageKind(messages)       'human'(新人类轮) | 'tool'(工具续接) | 'other'
//   lastHumanText(messages)         最后一条人类消息文本(L1 分类输入)
//   convKeyMaterial(bodyObj, url)   会话键材料串(核心负责 hash 入桶)
//   prepareBody(bodyObj)            转发前的请求体准备(anthropic=原样;openai=流式补 include_usage)
//   upstreamHeaders(apiKey)         发往真实上游的鉴权/协议头
//   grabUsage(sseData, acc)         流式:从一条解析后的 SSE data 对象提取用量/实际模型入 acc
//   grabBodyUsage(bodyObj, acc)     非流式:从整包响应体提取用量/实际模型入 acc
//   countToolErrors(messages)       证据升级(P2):最后一条 user 消息里 is_error 的 tool_result 数(本轮新到的报错)
// acc 为归一化累积器 {inTok,outTok,cacheRead,cacheWrite,cacheReported,usageRaw,served},
// 落账字段名与 proxy-usage.jsonl 消费端约定,不随协议变。

/** Anthropic Messages 协议适配器(ZCode 现网路径,行为与重构前逐字节一致)。 */
/** 剥离宿主注入的 <system-reminder>…</system-reminder> 样板块:难度/L1 分类只应看用户真实提问,
 *  样板固定词表会把"今天天气怎么样"这类纯问答误升档(2026-11-04 实弹账本抓到 R2 误判)。
 *  只影响分类输入与审计 promptHead,转发体原样不动;剥完为空 → 空串(分类器按过短回落 R1)。 */
export function stripHostReminders(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .trim();
}

export const anthropicAdapter = {
  name: 'anthropic',
  isChatRequest(url) { return typeof url === 'string' && url.endsWith('/v1/messages'); },
  lastMessageKind(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      const c = m.content;
      if (typeof c === 'string') return 'human';
      if (Array.isArray(c)) {
        if (c.some((b) => b && b.type === 'tool_result')) return 'tool';
        if (c.some((b) => b && b.type === 'text')) return 'human';
      }
      return 'other';
    }
    return 'other';
  },
  lastHumanText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      const c = m.content;
      if (typeof c === 'string') return stripHostReminders(c);
      if (Array.isArray(c)) {
        const t = stripHostReminders(c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n'));
        if (t) return t;
      }
    }
    return '';
  },
  convKeyMaterial(bodyObj, reqUrl = '') {
    const first = bodyObj?.messages?.[0]?.content;
    const sys = Array.isArray(bodyObj?.system) ? JSON.stringify(bodyObj.system) : String(bodyObj?.system || '');
    return `${typeof first === 'string' ? first : JSON.stringify(first || '')}|${sys.slice(0, 400)}|${reqUrl}`;
  },
  prepareBody(bodyObj) { return bodyObj; },
  upstreamHeaders(apiKey) {
    return { 'x-api-key': apiKey, 'authorization': `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' };
  },
  grabUsage(d, acc) {
    if (d?.message?.usage) { anthropicGrab(d.message.usage, acc); acc.served = d.message.model || acc.served; }
    else if (d?.usage) anthropicGrab(d.usage, acc);
  },
  grabBodyUsage(d, acc) {
    if (d?.usage) anthropicGrab(d.usage, acc);
    if (d?.model) acc.served = d.model || acc.served;
  },
  countToolErrors(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      // 只看最后一条 user 消息(≈本轮新到的工具结果):历史报错不得把 streak 永远顶满
      return Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'tool_result' && b.is_error).length : 0;
    }
    return 0;
  },
};

function anthropicGrab(u, acc) {
  acc.usageRaw = u;
  // 上游是否真的回报了缓存段?没有这一位就分不清"冷读(真没命中)"与"网关不报缓存字段"(H7)
  if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u || 'cache_read' in u || 'cache_creation' in u) acc.cacheReported = true;
  acc.inTok = num(u.input_tokens) ?? acc.inTok;
  acc.cacheRead = num(u.cache_read_input_tokens) ?? acc.cacheRead;
  acc.cacheWrite = num(u.cache_creation_input_tokens) ?? acc.cacheWrite;
  acc.outTok = num(u.output_tokens) ?? acc.outTok;
}

/**
 * OpenAI Chat Completions 协议适配器(Cursor 自定义 API 等 OpenAI 兼容接入面)。
 * 注意(2026-11-05 账本实证):Qoder 条目虽为 openai-compatible 类型,但条目 protocol=anthropic——
 * 实际流量 95/98 走 /apps/qoder/v1/messages(anthropicAdapter),chat/completions 仅人工探针。
 * 状态:单测覆盖(消息形态/会话键/usage 映射/端到端改写记账);真实 OpenAI 兼容网关未实弹验证。
 * 语义对应:role:"tool" 消息 ↔ Anthropic user 消息内 tool_result 块;system/developer 消息 ↔ 顶层 system 字段。
 */
export const openaiAdapter = {
  name: 'openai',
  isChatRequest(url) { return typeof url === 'string' && url.endsWith('/chat/completions'); },
  lastMessageKind(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'tool') return 'tool';
      if (m.role === 'user') {
        const c = m.content;
        if (typeof c === 'string') return 'human';
        if (Array.isArray(c) && c.some((b) => b && b.type === 'text')) return 'human';
        return 'other';
      }
      return 'other';
    }
    return 'other';
  },
  lastHumanText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      const c = m.content;
      if (typeof c === 'string') return stripHostReminders(c);
      if (Array.isArray(c)) {
        const t = stripHostReminders(c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n'));
        if (t) return t;
      }
    }
    return '';
  },
  convKeyMaterial(bodyObj, reqUrl = '') {
    const msgs = Array.isArray(bodyObj?.messages) ? bodyObj.messages : [];
    const sys = msgs.find((m) => m && (m.role === 'system' || m.role === 'developer'));
    const firstUser = msgs.find((m) => m && m.role === 'user');
    const s = sys ? (typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content || '')) : '';
    const f = firstUser ? (typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content || '')) : JSON.stringify('');
    return `${f}|${s.slice(0, 400)}|${reqUrl}`;
  },
  // 流式要在请求里显式要 usage,末 chunk 才回 prompt_tokens/completion_tokens(OpenAI 语义)
  prepareBody(bodyObj) {
    if (bodyObj?.stream === true) return { ...bodyObj, stream_options: { ...(bodyObj.stream_options || {}), include_usage: true } };
    return bodyObj;
  },
  upstreamHeaders(apiKey) {
    return { 'authorization': `Bearer ${apiKey}` };
  },
  grabUsage(d, acc) {
    if (d?.usage) openaiGrab(d.usage, acc);
    if (d?.model) acc.served = acc.served || d.model;
  },
  grabBodyUsage(d, acc) {
    if (d?.usage) openaiGrab(d.usage, acc);
    if (d?.model) acc.served = d.model || acc.served;
  },
  // OpenAI 协议的工具报错形态(2026-11-05 修,打通 Cursor 等 openai 接入面的 P2 证据升级;
  // Qoder 主流量走 anthropic 路径原本就通,本实现服务 openai 格式接入面):
  // role:"tool" 消息无结构化 is_error,只能按内容形态认——
  //   ① content 是 JSON 且带 error/errno 字段(结构化失败,最可靠);
  //   ② 文本命中报错形态(ERROR_SHAPE_RE 同款:堆栈帧/异常类名/errno/panic/timeout)。
  // 计数与 anthropic 同口径:**最后一条消息是 tool 才查**(本轮新到的工具结果);
  //   末尾是人话轮(报错后用户已插话)→ 0,历史报错不顶满 streak。
  // 保守性:宁可漏认(0)不可误认——误认会把正常工具输出当失败,凭空烧一次升档冷读。
  countToolErrors(messages) {
    const last = messages && messages.length ? messages[messages.length - 1] : null;
    if (!last || last.role !== 'tool') return 0;
    // 末尾连续的 tool 消息组(parallel tool calls 同轮落多条)
    let j = messages.length - 1;
    let errs = 0;
    while (j >= 0 && messages[j] && messages[j].role === 'tool') {
      if (openaiToolLooksError(messages[j])) errs += 1;
      j -= 1;
    }
    return errs;
  },
};

/** OpenAI role:"tool" 消息是否形似报错(无 is_error 标记下的保守形态判定)。 */
function openaiToolLooksError(m) {
  const c = m && m.content;
  const text = typeof c === 'string' ? c : Array.isArray(c)
    ? c.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n')
    : '';
  if (!text.trim()) return false;
  // 结构化失败:content 是 JSON 且带 error/errno 字段(error 值非空才算)
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      if (j.error) return true;
      if (Number.isFinite(Number(j.errno)) && Number(j.errno) !== 0) return true;
      return false;
    }
  } catch { /* 非 JSON 走形态判定 */ }
  return OPENAI_TOOL_ERROR_RE.test(text);
}

/** 与 classify.mjs 的 ERROR_SHAPE_RE 同款形态(本模块自持一份,避免钩子冷启动拖进分类器模块):
 *  堆栈帧/异常类名/errno 常量/panic/超时/连接拒绝。 */
const OPENAI_TOOL_ERROR_RE = /\b(TypeError|ReferenceError|SyntaxError|RangeError|NullPointerException|ParseException)\b|\bTraceback \(most recent call last\)|\bat .+:\d+:\d+|\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EACCES|EPERM|EPIPE)\b|\bError:\s|\bpanic:\s|\bException in thread|\btimeout of \d+ms exceeded|\bexit code [1-9]/i;

function openaiGrab(u, acc) {
  acc.usageRaw = u;
  // 缓存段判定:官方在 prompt_tokens_details.cached_tokens;部分兼容网关沿用 anthropic 风格字段名,一并认
  if ((u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' && 'cached_tokens' in u.prompt_tokens_details)
    || 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) acc.cacheReported = true;
  acc.inTok = num(u.prompt_tokens) ?? num(u.input_tokens) ?? acc.inTok;
  acc.outTok = num(u.completion_tokens) ?? num(u.output_tokens) ?? acc.outTok;
  acc.cacheRead = num(u.prompt_tokens_details?.cached_tokens) ?? num(u.cache_read_input_tokens) ?? acc.cacheRead;
  acc.cacheWrite = num(u.cache_creation_input_tokens) ?? acc.cacheWrite;
}

const PROTOCOL_ADAPTERS = [anthropicAdapter, openaiAdapter];

/** 按请求 URL 分派协议适配器;无可匹配端点返回 null(该请求透传不改写)。 */
export function pickProtocolAdapter(url) {
  for (const a of PROTOCOL_ADAPTERS) if (a.isChatRequest(url)) return a;
  return null;
}

// 便捷导出(Anthropic 口径,测试与既有消费者使用;服务端走 pickProtocolAdapter 分派)
export function lastMessageKind(messages) { return anthropicAdapter.lastMessageKind(messages); }
export function lastHumanText(messages) { return anthropicAdapter.lastHumanText(messages); }

/** 会话键:协议材料串 → hash 入 2^24 桶。 */
export function convKeyOf(bodyObj, reqUrl = '', adapter = anthropicAdapter) {
  return Math.abs(hash(adapter.convKeyMaterial(bodyObj, reqUrl))) % 0xffffff;
}

/** 阶段表回收:空闲超限删除,超量按最旧淘汰。 */
export function prunePhases(state, now = Date.now(), { idleMs = PHASE_IDLE_MS, max = PHASE_MAX } = {}) {
  for (const [k, v] of state) if (!v || !(Number(v.at || 0) > now - idleMs)) state.delete(k);
  if (state.size > max) {
    const entries = [...state.entries()].sort((a, b) => (Number(a[1]?.at || 0) - Number(b[1]?.at || 0)));
    for (const [k] of entries.slice(0, state.size - max)) state.delete(k);
  }
  return state.size;
}

// ---------- upstream 快照与解析 ----------

/**
 * 从 ZCode provider_config 抓真实 baseUrl/key/模型清单快照(切 baseUrl 前运行一次)。
 * 幂等合并:baseUrl 已指向本代理(127.0.0.1)的供应商 = 入口供应商,真实上游从**上一次快照**继承
 * (切 baseUrl 后 provider_config 里已无真实地址,不继承就会丢失转发目标)——此前直接跳过这类条目,
 * 导致代理不知道自己是从哪个供应商进来的,sticky 请求只能按模型名"第一个持有者"乱发(H1/H4 根因)。
 */
/** 供应商清单(2026-11-02 双端):Qoder 的自定义模型在 ~/.qoder-cn/settings.json 的 providers 键,形态不同——
 *  {baseUrl, apiKey, models:[{model,...}]}(对象数组、模型名在 .model 字段)。 */
function readQoderProviders(home = HOME) {
  const out = [];
  for (const dir of ['.qoder-cn', '.qoder']) {
    const j = readJson(path.join(home, dir, 'settings.json'));
    if (!j?.providers) continue;
    out.push(...Object.entries(j.providers).map(([id, p]) => ({
      providerId: `qoder:${id}`,
      baseUrl: String(p?.baseUrl || '').replace(/\/+$/, ''),
      apiKey: p?.apiKey || '',
      models: (Array.isArray(p?.models) ? p.models : []).map((m) => (typeof m === 'string' ? m : m?.model)).filter(Boolean),
      enabled: true, // Qoder 无 enabled 键,存在即启用
      qoder: true,
    })));
  }
  return out;
}

export function snapshotUpstreams({ home = HOME, outFile = UPSTREAMS_FILE } = {}) {
  const pc = readJson(path.join(home, '.zcode', 'v2', 'provider_config.json'));
  const old = readJson(outFile) || { providers: {} };
  const providers = {};
  const ingress = [];
  const zcodeRules = pc?.config?.providerConfigRules?.providerRules || [];
  // 单模型开关(2026-11-05):ZCode 关掉厂商下某个模型 = modelConfigRules.providerModelRules 里该条 enabled:false;
  // personalModelIds 不随单模型开关变化 ⇒ 快照必须自己读这份表过滤,否则关掉的模型仍被 auto 路由调用。
  // 键=providerId/modelId;Qoder 端无此表,维持"存在即启用"。
  const modelEnabled = new Map();
  for (const x of pc?.config?.modelConfigRules?.providerModelRules || []) {
    if (x?.providerId && x?.modelId) modelEnabled.set(`${x.providerId}/${x.modelId}`, x.config?.enabled !== false);
  }
  const zcodeModelEnabled = (pid, m) => modelEnabled.has(`${pid}/${m}`) ? modelEnabled.get(`${pid}/${m}`) : true;
  // Qoder 条目:providerId 加 qoder: 前缀防与 ZCode 冲突;虚拟条目(tokenSaverModel/qoder auto 档)不重复快照
  // 双端隔离(2026-11-04 用户定档):每条供应商带 host 标签,代理按请求路径前缀
  // (/apps/qoder=Qoder,其余=ZCode)只在该宿主自己的清单里路由,互不混池。
  const all = [
    ...zcodeRules.map((r) => ({ rule: r, host: 'zcode' })),
    ...readQoderProviders(home).map((r) => ({ rule: r, host: 'qoder' })),
  ];
  for (const { rule: r, host } of all) {
    const raw = (r.config?.api?.baseUrl || r.baseUrl || '').replace(/\/+$/, '');
    if (!raw) continue;
    const models = r.config?.personalModelIds || r.models || [];
    const pid = r.providerId;
    // auto 虚拟档(客户端只选它):不进快照的 models(它不是可转发模型),但仍是入口
    let base = raw;
    let apiKey = r.config?.access?.apiKey || r.apiKey || '';
    let isIngress = false;
    if (raw.includes('127.0.0.1')) {
      const prev = old.providers?.[pid];
      if (!prev || !prev.baseUrl || prev.baseUrl.includes('127.0.0.1')) continue; // 无从恢复真实上游,跳过
      base = prev.baseUrl;
      apiKey = prev.apiKey || apiKey;
      isIngress = true;
    }
    const listed = models.filter((m) => m !== AUTO_MODEL);
    providers[pid] = {
      baseUrl: base,
      apiKey,
      anthropic: base.endsWith('/anthropic'),
      models: host === 'zcode' ? listed.filter((m) => zcodeModelEnabled(pid, m)) : listed,
      enabled: r.enabled !== false,
      host, // 双端隔离:zcode|qoder(2026-11-04)
      ...(isIngress ? { ingress: true } : {}),
    };
    if (isIngress) ingress.push(pid);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ version: 4, snapshottedAt: Date.now(), providers, ingress }, null, 1) + '\n');
  return { providers: Object.keys(providers).length, ingress, outFile };
}

/**
 * 双端隔离(2026-11-04 用户定档):按请求宿主过滤路由清单(host=zcode|qoder)。
 * 旧快照无 host 标签的条目两端通用(兼容未刷新部署,重抓快照后自动隔离);
 * ingress 数组同步过滤,只留本宿主存活条目。
 */
export function upstreamsForHost(upstreams, host) {
  const providers = {};
  for (const [pid, p] of Object.entries(upstreams?.providers || {})) {
    if (p && (!p.host || p.host === host)) providers[pid] = p;
  }
  const ingress = (Array.isArray(upstreams?.ingress) ? upstreams.ingress : []).filter((pid) => providers[pid]);
  return { ...(upstreams || { providers: {} }), providers, ingress };
}

/** model → 拥有它的供应商条目(真实 upstream),不含指向代理自身的条目。 */
export function resolveUpstreamForModel(model, upstreams) {
  for (const [providerId, p] of Object.entries(upstreams.providers || {})) {
    if ((p.models || []).includes(model) && p.enabled !== false && p.apiKey) {
      return { providerId, ...p };
    }
  }
  return null;
}

/**
 * 选转发目标。优先级:
 *   ① 决策钉住的供应商(存在 + enabled + 有 key + 持有该模型);
 *   ② **入口供应商**(客户端把 baseUrl 切到代理的那几个)——请求必经它进来,sticky 请求就该钉它,
 *      绝不按模型名"快照键序第一个持有者"漂到别人的账户(H1);
 *   ③ 模型不在入口清单(客户端自选了入口供应商没列的模型)→ 仍发给入口供应商的真实上游,
 *      让"这个账号没有这个模型"的错误由它自己返回,**绝不越权打到另一个账户**(H4);
 *   ④ 无入口信息(未切 baseUrl 的裸用场景)→ 退回按模型名找持有者。
 */
export function pickUpstream({ providerId, model, upstreams } = {}) {
  const ups = upstreams?.providers || {};
  const ingress = ingressProviders(upstreams);
  const ok = (id) => {
    const p = ups[id];
    return p && p.enabled !== false && !!p.apiKey ? p : null;
  };
  if (providerId) {
    const p = ok(providerId);
    if (p && (p.models || []).includes(model)) return { providerId, ...p };
    for (const id of ingress) {
      const q = ok(id);
      if (q && (q.models || []).includes(model)) return { providerId: id, ...q };
    }
    return resolveUpstreamForModel(model, upstreams) || fallbackUpstream(upstreams);
  }
  for (const id of ingress) {
    const q = ok(id);
    if (q && (q.models || []).includes(model)) return { providerId: id, ...q };
  }
  if (ingress.length) {
    const q = ok(ingress[0]);
    if (q) return { providerId: ingress[0], ...q, modelNotListed: true };
  }
  return resolveUpstreamForModel(model, upstreams) || fallbackUpstream(upstreams);
}

/**
 * 门控通知文件 data/usage/gate-notice.json(2026-11-05):prompt-guard 据此在拦截连击中注入一次压缩建议。
 * 代理只在两类事件写:拦截(count/est 锚点;count===1 视为新连击,重置 suggested 注入标记)与疲劳放行(released)。
 * 钩子注入后回写 suggested=true ⇒ 同一连击不重复注入;上下文压缩后连击从 1 重新计数 ⇒ suggested 自然复位。
 * 单用户单文件,最新连击覆盖(多会话同拦时建议可能落进另一会话,可接受)。
 */
export function updateGateNotice({ dataDir = DATA_DIR, decision = null, est = 0, now = Date.now() } = {}) {
  const file = path.join(dataDir, 'usage', 'gate-notice.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { prev = {}; }
  if (decision && decision.suppressed === 'switch-tax') {
    const count = Number(decision.nextPhase?.suppressedCount) || 1;
    const notice = {
      at: now,
      count,
      estFirst: Number(decision.nextPhase?.suppressedEst) || est,
      estLast: est,
      tier: decision.tier || null,
      suggested: count === 1 ? false : prev.suggested === true,
      released: false,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(notice));
    return notice;
  }
  if (decision && decision.gateRelease === true) {
    const notice = { ...prev, at: now, released: true };
    try { fs.writeFileSync(file, JSON.stringify(notice)); } catch { /* 留痕失败不影响路由 */ }
    return notice;
  }
  return prev;
}

// ---------- turn 检测与改写决策(纯函数,与协议无关) ----------

/** 有值才出键:决策与阶段对象会被测试/账本按 deepEqual 比对,显式 undefined 键会造成假不等。 */
const provKey = (p) => (p ? { providerId: p } : {});
const baseProvKey = (p) => (p ? { baseProvider: p } : {});

/** 虚拟档位名(2026-11-02 用户定档):客户端唯一可选的模型档,真实模型由决策层决定,不支持手动指定档位。 */
export const AUTO_MODEL = 'auto';

/** auto 档位的 sticky 基准解析:R1 档链头(便宜体现在档位归属;链头=品牌优先序排序,冷却自动滑链)。纯函数可测。 */
export function resolveAutoBase({ tierChains = {}, providerPriority = [], aliases = {}, inventory = [], health = {} } = {}) {
  const r = resolveTier('R1', { cfg: { modelRouting: { chains: tierChains, providerPriority, aliases } }, inventory, health });
  return { modelId: r.modelId || null, providerId: r.providerId || null, warn: r.warn };
}

export function decideTarget({ requestedModel, lastKind, diff = null, tierChains = null, providerPriority = [], aliases = {}, inventory, health, upstreams, phase = null, guard = null, contextBytes = 0, errStreak = 0, escalate = false } = {}) {
  const g = { ...DEFAULT_GUARD, ...(guard && typeof guard === 'object' ? guard : {}) };
  const inPhase = !!(phase && phase.model);
  // auto 档(2026-11-02):请求模型是虚拟名,没有"客户端所选真实模型"——
  // sticky 基准=R1 档链头解析;阶段/门控逻辑对 auto 同样成立(客户端恒发 auto,不存在"人工改档"路径)。
  const isAuto = requestedModel === AUTO_MODEL;
  // 四档链解析源(优先级:调用方 tierChains > 快照自派生)
  const tc = tierChains || deriveTierChains(upstreams);
  // auto 基准供应商也要驻留并随决策带回(2026-11-05 修复):此前只回 model 不回 providerId,
  // pickUpstream 落到"按模型名找快照第一个持有者"——不查健康冷却、providerPriority 失效,
  // 同名多供应商时配额墙账号每轮被反复选中。
  const autoBase = isAuto ? resolveAutoBase({ tierChains: tc, providerPriority, aliases, inventory, health }) : null;
  const baseModel = isAuto ? (phase?.baseModel || autoBase.modelId || requestedModel) : requestedModel;
  const baseProvider = isAuto ? (phase?.baseProvider || autoBase.providerId || null) : null;

  // 缓存窗口(提前算:工具续接分支的墓簿也要用)
  const idleMs = phase?.at ? Date.now() - phase.at : Number.POSITIVE_INFINITY;
  const cacheCold = idleMs > CACHE_TTL_MS;
  // 门控疲劳与压缩检测(2026-11-05):est 挂在会话状态上跨轮累积;压缩=比首次拦截缩水 >30%,证据清零重来
  const estNow = estimateContextTokens(contextBytes);
  const gateCompressed = !!(phase?.suppressedEst && estNow > 0 && estNow <= Number(phase.suppressedEst) * GATE_COMPRESS_RATIO);
  const gateFatigue = (cacheCold || gateCompressed) ? 0 : (Number(phase.suppressedCount) || 0);
  const releaseByFatigue = gateFatigue >= GATE_FATIGUE_RELEASE;
  // 门控墓碑:让疲劳计数跨轮存续(工具续接/R1 轮不清零);缓存冷/已压缩/真阶段(有 model)都不携带
  const gateTomb = () => (phase && !phase.model && Number(phase.suppressedCount) >= 1 && !cacheCold && !gateCompressed ? { ...phase } : null);

  // 证据升级(P2,2026-11-04 逐级上梯):连续 2 轮修复失败 → 从**当前服务档**上梯一档(R1→R2→R3,封顶 R3)。
  // 资费语义(用户定档):R3 只在"R2 明确无法解决"后才调用——R1 会话先试 R2(8x),R2 再失败才 R3(15x),不越级;
  // R4 恒不可达(仅显式点名旗舰)。上梯成功后调用方把 errStreak 清零,新档重新积累 2 连才继续上梯。
  // 返回 {decision} 上梯成功 | {mark:false} 已封顶/目标档不可达/门控抑制(落到普通工具续接,streak 保持)。
  const ESC_NEXT = { R1: 'R2', R2: 'R3', R3: null, R4: null };
  const servingTier = tierOfModel(inPhase ? phase.model : baseModel) || 'R1';
  const escTarget = ESC_NEXT[servingTier] || null;
  const tryEscalate = () => {
    if (!escTarget) return { mark: false, decision: null };
    const target = resolveTier(escTarget, { cfg: { modelRouting: { chains: tc, providerPriority, aliases } }, inventory, health, reachable: (r) => isProxyReachable({ ...r, upstreams }) });
    const model = target?.modelId || null;
    // 解析结果必须真落在目标档:目标档链空时 resolveTier 会级联降到低档模型,拿它冒充"升级"是纯浪费(白付一次冷读)
    if (!model || target.tier !== escTarget || !isProxyReachable({ providerId: target.providerId, model, upstreams })) return { mark: false, decision: null };
    const est = estimateContextTokens(contextBytes);
    if (g.enabled && est > g.maxContextTokens) return { mark: false, decision: null };
    const nextPhase = {
      model, providerId: target.providerId,
      baseRequested: phase?.baseRequested ?? requestedModel,
      baseModel: phase?.baseModel || baseModel,
      ...baseProvKey(phase?.baseProvider || baseProvider),
      humanTurns: phase?.humanTurns || 0,
      escalated: true, tier: escTarget,
    };
    return { mark: true, decision: { model, providerId: target.providerId, switched: model !== baseModel, escalated: true, reason: `证据升级(连续 ${Math.max(errStreak, 2)} 轮修复失败,${servingTier}→${escTarget} 逐级上梯)`, nextPhase } };
  };

  if (lastKind !== 'human') {
    if (escalate) {
      const e = tryEscalate();
      if (e.decision) return e.decision;
      // 已封顶(R3/R4 服务档)/目标档不可达/门控抑制 → 普通工具续接(errStreak 保持;门控抑制轮上下文变薄后下轮重试)
    }
    if (inPhase) return { model: phase.model, providerId: phase.providerId, switched: phase.model !== baseModel, reason: '阶段延续(工具续接沿用升级档)', nextPhase: phase };
    // auto 且无阶段:sticky 基准=R1 解析(工具续接不重新解析,保持上一发的一致性)
    if (isAuto && baseModel !== requestedModel) return { model: baseModel, ...provKey(baseProvider), switched: baseModel !== requestedModel, reason: 'auto→R1 档(工具续接 sticky)', nextPhase: gateTomb() };
    return { model: requestedModel, switched: false, reason: 'tool-continuation-sticky', nextPhase: gateTomb() };
  }
  if (inPhase && !isAuto && phase.baseRequested && requestedModel !== phase.baseRequested) {
    return { model: requestedModel, switched: false, reason: '人工改档,阶段结束', nextPhase: null };
  }

  // 四档实弹路径(#16,2026-11-03 tier 唯一,role 两档制已废):难度定档 → resolveTier 级联降档。
  // 粘住规则(2026-11-04 成本复算 v2,按 1M 画像包/隐式缓存 20% 计价;单位=R1 价 token 等效):
  //   - R1 宽限(修正#1/#1b):当前服务档在 R2-R4 且热缓存仍在时,连续第 1 个 R1 轮留在现档服务
  //     (阶段与具体基座同口径),连续第 2 个才降档/收尾——"降完再升"的冷读税(R2 重升 ≈6.2M)
  //     远大于留档一轮的空转(R2 热轮 1.82M vs R1 0.23M),单次插问降档净亏 ≈5.35M;
  //   - 时间感知(修正#4):距上一轮超过缓存 TTL(5min)时热缓存假设失效,宽限与粘住偏好全部关闭,
  //     直接按当轮难度定档——换档不再有额外税,黏在旧档只是多花钱;
  //   - 阶段粘住只在一个档差内成立(R3→R2 盈亏平衡 ≈3.86 轮,与 maxPhaseTurns=4 重合,数值不动);
  //   - R4 跨档不粘(修正#2:R4→R2 盈亏平衡 0.3 轮,100x 下步降当轮即回本);目标档高于阶段档不粘
  //     (修正#3:阶段里点名旗舰要立即升,不能被粘住吞掉);
  //   - R1 降档不受切换税门控(修正#5),门控只拦升档。
  const baseTier = tierOfModel(baseModel) || null;
  const phaseTier = inPhase ? (phase.tier || tierOfModel(phase.model) || null) : null;
  const effTier = inPhase ? phaseTier : baseTier;
  const r1Asks = diff?.tier === 'R1';
  // 歧义→便宜档(2026-11-04 用户定策,代码内置不可配——与健康冷却 TTL 同先例):
  // classifyDifficulty 的"无信号兜底/过短"R1 判定 confidence ≤0.5,属于"判不出"而非"明确日常轮";
  // 这类轮跳过 R1 宽限,立即降档到 R1 档模型(宽限本是明确 R1 轮的热缓存 economics,不为歧义轮留高价档)。
  // 明确 R1 轮(提问 0.6/杂务 0.7/单点编辑 0.65)宽限照旧;auto 会话 sticky 基准本就是 R1 链头,天然不受影响。
  const AMBIGUOUS_R1_CONF = 0.5;
  const ambiguousR1 = r1Asks && Number(diff?.confidence) <= AMBIGUOUS_R1_CONF;
  const r1Streak = phase?.r1Streak || 0;
  const phaseAtCap = inPhase && (phase.humanTurns || 0) >= g.maxPhaseTurns;
  // R1 宽限:热缓存 + 服务档 R2-R4 + 未到轮数上限 + 非歧义轮 → 第 1 个连续 R1 轮留在现档;第 2 连/缓存已冷/到顶/歧义才降档。
  if (r1Asks && !ambiguousR1 && !cacheCold && !phaseAtCap && r1Streak < 1 && (effTier === 'R2' || effTier === 'R3' || effTier === 'R4')) {
    const keep = inPhase ? phase.model : baseModel;
    return {
      model: keep, ...provKey(inPhase ? phase.providerId : baseProvider),
      switched: keep !== requestedModel,
      reason: `R1 宽限(1/2):连续第 1 个 R1 轮留在 ${effTier} 档吃热缓存,下轮仍 R1 再降档`,
      nextPhase: inPhase ? { ...phase, r1Streak: 1 } : (gateTomb() ? { ...gateTomb(), r1Streak: 1 } : { r1Streak: 1 }),
    };
  }
  const r1Down = r1Asks && (baseTier === 'R2' || baseTier === 'R3' || baseTier === 'R4');
  if (r1Down) {
    const tr = resolveTier('R1', { cfg: { modelRouting: { chains: tc, providerPriority, aliases } }, inventory, health, reachable: (r) => isProxyReachable({ ...r, upstreams }) });
    if (tr && tr.modelId && isProxyReachable({ providerId: tr.providerId, model: tr.modelId, upstreams })) {
      return { model: tr.modelId, providerId: tr.providerId, switched: true, reason: `难度 R1 降档(基准 ${baseTier} 档→R1,不建阶段${inPhase ? ',现有阶段收尾' : ''}${ambiguousR1 ? ';歧义轮(置信≤0.5)跳过宽限,有歧义即便宜档' : ''})`, nextPhase: gateTomb(), tier: 'R1' };
    }
    return { model: baseModel, ...provKey(baseProvider), switched: baseModel !== requestedModel, reason: 'R1 档无可用模型,保持 sticky 基准', nextPhase: gateTomb() };
  }
  if (phaseAtCap) {
    return { model: baseModel, ...provKey(baseProvider), switched: baseModel !== requestedModel, reason: `阶段轮数到顶(${g.maxPhaseTurns}),回主循环`, nextPhase: gateTomb() };
  }
  if (inPhase && r1Asks) {
    return { model: baseModel, ...provKey(baseProvider), switched: baseModel !== requestedModel, reason: '阶段结束(R1 问答/杂务:连续第 2 个 R1 轮或缓存已冷)', nextPhase: gateTomb() };
  }
  const wantTier = diff && diff.tier && diff.tier !== 'R1' ? diff.tier : null;
  const RANK = { R1: 1, R2: 2, R3: 3, R4: 4 };
  // 粘住门槛(修正#2/#3/#4):目标档高于阶段档(旗舰点名)→ 不粘,立即升;
  // 阶段在 R4 且目标不是 R4 → 不粘(100x 盈亏平衡 0.3 轮),按目标档步降;缓存已冷(超 TTL)→ 不粘,按当轮难度重定档。
  const wantAbove = !!(inPhase && wantTier && phaseTier && RANK[wantTier] > RANK[phaseTier]);
  const r4StepDown = !!(inPhase && phaseTier === 'R4' && wantTier && wantTier !== 'R4');
  if (inPhase && !wantAbove && !r4StepDown && !cacheCold) {
    return { model: phase.model, providerId: phase.providerId, switched: phase.model !== baseModel, reason: `阶段粘住延续(${phase.tier || phaseTier || '升档'}档,第 ${(phase.humanTurns || 0) + 1} 人类轮)`, nextPhase: { ...nextTurnOf(phase), r1Streak: 0 } };
  }
  if (wantTier) {
    const tr = resolveTier(wantTier, { cfg: { modelRouting: { chains: tc, providerPriority, aliases } }, inventory, health, reachable: (r) => isProxyReachable({ ...r, upstreams }) });
    if (tr && tr.modelId && isProxyReachable({ providerId: tr.providerId, model: tr.modelId, upstreams })) {
      const nextTurn = { model: tr.modelId, providerId: tr.providerId, baseRequested: requestedModel, baseModel, ...baseProvKey(baseProvider), humanTurns: (phase?.humanTurns || 0) + 1, tier: tr.tier };
      if (tr.modelId === baseModel) return { model: baseModel, providerId: tr.providerId, switched: baseModel !== requestedModel, reason: `${wantTier} 命中但已是该档${tr.downgraded ? `(目标档空,级联降档至 ${tr.tier})` : ''}`, nextPhase: nextTurn, tier: tr.tier };
      if (g.enabled && estNow > g.maxContextTokens && !releaseByFatigue) {
        // 疲劳计数 +1 并挂墓碑存续(cache 冷/已压缩 ⇒ gateFatigue 已清零,从 1 重新攒;锚点 est 供压缩检测)。
        // tier 仍记 wantTier(本轮实际发的是基准模型):该轮若失败,同轮滑档从"想去的档"起滑——
        // 失败轮没有任何产出,换模型是纯改善,切换税权衡不成立(与"滑档不受门控"同一原则)。
        const nextCount = gateFatigue + 1;
        return {
          model: baseModel, ...provKey(baseProvider), switched: baseModel !== requestedModel, suppressed: 'switch-tax',
          reason: `切换税门控:上下文约 ${estNow} tokens > ${g.maxContextTokens},不升档(拦截连击 ${nextCount}/${GATE_FATIGUE_RELEASE};建议压缩上下文或新开会话,连击满即疲劳放行)`,
          nextPhase: { suppressedCount: nextCount, suppressedEst: gateCompressed ? estNow : (Number(phase?.suppressedEst) || estNow), suppressedTier: wantTier, at: Date.now() },
          tier: wantTier,
        };
      }
      // 放行留痕:疲劳放行(证据消耗,新阶段不带 suppressedCount ⇒ 计数自然归零)/压缩后自然升档——供自进化统计
      const gateNote = releaseByFatigue ? `门控疲劳放行(此前连续拦截 ${gateFatigue} 次)` : (gateCompressed ? '压缩后自然升档' : '');
      return { model: tr.modelId, providerId: tr.providerId, switched: true, reason: `难度 ${wantTier}→${tr.tier} 档${tr.downgraded ? '(降档)' : ''}(阶段粘住)${gateNote ? ';' + gateNote : ''}`, nextPhase: nextTurn, tier: tr.tier, downgraded: tr.downgraded === true, ...(releaseByFatigue ? { gateRelease: true } : {}) };
    }
    return { model: baseModel, ...provKey(baseProvider), switched: baseModel !== requestedModel, reason: `${wantTier} 档无可用模型,保持 sticky 基准`, nextPhase: gateTomb(), tier: wantTier };
  }

  // auto 无阶段的新人类轮:sticky 基准=R1 解析(这是 auto 会话的"会话模型")
  if (isAuto && baseModel !== requestedModel) return { model: baseModel, ...provKey(baseProvider), switched: true, reason: 'auto→R1 档(sticky 基准)', nextPhase: gateTomb() };
  return { model: requestedModel, switched: false, reason: 'sticky', nextPhase: gateTomb() };
}

function nextTurnOf(phase) { return { ...phase, humanTurns: (phase.humanTurns || 0) + 1 }; }

/**
 * 上下文 tokens 估算:bytes/3.2(2026-11-01 由代理配对样本标定,替换原 bytes/4 猜测口径)。
 * 样本 = 9 条经本代理转发、上游回真实 usage 的探针(4K/32K/96K 三档 × 代码/中英混排/纯中文三种料),
 * real/est 比值:代码料 1.12-1.14,混排料 1.21-1.29,纯中文料 0.915-0.918(与原口径同步长稳定,线性成立)。
 * 取 bytes/3.2 后:三类料最大欠估 3%(混排),其余全为过估(纯中文最多 +36%)——门控方向上欠估=多花钱,故只留欠估余地不留风险。
 */
export function estimateContextTokens(bytes) {
  const n = Number(bytes);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n / 3.2) : 0;
}

/** CJK 字符数(汉字/假名/全角):用于离线复核标定口径的密度偏差,不参与决策。 */
export function countCjk(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) n += 1;
  }
  return n;
}

// 错误族关键词(2026-11-03 用户定档,覆盖各家文案;中英混排)。状态码优先,body 关键词消歧。
// 客户端请求内容错:参数/JSON/上下文超限/内容安全/方法不允许——不冷却(冷却模型无济于事,反误伤健康模型)。
const CLIENT_FAULT_RE = /missing.{0,20}(param|field|argument|required|value)|invalid.{0,8}(json|param|argument|request|body|payload)|json.{0,8}(parse|decode|invalid|malformed|syntax)|(context.?length|context.?window).{0,12}exceed|request_too_large|request.?too.?large|too.?long|消息体超限|输入超限|badrequest\.toolong|datainspectionfailed|data.?inspection|内容安全|内容审核|敏感|content.?(filter|safety|policy|moderation|risk)|\bsensitive\b|\bsafety\b|recitation|\brisk\b|invalid_request_error|invalidparameter|invalid_argument|参数(错误|非法|缺失)|unprocessable|validation.{0,10}(error|fail)|method not allowed|bad request/i;
// 账单:配额耗尽/余额不足/欠费(先于 transient 判,因 429 既可能限流也可能配额尽)。
const BILLING_RE = /insufficient.?(quota|balance|credit|fund)|insufficient_quota|quota.?(exceed|exhaust|used.?up|deplet)|exceeded.?quota|(freequota|allocationquota).{0,20}exhaust|arrearage|欠费|余额不足|out of (credit|quota|balance)|not enough (balance|credit|quota|fund)|payment.?required|\bbilling\b|充值|recharge/i;
// 配置错误导致模型不通:模型不存在/拼错/下线/未开通、Key 无效或过期、无权访问该模型、地区受限。
// 只收**明确指向模型/鉴权**的文案;裸 unauthorized/forbidden/access denied 太泛(欠费也写 "Access denied"),
// 交给状态码 401/403/404 兜,避免把账单错误判成配置错。
const CONFIG_RE = /model_not_found|model.{0,12}not.{0,6}(found|exist)|no such model|unknown model|invalid model|unsupported model|model not exist|url error|not_found_error|authentication_error|permission_error|invalid.?api.?key|invalidapikey|invalid_?key|model\.accessdenied|认证失败|无权限|无权访问|模型不存在|地区受限|(api.?key|key|token).{0,12}(invalid|error|expired|wrong|过期|无效|错误)/i;
// 临时限流/并发超限/引擎过载/超时/5xx(可重试)。
const TRANSIENT_RE = /rate.?limit|rate_limit_error|too many requests|throttl|overload|overloaded_error|engine_overload|engine_overloaded|concurrency|并发|限流|resource_exhausted|deadline_exceeded|request.?timeout|requesttimeout|timed?.?out|超时|server error busy|server_error|api_error|service unavailable|bad gateway|gateway.?timeout|\b(qps|rpm|tpm|qpm)\b/i;
// 错误信封:2xx 也可能裹错误体(GLM/DashScope 业务码),据此判"这不是干净成功"。
const ERR_ENVELOPE_RE = /"error"|"code"\s*:|error_?(code|type)|"errcode"|"success"\s*:\s*false|finish_?reason"?\s*[:=]\s*"?(safety|recitation)/i;
// 对话载荷标记(2026-11-04 修复):2xx 响应里出现这些 = 上游真的在回话(anthropic content/content_block*/
// message_*、openai choices/delta/text),bodyHead 就是**助手自己生成的正文**——正文里出现 "error"/quota/
// rate limit/invalid api key 多半是在讨论报错,不是上游报错。真正的 200 裹错误体只有 code/msg 信封、没有这些标记。
const CHAT_PAYLOAD_RE = /"(content|content_block[a-z_]*|message_start|message_delta|message_stop|choices|delta|text)"\s*:/;

/**
 * 上游是否该进健康冷却(#8 运行时错误驱动 + "清单列出≠可调用"的首调负缓存)。
 * 执行层逻辑就是"错误类型 → 4 档冷却时间"的纯映射:transient 5min / billing 30min / config 2h / unknown 5h,
 * 另有三类不冷却:干净成功、2xx 带正常对话载荷(助手正文里讨论报错≠上游报错)、客户端请求内容错(冷却模型无济于事)。
 * 返回错误族或 null(不冷却)。判定序:
 *   干净成功 → 2xx 有对话载荷 → 配置不通(模型/鉴权文案,先于客户端错:DashScope 把 "Model not exist" 裹在 InvalidParameter 里)
 *   → 客户端请求内容错(不冷却)→ 429 消歧(明确限流信号=transient,否则 billing)→ 账单
 *   → 配置不通(状态码 401/403/404)→ 临时限流/5xx → 未知兜底(≥400 带错误信封)。
 * 状态码优先,body 关键词消歧(聚合网关常拿同一状态码表达不同错误族)。
 * 仅凭状态码(forward 同轮重选门,无 body)也能定族;裸 4xx 无 body 佐证时不轻判 unknown,避免误伤请求格式错。
 */
export function shouldCoolDown({ status, bodyHead } = {}) {
  const s = Number(status) || 0;
  const b = String(bodyHead || '');
  const hasEnvelope = ERR_ENVELOPE_RE.test(b);
  // 干净成功(2xx 且无错误信封)→ 不冷却
  if (s >= 200 && s < 300 && !hasEnvelope) return null;
  // 2xx 带信封但仍有正常对话载荷 → 不冷却(2026-11-04 修复:此前助手正文里的 quota/rate limit/
  // invalid api key 等词会把刚成功服务、有产出的健康模型记 30min-2h 冷却;现网账本实证 1 例)。
  if (s >= 200 && s < 300 && CHAT_PAYLOAD_RE.test(b)) return null;
  // 配置错误导致模型不通(模型不存在/Key 无效/无权访问该模型)→ 2h。**先于客户端错判定**:
  // DashScope 把 "Model not exist." 裹在 code=InvalidParameter 里,若先跑 CLIENT_FAULT 会被误判成请求格式错而不冷却。
  if (CONFIG_RE.test(b)) return 'config';
  // 客户端请求内容错(参数/JSON/上下文超限/内容安全/方法)→ 不冷却:那是请求方的问题,拉黑模型无益反误伤
  if (CLIENT_FAULT_RE.test(b)) return null;
  // 429 消歧(2026-11-03 用户裁定方案1,观察期):body 有**明确限流/并发/节流信号**才 transient(5min);
  // 否则裸 429 / 泛化文案 / 配额余额一律 billing(30min)——聚合网关常拿笼统 429 表达额度墙,
  // 欠冷却(5min)会让没额度的模型每 5 分钟被重探一次,比过冷却真限流更伤。观察后可再调。
  if (s === 429) return TRANSIENT_RE.test(b) ? 'transient' : 'billing';
  // 账单(配额/余额/欠费)→ 30min
  if (s === 402 || BILLING_RE.test(b)) return 'billing';
  // 配置错误(状态码兜:401 认证失败 / 403 无权限 / 404 模型不存在)→ 2h
  if (s === 401 || s === 403 || s === 404) return 'config';
  // 临时限流/并发/过载/超时/5xx(可重试)→ 5min;5xx 一律 transient(服务器侧错误,换模型可恢复)
  if (s === 408 || s >= 500 || TRANSIENT_RE.test(b)) return 'transient';
  // 未知错误兜底 → 5h:≥400 且带错误信封但无法归类;裸 4xx(无 body)不轻判,多为请求格式错
  if (s >= 400 && hasEnvelope) return 'unknown';
  return null;
}

function switchGuard(configPath) {
  const mr = readJson(configPath)?.modelRouting || {};
  const sg = mr.switchGuard && typeof mr.switchGuard === 'object' ? mr.switchGuard : {};
  // maxPhaseTurns 新家=modelRouting.maxPhaseTurns(2026-11-04 迁出;恒生效不属门控),旧位置兜底不丢人工值。
  const n = Number(mr.maxPhaseTurns ?? sg.maxPhaseTurns);
  const maxPhaseTurns = Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_GUARD.maxPhaseTurns;
  return { ...sg, maxPhaseTurns };
}

/**
 * 运行时 429/5xx 同轮重选配置(2026-11-03)。默认开启:失败轮本就拿不到回复,
 * 同轮换模型重试是纯改善;上限 maxRetries 次(默认 2),只在 tier 模式且能重解析出新模型时才真的重发。
 * retryOnRateLimit=false 可整体关闭回到"透传单次错误"旧行为。
 */
function retryConfig(configPath) {
  const mr = readJson(configPath)?.modelRouting || {};
  const enabled = mr.retryOnRateLimit !== false;
  const n = Number(mr.maxRetries);
  const maxRetries = Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 5) : 2;
  return { enabled, maxRetries };
}

// ---------- 转发与用量旁路 ----------

function forward(clientRes, upstream, suffix, bodyObj, reqMeta, adapter = anthropicAdapter, opts = {}) {
  // opts.allowRetry:运行时 429/5xx 同轮重选开关。为 true 时,遇到仅凭状态码即可判定的可冷却错误
  // (shouldCoolDown 任一非 null 族)不向客户端提交(writeHead 延后),丢弃错误体并 resolve {retry:true},
  // 交回上层冷却失败模型→重跑 resolveTier(档内滑/降档)→换模型重发。allowRetry=false 时行为与旧版一致。
  const allowRetry = opts.allowRetry === true;
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(bodyObj));
    if (!upstream.baseUrl) {
      // 空上游(快照缺失/供应商池为空):直接 502,不让 new URL('') 抛 TypeError 击穿 async handler。
      try {
        clientRes.writeHead(502, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { type: 'proxy_error', message: 'no usable upstream baseUrl (snapshot empty or provider unconfigured)' } }));
      } catch { /* 客户端已断开 */ }
      resolve({ status: 502, retry: false, netError: false, body: '', headers: {} });
      return;
    }
    const u = new URL((String(upstream.baseUrl || '')).replace(/\/+$/, '') + suffix);
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (info) => { if (settled) return; settled = true; resolve(info); };
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        ...adapter.upstreamHeaders(upstream.apiKey),
        'accept': clientRes.req?.headers?.accept || '*/*',
      },
    }, (up) => {
      // 仅状态码即可判定为可重试(config/billing/transient/unknown 任一非 null 族):同轮重选,先不碰客户端。
      // 裸 4xx(如 400 请求格式错)状态码判为 null → 不进重试,照常透传,避免为请求方的错换模型。
      if (allowRetry && shouldCoolDown({ status: up.statusCode })) {
        let ebuf = '';
        up.on('data', (c) => { if (ebuf.length < 4096) ebuf += c.toString('utf8'); });
        const done = () => {
          try { up.destroy(); } catch { /* 已断开 */ }
          const bh = ebuf.slice(0, 2000);
          // 用 status+body 复算错误族(比仅状态码更准:403 内容安全 vs 权限、429 限流 vs 配额尽)
          resolve({ retry: true, status: up.statusCode, cool: shouldCoolDown({ status: up.statusCode, bodyHead: bh }), bodyHead: bh });
        };
        up.on('end', done);
        up.on('error', done);
        return;
      }
      const headers = { ...up.headers };
      delete headers['content-length']; // 流式透传时长度不可预知
      clientRes.writeHead(up.statusCode, headers);
      const acc = { inTok: null, outTok: null, cacheRead: null, cacheWrite: null, cacheReported: null, usageRaw: null, served: null };
      let buf = '';
      let sbuf = '';
      // 客户端中断(点停止/关窗/超时):上游还在逐 token 生成就是按量白付费——立即拆连接并留痕
      clientRes.on('close', () => {
        if (settled) return;
        try { up.destroy(); } catch { /* 已断开 */ }
        try { req.destroy(); } catch { /* 已断开 */ }
        finish({ ...acc, status: up.statusCode, aborted: true });
      });
      up.on('data', (chunk) => {
        clientRes.write(chunk);
        if (sbuf.length < 8 * 1024 * 1024) sbuf += chunk.toString('utf8');
        if (reqMeta.stream) {
          buf += chunk.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            try {
              // OpenAI 流末尾的 data: [DONE] 不是 JSON,解析失败按半行/非 JSON 忽略
              const d = JSON.parse(line.slice(5).trim());
              adapter.grabUsage(d, acc);
            } catch { /* 半行/非 JSON 忽略 */ }
          }
        }
      });
      up.on('end', () => {
        if (!reqMeta.stream && sbuf) {
          try {
            const d = JSON.parse(sbuf);
            adapter.grabBodyUsage(d, acc);
          } catch { /* 非 JSON 忽略 */ }
        }
        clientRes.end(); resolve({ ...acc, status: up.statusCode, bodyHead: sbuf.slice(0, 2000) });
      });
      up.on('error', () => { try { clientRes.end(); } catch {} resolve({ ...acc }); });
    });
    req.on('error', () => {
      if (allowRetry) { resolve({ retry: true, status: null, cool: 'transient', netError: true }); return; }
      try { clientRes.writeHead(502, { 'content-type': 'application/json' }); clientRes.end(JSON.stringify({ error: { message: 'proxy upstream error' } })); } catch {}
      resolve({});
    });
    req.write(body);
    req.end();
  });
}

/** 同轮重选无替代模型时,把 forward 缓冲下来的错误体提交给客户端(客户端未收到任何 writeHead)。 */
function commitBufferedError(clientRes, usage) {
  try {
    const status = Number(usage?.status) || 502;
    const bodyText = usage?.bodyHead || JSON.stringify({ error: { message: 'no available model after same-turn retry' } });
    if (!clientRes.headersSent) clientRes.writeHead(status, { 'content-type': 'application/json' });
    clientRes.end(bodyText);
  } catch { try { clientRes.end(); } catch { /* 客户端已断开 */ } }
}

function logProxyUsage(rec, usageFile = PROXY_USAGE_LOG) {
  try {
    fs.mkdirSync(path.dirname(usageFile), { recursive: true });
    fs.appendFileSync(usageFile, JSON.stringify(rec) + '\n');
  } catch { /* 记不上就算了 */ }
}

// ---------- HTTP 服务 ----------

export function createProxyServer({ port = 8117, upstreamsFile = UPSTREAMS_FILE, basePath = '/apps/anthropic', chainsOverride = null, usageFile = PROXY_USAGE_LOG, healthDataDir = DATA_DIR, configPath = path.join(DATA_DIR, 'code-index.config.json') } = {}) {
  // chainsOverride:测试注入的四档位链(生产恒走快照派生)
  const state = new Map(); // convKey → {model,baseRequested,humanTurns}:升档阶段驻留(#1/#5 阶段粘住)
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      // 双端隔离(2026-11-04):/apps/qoder 前缀=Qoder 宿主,其余(/apps/anthropic 等)=ZCode;
      // 各宿主只在自己的路由清单里决策,互不混池;旧快照无 host 标签退回合并池(兼容未刷新部署)。
      const reqHost = req.url.startsWith('/apps/qoder') ? 'qoder' : 'zcode';
      const upstreams = upstreamsForHost(readJson(upstreamsFile) || { providers: {} }, reqHost);
      let bodyObj = null;
      try { bodyObj = JSON.parse(raw); } catch { /* 非 JSON 原样转发 */ }

      const adapter = bodyObj ? pickProtocolAdapter(req.url) : null;
      const convKey = convKeyOf(bodyObj, req.url, adapter || anthropicAdapter);
      prunePhases(state); // 空闲超限/超量的阶段先回收(H6)
      const requestedModel = bodyObj?.model || ''; // 改写前先留存:账本要能对出"客户端要什么/实际谁服务"
      let targetModel = requestedModel;
      let decision = { reason: 'passthrough' };
      let would = null;
      let l1Type = null;
      const routeMode = 'tier'; // 2026-11-03 用户终裁:role 两档制已废,tier 四档难度制唯一
      let diffDecision = null;
      let retryCtx = null; // 同轮重选所需的重解析上下文:{ro, tierChains}
      if (adapter && Array.isArray(bodyObj.messages)) {
        const ro = mrRoutingOptions(configPath);
        const lastKind = adapter.lastMessageKind(bodyObj.messages);
        const l1 = lastKind === 'human' ? classifyPrompt(adapter.lastHumanText(bodyObj.messages)) : null;
        // 难度定档:人类轮算一次,tier 实弹决策与四档影子共用同一结果
        // 档案(mtime 缓存,默认 disabled)⇒ 人工 --enable 后这里真的改判;读不到/未启用 = 纯词法,零影响
        if (lastKind === 'human') {
          try { diffDecision = classifyDifficulty(adapter.lastHumanText(bodyObj.messages), { calibration: loadTierCalibration() }); } catch { diffDecision = null; }
        }
        // 证据升级(P2,逐级上梯):连续 2 个工具轮含报错 tool_result → 申请上梯;
        // 目标档=当前服务档+1(decideTarget 内定,封顶 R3),上梯成功后 errStreak 清零重新积累
        const phase0 = state.get(convKey) || null;
        let errStreak = 0;
        let escalate = false;
        if (lastKind === 'tool') {
          const errs = adapter.countToolErrors(bodyObj.messages);
          errStreak = errs > 0 ? ((phase0?.errStreak || 0) + 1) : 0;
          escalate = errStreak >= 2;
        }
        // 四档链(同一份快照按 tierOfModel 分桶,档内品牌优先序+档位序数排序;chainsOverride=测试注入的档位链)
        const tierChains = chainsOverride || deriveTierChains(upstreams, { brandPriority: ro.brandPriority });
        retryCtx = { ro, tierChains }; // 留给运行时 429 同轮重选:重跑 resolveTier 档内滑/降档
        // 健康/库存快照每轮读一次:实弹决策与难度裸解析审计共用(此前审计块各自重读一遍,同参数重复计算)
        const health0 = readHealth(healthDataDir);
        const inventory0 = inventoryFromUpstreams(upstreams);
        const d = decideTarget({
          requestedModel: bodyObj.model, lastKind, diff: diffDecision,
          tierChains, providerPriority: ro.providerPriority, aliases: ro.aliases,
          inventory: inventory0,
          health: health0, upstreams,
          phase: phase0, guard: switchGuard(configPath), contextBytes: size,
          errStreak, escalate,
        });
        decision = d;
        // 门控通知(2026-11-05):拦截连击/疲劳放行落 data/usage/gate-notice.json,prompt-guard 据此注入压缩建议
        try { updateGateNotice({ dataDir: healthDataDir, decision: d, est: estimateContextTokens(size) }); } catch { /* 通知失败不影响路由 */ }
        l1Type = l1 && l1.type ? l1.type : null;
        // 难度裸解析审计(原"四档影子",2026-11-04 复审正名):tier 已是唯一实弹,这里记的是
        // **只按难度、不受阶段粘住/切换税门控/sticky 约束**时会解析到哪个模型(wouldTier/wouldModel),
        // 与实弹 servedModel 对照 → 观察 R4 是否误升、门控与阶段抑制了多少次换档(黄金集 R4 覆盖恒为 0,
        // R4 定档只能靠这份真实流量证据校准)。复用本轮已算的 diff/tierChains/health/inventory,不重复计算。
        // 全程 try/catch:审计任何异常都不得影响转发。
        if (lastKind === 'human') {
          try {
            const diff = diffDecision || classifyDifficulty(adapter.lastHumanText(bodyObj.messages), { calibration: loadTierCalibration() });
            const tr = resolveTier(diff.tier, {
              cfg: { modelRouting: { chains: tierChains, providerPriority: ro.providerPriority, aliases: ro.aliases } },
              inventory: inventory0, health: health0,
              reachable: ({ providerId, model }) => isProxyReachable({ providerId, model, upstreams }),
            });
            // 歧义轮(置信≤0.5 的 R1)影子 A/B:只记"改判 R2"会解析到哪,不改实弹——攒数据再定策略
            const ambiguousR1 = diff.tier === 'R1' && Number(diff.confidence) <= 0.5;
            const amb = ambiguousR1 ? resolveTier('R2', {
              cfg: { modelRouting: { chains: tierChains, providerPriority: ro.providerPriority, aliases: ro.aliases } },
              inventory: inventory0, health: health0,
              reachable: ({ providerId, model }) => isProxyReachable({ providerId, model, upstreams }),
            }) : null;
            logTierShadow({
              dataDir: healthDataDir, prompt: adapter.lastHumanText(bodyObj.messages),
              tier: diff.tier, tierConfidence: diff.confidence, tierReason: diff.reason,
              wouldTier: tr.tier || null, wouldModel: tr.modelId || null, wouldProvider: tr.providerId || null,
              downgraded: tr.downgraded === true, servedModel: d.model || requestedModel,
              decisionTier: d.tier || null,
              escalated: d.escalated === true || !!(d.nextPhase && d.nextPhase.escalated === true),
              switched: d.switched == null ? null : !!d.switched,
              servedTier: tierOfModel(d.model || requestedModel) || null,
              ambWouldTier: amb ? (amb.tier || null) : null,
              ambWouldModel: amb ? (amb.modelId || null) : null,
              host: reqHost,
            });
          } catch { /* 审计失败绝不影响实弹转发 */ }
        }
        // 阶段合并:escalated 仅作账本审计留痕(上梯目标由服务档决定,无需墓碑拦截重复升级);
        // 上梯成功轮 errStreak 清零——新档重新积累 2 连报错才继续上梯(R1→R2→R3 逐级,不越级);
        // errStreak 随状态驻留——普通 sticky 工具轮也要落墓碑,否则连续报错轮计数每轮清零,
        // 证据升级永远凑不齐 2 连(2026-11-03 实弹三连探针抓到);人工改档/收尾/无错轮后重新计数。
        const prevPhase = state.get(convKey);
        const escalatedFlag = d.nextPhase?.escalated === true || prevPhase?.escalated === true || d.escalated === true;
        if (d.nextPhase) state.set(convKey, { ...d.nextPhase, escalated: escalatedFlag, errStreak: d.escalated ? 0 : errStreak, at: Date.now() });
        else if (escalatedFlag || errStreak > 0) state.set(convKey, { escalated: escalatedFlag, errStreak, at: Date.now() });
        else state.delete(convKey);
        if (d.switched) bodyObj.model = d.model;
        targetModel = bodyObj.model;
        bodyObj = adapter.prepareBody(bodyObj);
      }

      // /apps/<宿主> 前缀统一剥掉(ZCode=/apps/anthropic,Qoder=/apps/qoder),上游只收 /v1/* 后缀
      const appPrefix = (req.url.match(/^\/apps\/[^/]+/) || [null])[0]
        || (req.url.startsWith(basePath) ? basePath : null);
      const suffix = appPrefix ? req.url.slice(appPrefix.length) : req.url;
      const started = Date.now();

      // 虚拟档位名 auto 绝不原样发给真实账号:解析不出真实模型=该宿主无可路由清单(快照空或全冷却)。
      // 此前它被当普通模型名透传,上游回 404、按 config 族计入健康档案 failCount,白付一次往返还污染冷却。
      if (bodyObj && bodyObj.model === AUTO_MODEL) {
        const why = `${reqHost} 宿主的 auto 档解析不出真实模型(路由清单为空或全部冷却)`;
        logProxyUsage({
          ts: started, conv: convKey, path: req.url, host: reqHost,
          requested: requestedModel, served: null, target: null, provider: null, resolvedProvider: null,
          ingress: ingressProviders(upstreams).join(',') || null,
          status: 502, reason: `auto-unresolved:${why}`, switched: false, routeMode,
          bodyBytes: size, durationMs: Date.now() - started,
        }, usageFile);
        try {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'proxy_error', message: `${why};请检查 data/routing/proxy-upstreams.json 与 data/model-health.json` } }));
        } catch { /* 客户端已断开 */ }
        return;
      }

      const isStream = bodyObj?.stream === true;
      const meta = { stream: isStream };
      // 运行时 429/5xx 同轮重选(2026-11-03):失败轮本就拿不到回复,同轮冷却失败模型→重跑 resolveTier
      // (档内滑下一个 / R4→R3→R2→R1 降档)→换模型重发,上限 maxRetries 次;全失败才把末次错误提交给客户端。
      // 只在能重解析出新模型时才真的重发,否则等价旧的"单次透传"行为。
      // 滑档起点(2026-11-04 用户定档):难度定档轮(R2-R4 及 R1 降档轮,decision.tier 有值)从生效档起滑;
      // sticky 请求(具体模型名且未触发 R1 降档、工具续接沿用模型)从 sticky 模型自身所在档位(tierOfModel)起滑。
      const rc = retryConfig(configPath);
      const slideTier = decision.tier || (targetModel ? tierOfModel(targetModel) : null);
      const canRetryRoute = rc.enabled && !!retryCtx && !!slideTier;
      let curUpstream = pickUpstream({ providerId: decision.providerId, model: targetModel, upstreams });
      let curModel = targetModel;
      let curBody = bodyObj ?? {};
      let attempts = 0;
      let usage = null;
      let cool = null;
      const retryTrail = [];
      let curSlideTier = slideTier; // 渐进退避后的滑档起点(每次重解析后同步为实际落点,保证单调不回升)
      for (;;) {
        const allowRetry = canRetryRoute && attempts < rc.maxRetries;
        usage = await forward(res, curUpstream, suffix, curBody, meta, adapter || anthropicAdapter, { allowRetry });
        // netError(上游连不上/DNS 失败)没有状态码可复算:采信 forward 标的 transient——
        // 复算得 null 会被当"客户端请求内容错"直接提交,同轮重选对网络故障形同虚设(2026-11-04 修复)。
        cool = usage.netError ? (usage.cool || 'transient') : shouldCoolDown(usage);
        if (!usage.retry) break; // 已提交客户端(成功 / 末次错误透传)
        // body 复算后判为客户端请求内容错(cool=null,如 403 实为内容安全拦截):不是模型可用性问题,
        // 直接把缓冲的错误交回客户端——不换模型、不冷却(换模型也会因同一 prompt 再被拦,冷却更会误伤健康模型)。
        if (!cool) { commitBufferedError(res, usage); break; }
        attempts += 1;
        const failedProvider = curUpstream?.providerId || null;
        if (failedProvider && curModel) {
          markHealthCool({ dataDir: healthDataDir, modelKey: `${failedProvider}/${curModel}`, reason: `${cool}(http ${usage.status ?? '-'})`, ttlMs: coolTtlMs(cool), capMs: COOL_CAP[cool] || coolTtlMs(cool) });
        }
        // billing 族(配额墙)直降(2026-11-04):额度耗尽时跳过同档同价重试——同档再试一次也要付一份
        // 冷读税(R2≈6.2M),配额墙不会因换档内成员而解除;transient/config/unknown 保留档内滑动(限流是暂时的)。
        if (cool === 'billing') curSlideTier = NEXT_LOWER_TIER[curSlideTier] || curSlideTier;
        // 本轮失败已在此 mark:清 cool,防止 break 出循环后"末次补记"对同一 provider/model 二次 mark
        // (2026-11-05 修复:无替代而 break 时 failCount 每轮 +2,渐进退避 2^(N-1) 提前翻倍封顶)。
        cool = null;
        let nextModel = null;
        let nextProvider = null;
        try {
          const r = resolveTier(curSlideTier, {
            cfg: { modelRouting: { chains: retryCtx.tierChains, providerPriority: retryCtx.ro.providerPriority, aliases: retryCtx.ro.aliases } },
            inventory: inventoryFromUpstreams(upstreams), health: readHealth(healthDataDir),
            reachable: ({ providerId, model }) => isProxyReachable({ providerId, model, upstreams }),
          });
          if (r && r.modelId) { nextModel = r.modelId; nextProvider = r.providerId; if (r.tier) curSlideTier = r.tier; }
        } catch { /* 重解析异常即无替代,走末次提交 */ }
        retryTrail.push({ attempt: attempts, failedProvider, failedModel: curModel, status: usage.status ?? null, cool: usage.cool || null, nextModel: nextModel || null, nextProvider: nextProvider || null });
        const nextUpstream = nextModel ? pickUpstream({ providerId: nextProvider, model: nextModel, upstreams }) : null;
        // 无替代 / 解析出的还是刚失败的那个 / 上游无 baseUrl → 把已缓冲的错误提交给客户端,结束
        if (!nextModel || (nextModel === curModel && nextProvider === failedProvider) || !nextUpstream?.baseUrl) {
          commitBufferedError(res, usage);
          break;
        }
        curModel = nextModel;
        curUpstream = nextUpstream;
        curBody = adapter ? adapter.prepareBody({ ...(bodyObj ?? {}), model: nextModel }) : { ...(bodyObj ?? {}), model: nextModel };
      }
      // 末次服务的模型若也是可冷却错误(含 allowRetry=false 提交路径),补记冷却,惠及后续轮次
      if (cool && curUpstream?.providerId && curModel) {
        markHealthCool({ dataDir: healthDataDir, modelKey: `${curUpstream.providerId}/${curModel}`, reason: `${cool}(http ${usage.status ?? '-'})`, ttlMs: coolTtlMs(cool), capMs: COOL_CAP[cool] || coolTtlMs(cool) });
      }
      // 同轮重选换过模型:把阶段状态回写成最终实际服务的模型(2026-11-05 修复)——
      // 否则下一轮"阶段延续"又发给刚 429 的模型,每轮白付一次重试。
      if (attempts > 0 && curModel) {
        const ph = state.get(convKey);
        if (ph && ph.model && ph.model !== curModel) state.set(convKey, { ...ph, model: curModel, providerId: curUpstream?.providerId || ph.providerId });
      }
      // 成功清零(2026-11-04):一次干净成功(2xx)即删除该 provider/model 的健康记录,重置渐进退避计数——
      // 恢复中的模型不被历史失败放大冷却;失败透传/客户端错/netError 不清(无记录时 clearHealth 不写盘,热路径零开销)。
      if (!usage?.retry && !usage?.netError && Number(usage?.status) >= 200 && Number(usage?.status) < 300 && curUpstream?.providerId && curModel) {
        clearHealth({ dataDir: healthDataDir, modelKey: `${curUpstream.providerId}/${curModel}` });
      }
      logProxyUsage({
        ts: started, conv: convKey, path: req.url, host: reqHost,
        requested: requestedModel, served: usage.served || curModel,
        target: targetModel || requestedModel || null, // 决策改写目标(快照配置名,如 GLM-5.3-Flash;served 是网关回报的规范名,两者形态不同)
        provider: curUpstream?.providerId || null, // 实际拿到请求的供应商(审计"钉住没钉住";重试后为末次服务者)
        resolvedProvider: decision.providerId || null, // 档位链解析钉住的供应商(sticky 轮无解析=null;与 provider=实际服务者对照,此前读不存在的 resolvedProviderId 恒 null)
        ingress: ingressProviders(upstreams).join(',') || null, // 入口供应商(客户端请求必经的账户)
        inTok: usage.inTok, outTok: usage.outTok, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        cacheReported: usage.cacheReported === true, // 上游是否回报缓存段(false=网关不报,不能据此判冷读)
        usageRaw: usage.usageRaw ? JSON.stringify(usage.usageRaw).slice(0, 400) : null,
        switched: decision.switched, reason: decision.reason,
        // 决策证据(2026-11-03 tier 唯一):l1Type=L1 分类,diffTier=难度定档,tier=实际生效档
        l1Type, tier: decision.tier || null,
        suppressed: decision.suppressed, estTokens: estimateContextTokens(size),
        escalated: decision.escalated === true, routeMode,
        retryAttempts: attempts, retryTrail: retryTrail.length ? retryTrail : null, // 同轮重选轨迹(失败模型→重解析出的下一个)
        bodyBytes: size, cjkChars: countCjk(raw),
        cooled: cool || null, phaseTurns: state.get(convKey)?.humanTurns || 0,
        aborted: usage.aborted === true, // 客户端中断轮:上游已被拆除,本轮 outTok 只计到中断点
        durationMs: Date.now() - started,
      }, usageFile);
    });
  });
  return server;
}

function fallbackUpstream(upstreams) {
  const entries = Object.entries(upstreams.providers || {});
  for (const [providerId, p] of entries) if (p.enabled !== false && p.apiKey) return { providerId, ...p };
  return entries[0]?.[1] ? { providerId: entries[0][0], ...entries[0][1] } : { baseUrl: '', apiKey: '', anthropic: true, models: [] };
}

// inventory 统一由 modelRoute.mjs 的 inventoryFromUpstreams 提供(查询端/改写端同一份口径)。

/** 代理改写端的解析输入:两个键一次取齐,缺省回落解析器默认。 */
function mrRoutingOptions(configPath = path.join(DATA_DIR, 'code-index.config.json')) {
  const mr = readJson(configPath)?.modelRouting || {};
  return {
    providerPriority: Array.isArray(mr.providerPriority) ? mr.providerPriority : [],
    aliases: mr.aliases && typeof mr.aliases === 'object' && !Array.isArray(mr.aliases) ? mr.aliases : {},
    // 品牌优先序(2026-11-03):config.modelRouting.brandPriority 覆盖默认;只排四档链档内顺序,不改档位归属
    brandPriority: Array.isArray(mr.brandPriority) && mr.brandPriority.length ? mr.brandPriority : DEFAULT_BRAND_PRIORITY,
  };
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i += 1) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

// ---------- CLI ----------

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self);
if (directRun) {
  const argv = process.argv;
  const has = (f) => argv.includes(f);
  const val = (f, def) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : def);
  if (has('--snapshot-upstreams')) {
    // --tier-priority/--clear-priority 已随 role 链删除(2026-11-03):四档链档内排序由 brandPriority 决定
    console.log(JSON.stringify(snapshotUpstreams({ home: HOME, outFile: val('--out', UPSTREAMS_FILE) })));
  } else {
    const port = Number(val('--port', 8117));
    const server = createProxyServer({ port, upstreamsFile: val('--upstreams-file', UPSTREAMS_FILE) });
    // 端口已被占用 = 已有实例在服务,静默退出(端口互斥天然单例,不做重复拉起)
    server.on('error', (err) => {
      if (err?.code === 'EADDRINUSE') process.exit(0);
      console.error(`[model-route-proxy] listen 失败:${err?.message || err}`);
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', () => {
      // pid 文件:宿主钩子据此判定"代理在跑"的最快路径(零网络探测)
      const pidFile = path.join(DATA_DIR, 'usage', 'proxy.pid');
      try {
        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port, ts: Date.now() }) + '\n');
      } catch { /* 记不上不影响服务 */ }
      const cleanup = () => { try { const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8')); if (Number(rec.pid) === process.pid) fs.unlinkSync(pidFile); } catch { /* 已清理 */ } };
      process.on('exit', cleanup);
      process.on('SIGINT', () => { cleanup(); process.exit(0); });
      process.on('SIGTERM', () => { cleanup(); process.exit(0); });
      console.log(`[model-route-proxy] listening on http://127.0.0.1:${port}(按 turn 分类改写 model,双协议适配:anthropic/openai,SSE 透传)`);
    });
  }
}
