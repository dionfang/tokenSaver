/**
 * 动态模型路由核心(model-routing.md #9/#7/#8;学名「动态模型路由」):
 *   L2 向量分类 --build-vectors 构建 + cosine kNN(影子模式,只写 shadow 日志;默认**不通电**——
 *     影子/CLI 需 --l2 或 modelRouting.l2Shadow=true 才加载嵌入模型,2026-11-01 实测此前 L2 从未运行过)
 *   L3 已取消(2026-11-03 用户定档:语义兜底由四档分档承担)——级联收敛为 L1→L2
 *   四档链派生 deriveTierChains(快照按 tierOfModel 分桶,档内品牌优先序+档位序数排序)
 *     + 级联解析 resolveTier(目标档起 R4→R3→R2→R1 逐档下滑;档内解析复用 resolveRole:
 *       裸名/家族匹配/@pin/"default"/providerPriority/健康冷却)
 *   健康冷却 model-health.json(--health-mark/--health-clear/--health-list)
 *   doctor --doctor(门控/四档链/inventory/健康/L2 状态逐项报告)
 * 独立模块:不改任何既有代码;prompt-guard 的 L1 注入路径与本模块解耦(L2/L3 走 shadow 日志)。
 * role 两档制已废(2026-11-03 用户终裁:tier 四档难度制唯一;deriveRoleChains/roles 映射随 routeMode 删除,
 * resolveRole 保留为通用链解析器,resolveTier 每档内复用)。
 * CLI:node modelRoute.mjs --build-vectors | --classify [--l2] "<prompt>" | --resolve --tier R3 [--current p/m]
 *      | --score-golden [--golden 文件] | --doctor | --health-mark <provider/model> [--reason x] [--ttl 30m] | --health-clear <key> | --health-list
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { normalizeType, L1_TYPES, classifyPrompt } from './classify.mjs';
import { classifyDifficulty, loadTierCalibration, TIER_FROM_TYPE } from './tierClassify.mjs';
import { promptKey } from './buildExemplars.mjs';

const HOME = os.homedir();
const VECTORS_PATH = path.join(DATA_DIR, 'routing', 'exemplars-vectors.json');
const HEALTH_PATH = path.join(DATA_DIR, 'model-health.json');
const SHADOW_LOG = path.join(DATA_DIR, 'usage', 'routing-shadow.jsonl');
const L2_MIN_SIM = 0.55;
const L2_MIN_CONF = 0.6; // 2026-11-02:与 init 骨架/本机配置对齐(黄金集扫描定档:0.6 覆盖 15/50 准确 93%;0.75 只覆盖 6/50)
const TYPES = ['multi', 'routine', 'light'];

const TYPE_DEFS = {
  multi: '多点改组(重构/迁移/批量/方案,建议档 R2)', routine: '例行工作(报错/单点编辑/审查/测试)',
  light: '询问杂务(问答/文档/chore)',
};

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// ---------- L2 向量分类 ----------

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/** 用 embedFn 对样本库逐条嵌入,写 data/routing/exemplars-vectors.json。embedFn 可注入测试。 */
export async function buildVectors({ dataDir = DATA_DIR, embedFn, failFast = false } = {}) {
  const exPath = path.join(dataDir, 'routing', 'exemplars.json');
  const ex = readJson(exPath);
  if (!ex || !Array.isArray(ex.exemplars) || !ex.exemplars.length) throw new Error(`样本库缺失或为空: ${exPath}`);
  const vectors = {};
  let ok = 0, fail = 0;
  for (const e of ex.exemplars) {
    try {
      const v = await embedFn(e.prompt);
      if (Array.isArray(v) && v.length) { vectors[e.id] = { label: e.label, rule: e.labelRule || '', v }; ok += 1; continue; }
    } catch (err) { if (failFast) throw err; }
    fail += 1;
  }
  const doc = { version: 1, builtAt: new Date().toISOString(), dim: ok ? vectors[Object.keys(vectors)[0]].v.length : 0, ok, fail, vectors };
  const out = path.join(dataDir, 'routing', 'exemplars-vectors.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc));
  return { ok, fail, out, dim: doc.dim };
}

export function loadVectors(dataDir = DATA_DIR) {
  const d = readJson(path.join(dataDir, 'routing', 'exemplars-vectors.json'));
  if (!d || !d.vectors) return null;
  return d;
}

/** cosine kNN 加权投票:sim≥minSim 的 top-k 邻居按相似度加权,输出 type+confidence。
 *  自证降权(2026-11-04 用户定档):rule 含 l2 的近邻=其标签曾有 L2 票参与签出,相似度按
 *  taintFactor(默认 0.5)折算后再进标签权重/置信/top-k 排序——阻断"L2 签出的标教 L2"循环;
 *  旧向量文件无 rule 字段按未污染算,下次重建向量后自动生效。 */
export function knnClassify(vector, vectorsDoc, { k = 5, minSim = L2_MIN_SIM, taintFactor = 0.5 } = {}) {
  if (!vector || !vectorsDoc?.vectors) return null;
  const sims = Object.entries(vectorsDoc.vectors)
    .map(([id, e]) => {
      const sim = cosine(vector, e.v);
      const tainted = !!(e.rule && /l2/i.test(String(e.rule)));
      return { id, label: normalizeType(e.label), sim, tainted, eff: sim * (tainted ? taintFactor : 1) };
    })
    .filter((x) => x.sim >= minSim)
    .sort((a, b) => b.eff - a.eff)
    .slice(0, k);
  if (!sims.length) return null;
  const weight = {};
  let total = 0;
  for (const n of sims) { weight[n.label] = (weight[n.label] || 0) + n.eff; total += n.eff; }
  const best = Object.entries(weight).sort((a, b) => b[1] - a[1])[0];
  // 置信口径(2026-11-03 修"过信"):首近邻相似度 × 相对最近**异类**近邻的领先边际——
  // 旧口径 best/total 在单近邻时恒为 1(sim 0.57 也报 0.99);全同类近邻边际=1 → conf=sim;
  // 有贴近的异类近邻 → 置信骤降=弃权,由调用方 minConf 门槛兜住(拿不准不切)。
  const top1 = sims[0].eff;
  const rival = sims.find((n) => n.label !== best[0])?.eff ?? 0;
  const confidence = Math.round(Math.min(0.99, top1 > 0 ? top1 * ((top1 - rival) / top1) : 0) * 100) / 100;
  return { type: best[0], confidence, neighbors: sims, source: 'L2' };
}

// ---------- 模型价格档位(2026-11-02,用户定档:max>pro>plus>普通>flash,后缀不分大小写) ----------
// 供四档链派生排序使用(L3 层已于 2026-11-03 取消——语义兜底由四档分档承担)。

const TIER_ORDER = { flash: 0, normal: 1, plus: 2, pro: 3, max: 4 }; // 数值越小越便宜
const NON_CHAT_RE = /wan\d|image|audio|tts|asr|video|realtime|decision-model/i; // 图像/语音/视频/判定 API 不参与(preview 2026-11-04 用户定档=R2 档,参与路由)
/** Kimi 专用档位映射(2026-11-02 用户定档):容量标记 256K 当 flash 同级;coding 关键词 = plus 档。
 *  只在最后一个非纯数字段上命中,不影响其它模型的既有档位判断。 */
const KEYWORD_TIERS = { '256k': 'flash', coding: 'plus' };

/**
 * 模型价格档位基元:取最后一个非纯数字段(剥掉 -0813 这类日期尾缀),按小写等值比对;无档位段=普通。
 * 角色链派生 deriveRoleChains 已随 role 两档制删除(2026-11-03):四档链档内排序由品牌优先序+档位序数承担。
 */
export function tierOf(modelId) {
  const tokens = String(modelId || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i].toLowerCase();
    if (/^\d+$/.test(t)) continue;
    if (KEYWORD_TIERS[t]) return KEYWORD_TIERS[t];
    if (t === 'flash' || t === 'plus' || t === 'pro' || t === 'max') return t;
    break;
  }
  return 'normal';
}

// ---------- 四档模型分级(2026-11-02 用户定档;2026-11-06 v3 重排价带,v3.1 无后缀普通入 R2) ----------
// v3.1 定档(2026-11-06 用户定档):flash **R1**;无后缀普通(glm-5.3/MiniMax-M3)入 **R2**(与 pro/max 同档);
// 旗舰品牌分两层——普通旗舰款(Kimi-K3/K2.7-Code)**R3**,顶配 pro/max(k3.1-pro)**R4**。价带:
//   R1 = flash——最便宜日常主力价带;
//   R2 = 无后缀普通(非旗舰)/ pro/max(非旗舰)/ 一切便宜变体(preview/coding/turbo/mini/haiku/lite/base…);
//   R3 = 旗舰品牌普通款(无便宜后缀、非 pro/max;K2.7-Code 的 code 不算便宜变体);
//   R4 = 旗舰品牌顶配(pro/max)。
const PREMIUM_BRAND_RE = /(kimi|moonshot|gpt|openai|claude|anthropic|gemini|grok|\bxai\b)/i;
const KIMI_K_RE = /^k\d/i; // k3.1-pro = Kimi K3.1(裸 k+数字前缀)
const CHEAP_VARIANT_TOKENS = new Set(['preview', 'coding', 'turbo', 'mini', 'air', 'nano', 'event', 'haiku', 'luna', 'lite', 'base']); // v3:便宜变体+超便宜一律 R2
export const TIER_RANK = { R1: 1, R2: 2, R3: 3, R4: 4 };
export const TIER_ORDER_DESC = ['R4', 'R3', 'R2', 'R1']; // 降档方向

/** 模型 id → 四档(R1/R2/R3/R4)。v3.1 价带:flash→R1,无后缀普通/pro/max→R2,旗舰普通款→R3,旗舰顶配→R4。纯函数可测。 */
export function tierOfModel(modelId) {
  const id = String(modelId || '');
  const tokens = id.split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase());
  const suffix = tierOf(id); // flash/normal/plus/pro/max(既有价格档,内部基元)
  const premium = PREMIUM_BRAND_RE.test(id) || KIMI_K_RE.test(id);
  // pro/max 判定要 token 感知:tierOf 只认词尾,pro-x/gpt-max-x 这类"后缀再接词"会被解析成 normal
  const proMax = suffix === 'pro' || suffix === 'max' || tokens.includes('pro') || tokens.includes('max');
  // 1. flash → R1(v3.1:flash=最便宜日常主力价带;品牌 flash 也截在此档不升 R3/R4)
  if (suffix === 'flash' || tokens.includes('flash')) return 'R1';
  // 2. 便宜变体/超便宜(preview/coding/turbo/haiku/lite/base…)一律 R2(2026-11-06 用户定档:与 pro/max 同档)
  if (tokens.some((t) => CHEAP_VARIANT_TOKENS.has(t))) return 'R2';
  // 3. 旗舰品牌:pro/max=顶配 R4;其余无便宜后缀普通款(Kimi-K3/K2.7-Code)⇒ 普通旗舰 R3(2026-11-06 用户定档)
  if (premium) return proMax ? 'R4' : 'R3';
  // 4. 非旗舰 pro/max ⇒ R2(增强档,v3 从 R3 降)
  if (proMax) return 'R2';
  // 5. 非旗舰无后缀普通(glm-5.3/MiniMax-M3)⇒ R2(v3.1:与 pro/max 同档,不再与 flash 同档)
  if (suffix === 'normal') return 'R2';
  // 6. plus 及其余 ⇒ R2
  return 'R2';
}

// ---------- 品牌优先序(2026-11-03 用户需求:config 定义品牌调用顺序,只排"档内谁先被调",不改档位归属) ----------
export const DEFAULT_BRAND_PRIORITY = ['glm', 'minimax', 'deepseek', 'qwen', 'kimi', 'grok', 'claude', 'gpt', 'gemini'];
// 品牌别名收敛:公司名/历史名 → 用户优先序里的规范品牌名(与 PREMIUM_BRAND_RE 同义)
const BRAND_ALIAS = { moonshot: 'kimi', openai: 'gpt', chatgpt: 'gpt', anthropic: 'claude', xai: 'grok' };
const BRAND_TOKENS = ['glm', 'minimax', 'deepseek', 'qwen', 'kimi', 'grok', 'claude', 'gpt', 'gemini', 'moonshot', 'openai', 'chatgpt', 'anthropic', 'xai'];

/** 模型 id → 规范品牌名(小写);k\d 前缀=kimi;别名收敛;token 精确优先,连写(qwen3.8/glm-5.3)走子串兜底;无匹配 null。纯函数可测。 */
export function brandOf(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/^k\d/.test(id)) return 'kimi'; // k3.1-pro → kimi
  const tokens = id.split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of tokens) {
    if (BRAND_ALIAS[t]) return BRAND_ALIAS[t];
    if (BRAND_TOKENS.includes(t)) return t;
  }
  for (const b of BRAND_TOKENS) if (id.includes(b)) return BRAND_ALIAS[b] || b; // qwen3.8-max/chatglm 等连写
  return null;
}

/** 品牌在优先序里的名次(0=最先被调);未列出/未识别的品牌排到所有已知品牌之后,仍按档位序数/名确定性。 */
function brandRank(brand, priority) {
  if (!brand) return priority.length;
  const i = priority.indexOf(brand);
  return i === -1 ? priority.length : i;
}

/**
 * 四档链自动派生:从实时上游快照按 tierOfModel 分桶。
 * 档内排序(2026-11-03 用户裁定):**品牌优先序为主键**(config.modelRouting.brandPriority,决定"同档谁先被调"),
 *   同品牌再按档位序数升序(TIER_ORDER:flash0<normal1<plus2<pro3<max4,名字档位关键词的序数非真实单价,冷却时自然滑到次序),最后 modelId 保确定性。
 * 档位归属(tierOfModel)与降档级联(resolveTier)完全不受品牌序影响 —— 即"不影响动态模型路由的调用档位"。
 * 返回 {r1,r2,r3,r4, derived:true};空档为 []。排除图像/语音/视频/判定 API(NON_CHAT_RE 同口径)。
 */
export function deriveTierChains(upstreams, { brandPriority = DEFAULT_BRAND_PRIORITY } = {}) {
  const priority = Array.isArray(brandPriority) && brandPriority.length
    ? brandPriority.map((b) => String(b).toLowerCase())
    : DEFAULT_BRAND_PRIORITY;
  const buckets = { R1: [], R2: [], R3: [], R4: [] };
  const seen = new Set();
  for (const [pid, p] of Object.entries(upstreams?.providers || {})) {
    if (p?.enabled === false || !p?.apiKey) continue;
    for (const m of p.models || []) {
      const id = String(m || '');
      if (!id || seen.has(id) || NON_CHAT_RE.test(id)) continue;
      seen.add(id);
      buckets[tierOfModel(id)].push({ modelId: id, price: TIER_ORDER[tierOf(id)] ?? 1, brand: brandOf(id) }); // price=名字档位序数,非真实单价
    }
  }
  const out = { derived: true };
  for (const t of TIER_ORDER_DESC) {
    out[t.toLowerCase()] = buckets[t]
      .sort((a, b) => brandRank(a.brand, priority) - brandRank(b.brand, priority)
        || a.price - b.price || a.modelId.localeCompare(b.modelId))
      .map((c) => c.modelId);
  }
  return out;
}

// ---------- 级联(L1→L2,影子/查询口径;L3 已于 2026-11-03 取消) ----------

/** 完整级联:L1 强信号即决策;否则 L2 kNN;L3 已取消(语义兜底由四档分档承担)。
 *  返回 {source,type,confidence,...} 或 {source:'none'}。 */
export async function classifyRoute(prompt, { dataDir = DATA_DIR, cfg = null, embedFn = null, vectorsDoc = null } = {}) {
  const c = cfg || readJson(path.join(dataDir, 'code-index.config.json')) || {};
  const mr = c.modelRouting || {};
  const l1 = classifyPrompt(prompt);
  if (l1 && l1.confidence >= 0.7) return { ...l1, source: 'L1' };
  // L2 阈值可配(2026-11-01 黄金集扫描):minSim/minConf 缺省取常量;
  // 扫描结论(minSim 0.55):minConf 0.75 覆盖 6/50 且准确 100%,0.6 覆盖 15/50 且准确 93%。
  const l2cfg = mr.l2 && typeof mr.l2 === 'object' && !Array.isArray(mr.l2) ? mr.l2 : {};
  const minSim = Number.isFinite(Number(l2cfg.minSim)) ? Number(l2cfg.minSim) : L2_MIN_SIM;
  const minConf = Number.isFinite(Number(l2cfg.minConf)) ? Number(l2cfg.minConf) : L2_MIN_CONF;
  // 无 embedFn(影子 CLI)时跳过 3MB 向量表加载——L2 本就需要嵌入,不白读
  const l2v = vectorsDoc || (embedFn ? loadVectors(dataDir) : null);
  if (l2v && embedFn) {
    try {
      const v = await embedFn(prompt);
      const l2 = knnClassify(v, l2v, { minSim });
      if (l2 && l2.confidence >= minConf) return l2;
    } catch { /* L2 失败落 none */ }
  }
  return { source: 'none', type: l1?.type ?? null, confidence: l1?.confidence ?? 0 };
}

/** 影子结果落 shadow 日志(与 L1 的 routing-log 分开,口径不同)。 */
export function logShadow({ dataDir = DATA_DIR, prompt = '', result = null } = {}) {
  try {
    const rec = { ts: Date.now(), promptHead: String(prompt || '').slice(0, 200), source: result?.source ?? 'none', type: result?.type ?? null, confidence: result?.confidence ?? 0 };
    fs.mkdirSync(path.dirname(SHADOW_LOG), { recursive: true });
    fs.appendFileSync(SHADOW_LOG, JSON.stringify(rec) + '\n');
    return true;
  } catch { return false; }
}

/**
 * 四档难度影子记录(2026-11-02 用户裁定 point3:只算不改,真实流量零变化)。
 * 与分类器影子(logShadow)同文件 routing-shadow.jsonl,用 source:'tier' 区分;路径按注入 dataDir 算(可测)。
 * 记:难度档 + 置信 + 理由 + 本该切的档/模型/供应商 + 是否降档 + 实弹实际发的模型(对账"影子 vs 实弹")。
 * 自进化证据回流(2026-11-04):新增 pkey/decisionTier/escalated/switched/servedTier/ambWouldTier——
 *   escalated(本轮 P2 上梯)+ servedTier(实弹服务档)是黄金集行为真值唯一可达的 R2/R3 硬证据;
 *   ambWouldTier = 歧义轮(置信≤0.5 的 R1)"改判 R2"的裸解析结果(影子 A/B 观察,不改实弹)。
 */
export function logTierShadow({ dataDir = DATA_DIR, prompt = '', tier = null, tierConfidence = 0, tierReason = '', wouldTier = null, wouldModel = null, wouldProvider = null, downgraded = false, servedModel = null, decisionTier = null, escalated = false, switched = null, servedTier = null, ambWouldTier = null, ambWouldModel = null, host = null } = {}) {
  try {
    const head = String(prompt || '').slice(0, 200);
    const rec = { ts: Date.now(), pkey: promptKey(head), promptHead: head, source: 'tier', tier, confidence: tierConfidence, tierReason, wouldTier, wouldModel, wouldProvider, downgraded, servedModel, decisionTier, escalated, switched, servedTier, ambWouldTier, ambWouldModel, host };
    const file = path.join(dataDir, 'usage', 'routing-shadow.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return true;
  } catch { return false; }
}

// ---------- 健康冷却(#8) ----------

export function readHealth(dataDir = DATA_DIR) {
  return readJson(path.join(dataDir, 'model-health.json')) || { models: {} };
}

export function cooling(modelKey, health, now = Date.now()) {
  const e = health?.models?.[modelKey];
  return !!(e && Number(e.cooldownUntil) > now);
}

export function markHealth({ dataDir = DATA_DIR, modelKey, reason = '', ttlMs = 30 * 60 * 1000, until = null, capMs = null } = {}) {
  try {
    const h = readHealth(dataDir);
    const now = Date.now();
    h.models = h.models || {};
    // 渐进退避(2026-11-04):同一 provider/model 跨冷却窗口累计失败数,冷却时长 = 基础 TTL × 2^(N-1),按族封顶
    // (capMs 由代理按错误族传入;不传=不启用退避,CLI 手动标记与旧口径一致)。
    // 目标键的过期记录保留——只为计数(否则过期一回收,退避永远回到第 1 次);其余过期条目照旧回收(H5)。
    const prev = h.models[modelKey];
    const failCount = (Number(prev?.failCount) || 0) + 1;
    for (const [k, v] of Object.entries(h.models)) {
      if (k === modelKey) continue;
      if (!v || !(Number(v.cooldownUntil) > now)) delete h.models[k];
    }
    const base = until == null ? ttlMs : Math.max(0, until - now);
    const effTtl = until != null || capMs == null ? base : Math.min(base * 2 ** (failCount - 1), capMs);
    h.models[modelKey] = { cooldownUntil: now + effTtl, reason, failCount };
    fs.writeFileSync(path.join(dataDir, 'model-health.json'), JSON.stringify(h, null, 2) + '\n');
    return true;
  } catch { return false; }
}

export function clearHealth({ dataDir = DATA_DIR, modelKey } = {}) {
  try {
    const h = readHealth(dataDir);
    // 无记录不写盘:成功清零在每请求热路径上调用,健康表通常为空,避免每请求一次磁盘写
    if (!h.models || !(modelKey in h.models)) return true;
    delete h.models[modelKey];
    fs.writeFileSync(path.join(dataDir, 'model-health.json'), JSON.stringify(h, null, 2) + '\n');
    return true;
  } catch { return false; }
}

// ---------- 降级链解析器(#7) ----------

export function familyOf(modelId) {
  return String(modelId || '').replace(/-(\d{4,8})$/, '');
}

/** inventory: [{providerId, modelId, enabled}] */
function candidatesByName(inventory, name, pin) {
  const want = String(name).toLowerCase();
  const out = { exact: [], family: [] };
  for (const m of inventory) {
    if (pin && m.providerId !== pin) continue;
    const id = String(m.modelId || '');
    if (id.toLowerCase() === want) out.exact.push(m);
    else if (familyOf(id).toLowerCase() === want) out.family.push(m);
  }
  return out;
}

function byProviderPriority(list, priority) {
  const rank = (pid) => { const i = (priority || []).indexOf(pid); return i === -1 ? (priority || []).length : i; };
  return list.slice().sort((a, b) => rank(a.providerId) - rank(b.providerId));
}

/**
 * 通用链解析(#7 规格,resolveTier 每档内复用):链上条目依次尝试,命中即返回。
 * 条目:裸模型名(程序找供应商与最新版本)/ "name@providerId" 钉死 / "default"=currentModel。
 * currentModel 未知时跳过 default;健康冷却中的候选跳过;全链落空 → {fallback:'session-current'}。
 */
export function resolveRole(role, { cfg = {}, inventory = [], health = {}, currentModel = null, now = Date.now() } = {}) {
  const mr = cfg.modelRouting || {};
  const chain = mr.chains?.[role];
  if (!Array.isArray(chain)) return { error: `未知链键或未配置链: ${role}` };
  const priority = mr.providerPriority || [];
  const order = mr.providerOrder || []; // 宿主 UI 供应商拖动序(快照采集):同名模型在 providerPriority 之后的次级取序
  const aliases = mr.aliases || {};
  const seenKeys = new Set();
  let index = 0;
  for (const raw of chain) {
    const entry = String(raw);
    index += 1;
    if (entry === 'default') {
      if (currentModel && currentModel.providerId && currentModel.modelId) {
        const key = `${currentModel.providerId}/${currentModel.modelId}`;
        if (!cooling(key, health, now)) {
          return { providerId: currentModel.providerId, modelId: currentModel.modelId, matchedBy: 'default', chainIndex: index };
        }
      }
      continue;
    }
    let name = entry;
    let pin = null;
    const at = entry.indexOf('@');
    if (at > 0) { name = entry.slice(0, at); pin = entry.slice(at + 1); }
    if (aliases[name]) name = aliases[name];
    const { exact, family } = candidatesByName(inventory, name, pin);
    // #7 规格:providerPriority 是外层循环,匹配方式(精确>家族)是内层——同名字多供应商按优先级取;
    // 未进 priority 的同名供应商按 providerOrder(宿主 UI 拖动序,2026-11-05)排——UI 把谁排前,冷却滑动就先耗谁
    const pools = new Map();
    for (const c of exact) {
      const a = pools.get(c.providerId) || { exact: [], family: [] };
      a.exact.push(c);
      pools.set(c.providerId, a);
    }
    for (const c of family) {
      const a = pools.get(c.providerId) || { exact: [], family: [] };
      a.family.push(c);
      pools.set(c.providerId, a);
    }
    const rank = (pid) => { const i = priority.indexOf(pid); return i === -1 ? priority.length : i; };
    const rankO = (pid) => { const i = order.indexOf(pid); return i === -1 ? order.length : i; };
    const providers = [...pools.keys()].sort((a, b) => rank(a) - rank(b) || rankO(a) - rankO(b));
    for (const pid of providers) {
      const { exact: ex, family: fam } = pools.get(pid);
      for (const cand of [...ex, ...fam]) {
        const key = `${cand.providerId}/${cand.modelId}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (cand.enabled === false) continue;
        if (cooling(key, health, now)) continue;
        return {
          providerId: cand.providerId, modelId: cand.modelId,
          matchedBy: ex.includes(cand) ? 'exact' : 'family', chainIndex: index,
        };
      }
    }
  }
  return { fallback: 'session-current', warn: `role=${role} 整条降级链无可用版本` };
}

/**
 * 四档级联解析(2026-11-02 用户定档:高档无可用模型自动降档)。
 * 从目标档起沿 R4→R3→R2→R1 逐档下滑,命中第一个有可用模型的档即返回;全落空 → session-current(sticky)。
 * 每档内复用 resolveRole 的链解析(冷却/disabled 跳过、providerPriority/aliases 透传)。
 * reachable 可选:传入则额外要求代理可达(与 decideTarget 转发端同口径),不可达视同该档无模型继续降。
 * 返回 {providerId,modelId,tier,downgraded,...} 或 {fallback:'session-current',tier:null}。
 */
export function resolveTier(targetTier, { cfg = {}, inventory = [], health = {}, currentModel = null, now = Date.now(), reachable = null } = {}) {
  const want = String(targetTier || '').toUpperCase();
  const start = TIER_ORDER_DESC.indexOf(want);
  const tiers = start === -1 ? TIER_ORDER_DESC : TIER_ORDER_DESC.slice(start);
  for (const t of tiers) {
    const key = t.toLowerCase();
    const chain = cfg.modelRouting?.chains?.[key];
    if (!Array.isArray(chain) || !chain.length) continue;
    const r = resolveRole(key, { cfg, inventory, health, currentModel, now });
    if (!r || !r.modelId) continue;
    if (reachable && !reachable({ providerId: r.providerId, model: r.modelId })) continue;
    return { ...r, tier: t, downgraded: t !== want };
  }
  return { fallback: 'session-current', tier: null, downgraded: false, warn: `四档链全部无可用模型(target=${want || '未指定'})` };
}

// ---------- 代理可达性(与代理转发端同口径,查询端/改写端共用) ----------

/** 上游快照:代理转发用的真实 baseUrl/key/模型清单 + ingress(客户端把 baseUrl 切到代理的入口供应商)。 */
export function readUpstreamsSnapshot(file = path.join(DATA_DIR, 'routing', 'proxy-upstreams.json')) {
  return readJson(file) || { providers: {} };
}

/** 快照 inventory → resolveRole 候选列表(代理侧唯一可转发的模型来源)。 */
export function inventoryFromUpstreams(upstreams) {
  const inv = [];
  for (const [providerId, p] of Object.entries(upstreams?.providers || {})) {
    for (const m of p.models || []) inv.push({ providerId, modelId: m, enabled: p.enabled !== false });
  }
  return inv;
}

/**
 * 代理可达性:存在 + enabled + 有 key + 持有该模型 —— 与 pickUpstream 的转发条件逐条一致。
 * 此前 decideTarget 的判定少了 apiKey 一项,会出现"判定可达→实际回落他人"的空档(H3)。
 */
export function isProxyReachable({ providerId, model, upstreams } = {}) {
  const p = upstreams?.providers?.[providerId];
  if (!p || p.enabled === false || !p.apiKey) return false;
  return (p.models || []).includes(model);
}

/** 入口供应商:客户端把 baseUrl 切到本代理的那几个(请求必经它们进来)。 */
export function ingressProviders(upstreams) {
  const explicit = Array.isArray(upstreams?.ingress) ? upstreams.ingress : [];
  const marked = Object.entries(upstreams?.providers || {}).filter(([, p]) => p.ingress === true).map(([id]) => id);
  return [...new Set([...explicit, ...marked])];
}

// ---------- inventory 收集(best-effort) ----------

/** ZCode:provider_config 的自定义供应商 + 内置模板的账号供应商(凭据存在才认)。 */
export function collectInventory(home = HOME) {
  const out = [];
  const pc = readJson(path.join(home, '.zcode', 'v2', 'provider_config.json'));
  for (const r of pc?.config?.providerConfigRules?.providerRules || []) {
    const enabled = r.enabled !== false && r.config?.enabled !== false;
    for (const m of r.config?.personalModelIds || []) out.push({ providerId: r.providerId, modelId: m, enabled, source: 'zcode-custom' });
  }
  const builtinPath = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const builtin = builtinPath ? readJson(builtinPath) : null;
  const cred = readJson(path.join(home, '.zcode', 'v2', 'credentials.json')) || {};
  const credKeys = Object.keys(cred);
  const hasBigmodel = credKeys.some((k) => k.includes('oauth:bigmodel:access_token'));
  const hasZai = credKeys.some((k) => k.includes('zcodejwttoken')) || credKeys.some((k) => k.includes('zai'));
  const templates = builtin?.config?.providerConfigRules?.templateRules || [];
  for (const t of templates) {
    if (t.config?.access?.type !== 'zhipu-coding-plan-api-key') continue;
    const id = String(t.templateId || '');
    const providerId = id.startsWith('zai') ? 'account:zai-start-plan' : id.startsWith('bigmodel') ? 'account:bigmodel-start-plan' : null;
    if (!providerId) continue;
    const enabled = providerId.startsWith('account:zai') ? hasZai : hasBigmodel;
    for (const m of t.config.builtinModelIds || []) out.push({ providerId, modelId: m, enabled, source: 'zcode-builtin' });
  }
  return out;
}

// ---------- 黄金集打分(#14 验证闭环) ----------

/** 目标线(2026-11-06 三档定稿):light/routine ≥0.85,multi 边界最糊 ≥0.7(P2 证据升级兜底其余)。 */
const GOLDEN_TARGETS = { light: 0.85, routine: 0.85, multi: 0.7 };

/**
 * 黄金集打分:以 humanLabel 槽位为真值算 L1 准确率/各类命中/错分清单。
 * 该槽位现由四票代签写入(人工环节 2026-11-02 废,历史人工/构造条目 2026-11-04 清空),而 L1 本身就是
 *   其中一票 ⇒ 用它评 L1 含自证成分:accuracyHuman 与 passAll 恒 null,只剩 accuracyAuto(与四票一致率)
 *   和弱真值 accuracy;对外报数必须标注弱真值口径,不得径称"准确率"。
 * 未签条目另给"与自动标签一致率",它是弱标注规则与 L1 的相符度,不是准确率,不得混用。
 * classifyFn 可注入以便测试密闭;黄金集缺失返回 {error},不抛。
 */
export function scoreGolden({ dataDir = DATA_DIR, goldenFile = null, classifyFn = classifyPrompt } = {}) {
  const file = goldenFile || path.join(dataDir, 'routing', 'golden-set.jsonl');
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return { error: `黄金集不可读: ${file}` }; }
  const calibrated = rows.filter((r) => L1_TYPES.includes(normalizeType(String(r.humanLabel || ''))));
  const perType = {};
  const misses = [];
  let correct = 0;
  for (const r of calibrated) {
    const label = normalizeType(String(r.humanLabel || ''));
    const pred = normalizeType(classifyFn(r.prompt)?.type ?? 'uncertain');
    const p = perType[label] || (perType[label] = { actual: 0, hit: 0 });
    p.actual += 1;
    if (pred === label) { p.hit += 1; correct += 1; } else misses.push({ id: r.id, actual: label, pred, promptHead: String(r.prompt || '').slice(0, 60) });
  }
  const perTypeOut = {};
  for (const [t, v] of Object.entries(perType)) {
    const acc = v.hit / v.actual;
    perTypeOut[t] = { actual: v.actual, hit: v.hit, acc: Number(acc.toFixed(3)), target: GOLDEN_TARGETS[t] ?? null, pass: GOLDEN_TARGETS[t] ? acc >= GOLDEN_TARGETS[t] : null };
  }
  const uncalibrated = rows.filter((r) => !L1_TYPES.includes(normalizeType(String(r.humanLabel || ''))));
  const agree = uncalibrated.length ? uncalibrated.filter((r) => normalizeType(classifyFn(r.prompt)?.type) === normalizeType(String(r.autoLabel || ''))).length : 0;
  // 来源切分(2026-11-02 自动代签后):自动签条目 humanLabel 来自四票多数,用它评 L1 会自证;
  // 故"外部真值"只取非自动签条目(人工/构造性真值),自动签部分单独报"与四票一致率"。
  // 2026-11-04:非自动签条目已全部删除 => humanRows=0、accuracyHuman=null、passAll=null,L1 自此无外部锚点。
  const humanRows = calibrated.filter((r) => !r.autoSigned);
  const autoRows = calibrated.filter((r) => r.autoSigned);
  const accOf = (arr) => {
    if (!arr.length) return null;
    const hit = arr.filter((r) => normalizeType(classifyFn(r.prompt)?.type ?? 'uncertain') === normalizeType(String(r.humanLabel || ''))).length;
    return Number((hit / arr.length).toFixed(3));
  };
  // 外部真值(非自动签)的逐类统计:passAll 只看这一部分
  const perTypeHuman = {};
  for (const r of humanRows) {
    const label = normalizeType(String(r.humanLabel || ''));
    const pred = normalizeType(classifyFn(r.prompt)?.type ?? 'uncertain');
    const p = perTypeHuman[label] || (perTypeHuman[label] = { actual: 0, hit: 0 });
    p.actual += 1;
    if (pred === label) p.hit += 1;
  }
  const perTypeHumanOut = {};
  for (const [t, v] of Object.entries(perTypeHuman)) {
    const acc = v.hit / v.actual;
    perTypeHumanOut[t] = { actual: v.actual, hit: v.hit, acc: Number(acc.toFixed(3)), target: GOLDEN_TARGETS[t] ?? null, pass: GOLDEN_TARGETS[t] ? acc >= GOLDEN_TARGETS[t] : null };
  }
  return {
    total: rows.length,
    calibrated: calibrated.length,
    uncalibrated: uncalibrated.length,
    accuracy: calibrated.length ? Number((correct / calibrated.length).toFixed(3)) : null,
    humanSigned: humanRows.length,
    autoSigned: autoRows.length,
    accuracyHuman: accOf(humanRows),
    accuracyAuto: accOf(autoRows),
    perTypeHuman: perTypeHumanOut,
    passAll: Object.keys(perTypeHumanOut).length
      ? Object.values(perTypeHumanOut).every((v) => v.pass === null || v.pass)
      : null,
    perType: perTypeOut,
    misses: misses.slice(0, 20),
    autoLabelAgreement: uncalibrated.length ? Number((agree / uncalibrated.length).toFixed(3)) : null,
  };
}

/** #14 档位目标线:R1/R2 ≥0.85;2026-11-04 v2 资费语义后 R3(仅 P2 上梯)/R4(仅显式点名)无词法可达真值
 *  (见 TIER_FROM_TYPE 注)恒 null,R3 目标线保留仅为兼容旧黄金数据。 */
const TIER_TARGETS = { R1: 0.85, R2: 0.85, R3: 0.8 };

/**
 * 黄金集**难度档**打分(Phase3c directive #1):以 TIER_FROM_TYPE[humanLabel] 派生的 R 真值评 classifyDifficulty。
 * 真值来源=四票代签的 T 标签经设计映射派生(人工环节 2026-11-02 废,构造性历史条目 2026-11-04 清空)。
 * 与被评的 classifyDifficulty 不同源(四票里没有它)+ 行为票是结果侧证据 ⇒ 非预测回灌;但 L1 词法票
 *   与难度分类器共享词法信号,独立性只到"合议弱真值",不及原注释宣称的外部人工真值。
 * accuracyHuman/accuracyAuto 切分保留兼容:外部真值现为空集 => accuracyHuman=null,报数一律取 accuracyAuto 并标注弱真值。
 * classifyFn 可注入以便测试密闭;黄金集缺失返回 {error},不抛。
 */
export function scoreGoldenTier({ dataDir = DATA_DIR, goldenFile = null, classifyFn = (t) => classifyDifficulty(t, { calibration: loadTierCalibration() }) } = {}) {
  const file = goldenFile || path.join(dataDir, 'routing', 'golden-set.jsonl');
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return { error: `黄金集不可读: ${file}` }; }
  // R 真值 = 代签 T 标签经设计映射;无 humanLabel(T1-T8)或映射外(R4 恒无 T 来源)⇒ 无 R 真值,跳过
  const withTruth = rows
    .map((r) => ({ r, tier: TIER_FROM_TYPE[String(r.humanLabel || '')] || null }))
    .filter((x) => x.tier);
  const perTier = {};
  const misses = [];
  let correct = 0;
  for (const { r, tier } of withTruth) {
    const pred = classifyFn(r.prompt)?.tier ?? 'R1';
    const p = perTier[tier] || (perTier[tier] = { actual: 0, hit: 0 });
    p.actual += 1;
    if (pred === tier) { p.hit += 1; correct += 1; } else misses.push({ id: r.id, actual: tier, pred, promptHead: String(r.prompt || '').slice(0, 60) });
  }
  const perTierOut = {};
  for (const [t, v] of Object.entries(perTier)) {
    const acc = v.hit / v.actual;
    perTierOut[t] = { actual: v.actual, hit: v.hit, acc: Number(acc.toFixed(3)), target: TIER_TARGETS[t] ?? null, pass: TIER_TARGETS[t] ? acc >= TIER_TARGETS[t] : null };
  }
  // 来源切分:自动代签条目的 T 标签来自四票多数(弱真值),派生的 R 也只算弱一致,不得混入外部真值准确率
  // (2026-11-04 非自动签条目清空后 humanRows 恒空 => accuracyHuman=null;判据保留只兼容旧数据)
  const humanRows = withTruth.filter((x) => !x.r.autoSigned);
  const autoRows = withTruth.filter((x) => x.r.autoSigned);
  const accOf = (arr) => {
    if (!arr.length) return null;
    const hit = arr.filter((x) => (classifyFn(x.r.prompt)?.tier ?? 'R1') === x.tier).length;
    return Number((hit / arr.length).toFixed(3));
  };
  return {
    total: rows.length,
    withTruth: withTruth.length,
    accuracy: withTruth.length ? Number((correct / withTruth.length).toFixed(3)) : null,
    humanSigned: humanRows.length,
    autoSigned: autoRows.length,
    accuracyHuman: accOf(humanRows),
    accuracyAuto: accOf(autoRows),
    perTier: perTierOut,
    // R4 覆盖恒为 0(无 T→R4 映射):明示,提醒 R4 真值只能靠影子行为证据补,别误以为已校准
    r4Coverage: perTierOut.R4 ? perTierOut.R4.actual : 0,
    passAll: Object.keys(perTierOut).length
      ? Object.values(perTierOut).every((v) => v.pass === null || v.pass)
      : null,
    misses: misses.slice(0, 20),
  };
}

// ---------- doctor ----------

export function doctor({ home = HOME, dataDir = DATA_DIR, cfg = null, currentModel = null, upstreamsFile = null, host = 'zcode' } = {}) {
  const c = cfg || readJson(path.join(dataDir, 'code-index.config.json')) || {};
  const mr = c.modelRouting || {};
  const health = readHealth(dataDir);
  const inventory = collectInventory(home);
  const vec = loadVectors(dataDir);
  // 代理可达性用同一份快照、同一条判定(isProxyReachable),避免"doctor 说能解析、代理说不可达"(H2)
  const upstreams = readUpstreamsSnapshot(upstreamsFile || path.join(dataDir, 'routing', 'proxy-upstreams.json'));
  // 四档链与代理端同口径:从快照按 tierOfModel 派生(brandPriority 用配置覆盖默认);role 人工链已废(2026-11-03)
  const brandPriority = Array.isArray(mr.brandPriority) && mr.brandPriority.length ? mr.brandPriority : DEFAULT_BRAND_PRIORITY;
  const tierChains = deriveTierChains(upstreams, { brandPriority });
  // 同名取序(2026-11-05):providerPriority(配置)优先,未进表的同名供应商按快照采集的 providerOrder
  // (宿主 UI 拖动序;Qoder 端=设置文件键序)排;报告口径=--host(默认 zcode)。配置同键 providerOrder 可覆盖快照序。
  const providerOrder = Array.isArray(mr.providerOrder) ? mr.providerOrder : (Array.isArray(upstreams?.providerOrder?.[host]) ? upstreams.providerOrder[host] : []);
  const snapInventory = inventoryFromUpstreams(upstreams);
  // 每档解析一次(快照口径,与代理转发同一份 inventory):报告各档链头与代理可达性
  const resolved = TIER_ORDER_DESC.map((t) => {
    const result = resolveTier(t, { cfg: { ...c, modelRouting: { ...mr, chains: tierChains, providerOrder } }, inventory: snapInventory, health, currentModel });
    const proxyReachable = !!(result.providerId && isProxyReachable({ providerId: result.providerId, model: result.modelId, upstreams }));
    return { tier: t, result, proxyReachable };
  });
  const proxyWarnings = resolved
    .filter((r) => r.result.providerId && !r.proxyReachable)
    .map((r) => `${r.tier} 档解析到 ${r.result.providerId}/${r.result.modelId},但代理快照里不可达(无 key / 不在清单 / 入口不一致)⇒ 代理端会判"不可达"并保持当前模型`);
  // 同名多挂提示(2026-11-03 用户场景:多 Token Plan、同名模型不同额度):同名模型挂多个**可用**
  // 供应商(有 key、enabled)且未配 providerPriority 时,同名取序=快照键序——doctor 把它点名,
  // 提示把"额度多/想先调"的供应商写进 modelRouting.providerPriority(或链里 模型@供应商 钉死)。
  const sameNameNotes = [];
  const byModel = new Map();
  for (const m of inventoryFromUpstreams(upstreams)) {
    if (m.enabled === false) continue;
    const p = upstreams.providers?.[m.providerId];
    if (!p || p.enabled === false || !p.apiKey) continue; // 与代理转发条件同口径:有 key 才真能被调
    const k = String(m.modelId || '').toLowerCase();
    if (!byModel.has(k)) byModel.set(k, new Set());
    byModel.get(k).add(m.providerId);
  }
  const priority = Array.isArray(mr.providerPriority) ? mr.providerPriority : [];
  const uiOrder = Array.isArray(upstreams?.providerOrder?.[host]) ? upstreams.providerOrder[host] : [];
  if (!priority.length) {
    for (const [model, pids] of [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (pids.size > 1) {
        sameNameNotes.push(`模型 ${model} 挂多供应商(${[...pids].sort().join(',')})且未配 modelRouting.providerPriority——同名取序=${uiOrder.length ? `${host === 'qoder' ? '设置文件键序' : '宿主 UI 拖动序'}(快照 providerOrder)` : '快照键序'};要显式改序,把想先调的供应商写进 providerPriority(或 providerOrder 覆盖 UI 序),或在链里用 模型@供应商 钉死`);
      }
    }
  }
  return {
    gate: { enabled: mr.enabled === true },
    tierChains,
    inventoryCount: inventory.length,
    inventorySources: [...new Set(inventory.map((x) => x.source))],
    health: health.models || {},
    l1: 'classify.mjs 规则表(常驻)',
    l2: vec ? `就绪(向量 ${vec.ok} 条/失败 ${vec.fail}/维度 ${vec.dim})` : '未构建(运行 --build-vectors)',
    proxySnapshot: { providers: Object.keys(upstreams.providers || {}).length, ingress: ingressProviders(upstreams) },
    resolved,
    proxyWarnings,
    sameNameNotes,
  };
}

// ---------- CLI ----------

function b64(s) { return Buffer.from(String(s || ''), 'utf8').toString('base64'); }
function unb64(s) { return Buffer.from(String(s || ''), 'base64').toString('utf8'); }

/** L2 通电开关:显式 --l2 或配置 modelRouting.l2Shadow=true 才加载嵌入模型。
 *  默认关=影子/CLI 不碰嵌入后端(每轮影子子进程加载模型会与主会话争资源,而影子日志只是观测)。
 *  2026-11-01 实测:此前所有入口(--shadow-async/--classify)都不传 embedFn ⇒ L2 从未运行过,
 *  routing-shadow.jsonl 193 条全为 source:'none'。这里把"通电"变成一条开关,而不是默认行为。 */
export function l2ShadowEnabled(cfg = {}, explicit = false) {
  return explicit === true || !!(cfg.modelRouting && cfg.modelRouting.l2Shadow === true);
}

export async function l2EmbedFn({ dataDir = DATA_DIR, explicit = false } = {}) {
  try {
    if (!l2ShadowEnabled(readJson(path.join(dataDir, 'code-index.config.json')) || {}, explicit)) return null;
    const { embedIntent } = await import('./rangePick.mjs');
    return (t) => embedIntent(t);
  } catch { return null; }
}

async function cli(argv) {
  const has = (f) => argv.includes(f);
  const val = (f, def) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : def);
  const dataDir = val('--data-dir', DATA_DIR);
  if (has('--build-vectors')) {
    const { embedIntent } = await import('./rangePick.mjs');
    const r = await buildVectors({ dataDir, embedFn: (t) => embedIntent(t) });
    console.log(JSON.stringify(r));
    return;
  }
  if (has('--shadow-async')) {
    const prompt = unb64(val('--prompt', ''));
    if (String(prompt).trim().length < 6) return; // 空/超短 prompt:分类器必弃权,不白起子进程
    const r = await classifyRoute(prompt, { dataDir, embedFn: await l2EmbedFn({ dataDir, explicit: has('--l2') }) });
    logShadow({ dataDir, prompt, result: r });
    return; // 影子进程静默退出
  }
  if (has('--classify')) {
    // prompt 取值:--prompt <b64> 优先;否则取 --classify 后面第一个非选项参数(旧写法会把紧跟的 --l2 当成 prompt)
    const prompt = argv.includes('--prompt') ? unb64(val('--prompt', '')) : (argv.slice(argv.indexOf('--classify') + 1).find((a) => !String(a).startsWith('-')) || '');
    const r = await classifyRoute(prompt, { dataDir, embedFn: await l2EmbedFn({ dataDir, explicit: has('--l2') }) });
    console.log(JSON.stringify(r));
    return;
  }
  if (has('--resolve')) {
    // 四档链解析(--tier R3):与代理转发同口径——快照派生四档链,resolveTier 从目标档降档级联
    const tier = String(val('--tier', 'R3')).toUpperCase();
    const cur = val('--current', '');
    const currentModel = cur.includes('/') ? { providerId: cur.split('/')[0], modelId: cur.split('/')[1] } : null;
    const cfg = readJson(path.join(dataDir, 'code-index.config.json')) || {};
    const mr = cfg.modelRouting || {};
    const upstreams = readUpstreamsSnapshot(path.join(dataDir, 'routing', 'proxy-upstreams.json'));
    const brandPriority = Array.isArray(mr.brandPriority) && mr.brandPriority.length ? mr.brandPriority : DEFAULT_BRAND_PRIORITY;
    const r = resolveTier(tier, { cfg: { ...cfg, modelRouting: { ...mr, chains: deriveTierChains(upstreams, { brandPriority }), providerOrder: Array.isArray(mr.providerOrder) ? mr.providerOrder : (Array.isArray(upstreams?.providerOrder?.[val('--host', 'zcode')]) ? upstreams.providerOrder[val('--host', 'zcode')] : []) } }, inventory: inventoryFromUpstreams(upstreams), health: readHealth(dataDir), currentModel });
    console.log(JSON.stringify(r));
    return;
  }
  if (has('--health-mark')) {
    const key = argv[argv.indexOf('--health-mark') + 1];
    const ttl = val('--ttl', '30m');
    const m = String(ttl).match(/^(\d+)(m|h|d)$/);
    const ms = m ? Number(m[1]) * ({ m: 60000, h: 3600000, d: 86400000 }[m[2]]) : 30 * 60 * 1000;
    console.log(JSON.stringify({ marked: markHealth({ dataDir, modelKey: key, reason: val('--reason', ''), ttlMs: ms }) }));
    return;
  }
  if (has('--health-clear')) { console.log(JSON.stringify({ cleared: clearHealth({ dataDir, modelKey: argv[argv.indexOf('--health-clear') + 1] }) })); return; }
  if (has('--health-list')) { console.log(JSON.stringify(readHealth(dataDir).models || {})); return; }
  if (has('--score-golden')) {
    console.log(JSON.stringify(scoreGolden({ dataDir, goldenFile: val('--golden', null) }), null, 1));
    return;
  }
  if (has('--score-golden-tier')) {
    console.log(JSON.stringify(scoreGoldenTier({ dataDir, goldenFile: val('--golden', null) }), null, 1));
    return;
  }
  if (has('--doctor')) {
    const cur = val('--current', '');
    const currentModel = cur.includes('/') ? { providerId: cur.split('/')[0], modelId: cur.split('/')[1] } : null;
    console.log(JSON.stringify(doctor({ dataDir, currentModel, host: val('--host', 'zcode') }), null, 1));
    return;
  }
  if (has('--kpi')) {
    // KPI 可测指标(#14 保留项,只读):升级触发率(P2 escalated)+ 每 session 切换数 + 缓存命中率。
    // 数据源=proxy-usage.jsonl;季度校准=重跑看趋势,不自动调参。
    const file = val('--usage', path.join(DATA_DIR, 'usage', 'proxy-usage.jsonl'));
    let rows = [];
    try {
      rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { /* 无账本 → 全零报表 */ }
    const total = rows.length;
    const convs = new Map();
    let switched = 0, escalated = 0, cacheRead = 0, inputSum = 0, cacheRows = 0;
    for (const r of rows) {
      if (r.switched === true) switched += 1;
      if (r.escalated === true) escalated += 1;
      if (r.conv != null) convs.set(r.conv, (convs.get(r.conv) || 0) + 1);
      if (r.cacheReported === true) {
        cacheRows += 1;
        cacheRead += Number(r.cacheRead) || 0;
        inputSum += (Number(r.inTok) || 0) + (Number(r.cacheRead) || 0);
      }
    }
    console.log(JSON.stringify({
      window: { from: rows[0]?.ts ?? null, to: rows[total - 1]?.ts ?? null },
      totalRequests: total,
      sessions: convs.size,
      switchRate: total ? Number((switched / total).toFixed(3)) : null,
      avgSwitchesPerSession: convs.size ? Number((switched / convs.size).toFixed(2)) : null,
      escalatedRequests: escalated,
      escalateRate: total ? Number((escalated / total).toFixed(3)) : null,
      cacheHitRate: inputSum > 0 ? Number((cacheRead / inputSum).toFixed(3)) : null,
      cacheSampledRows: cacheRows,
    }, null, 1));
    return;
  }
  console.error('用法: node modelRoute.mjs --build-vectors | --classify [--l2] "<prompt>" | --shadow-async --prompt <b64> | --resolve --tier R3 [--current p/m] | --score-golden [--golden 文件] | --score-golden-tier [--golden 文件] | --doctor [--current p/m] [--host zcode|qoder] | --kpi [--usage 文件] | --health-mark <provider/model> | --health-clear <key> | --health-list');
  process.exit(1);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) cli(process.argv).catch((e) => { console.error('[err]', e.message); process.exit(1); });

