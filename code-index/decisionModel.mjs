/**
 * 决策模型接入(判定 API,不是可选择的对话模型——不出现在模型选择器里,只能由脚本调用)。
 *
 * **v4 本地化收口(2026-11-09 用户裁定)**:远程 systemone 整链已删(judgeBatchRemote/供应商收集/
 *   endpointCandidates/buildBody/enabled 总闸)——判定**恒走本地**(judgeLocal):modelIn=ollama 打
 *   Ollama models.decision(tev1:0.8b,/v1/systemone),modelIn=local 打常驻进程 models.localDecision
 *   (Strands-Decider-2B ONNX q8 指针头)。零远程调用、零 key 依赖;config 的 decisionModel.{model,
 *   providers,chunkSize,rRef} 旧键不再被读取(rRef 参数与代签门槛改走模型判定档案)。
 * **2026-11-03 用户定档:三投票+一加权;2026-11-09 v3 口径正式化为四票合议**——L1(词法)/L2(向量)/
 *   决策(本模型,常驻合议方:本机实测 49% 成票依赖其凑 quorum)/行为形态;起投与 2 票权重门槛按模型判定
 *   档案(resolveDecisionProfile().signing)标定,反压制与"单票永不独签"纪律不变;另有独立复核 CLI
 *   `--review-golden`(对黄金集已签条目只出报告,不改量尺)。
 * **断路器**:本地判定失败即跳闸(data/routing/decision-model-breaker.json),决策票整体弃权
 *   (定档退词法、代签退三票,fail-open);恢复=人工 `--probe` 探活成功,或下次会话启动自动探活成功。
 * **模型判定档案(v3 方案 §2)**:resolveDecisionProfile——门槛跟随被选模型(tev1 0.4 / strands 0.8),
 *   未建档模型回退 FALLBACK(旧硬编码默认,行为零漂移)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, decisionActive, loadConfig } from './config.mjs';
import { vectorsLayerPaths } from './vectorLayers.mjs'; // base 包内嵌档案的定位(轻量模块,无环)
import { promptKey } from './buildExemplars.mjs'; // 决策台账的 pkey 与黄金集/影子账同键口径
import { judgeLocal, extractJson, shapeAnswers } from './localDecision.mjs';
import { atomicWriteFileSync } from './proc.mjs';

/** 单请求最多 16 道题(实测:questions 超过 16 直接 ValidationError)。超过就分片。 */
export const MAX_QUESTIONS = 16;
/** 三个任务类型的判据(2026-11-06 三档定稿,与 classify.mjs 语义三类同口径,措辞面向判定模型)。 */
export const TYPE_CRITERIA = {
  multi: '多点改组:重构/迁移/批量改造、方案与规划/设计选型、跨模块或全项目范围的改动',
  routine: '例行工作:缺陷诊断(报错/异常/失效)、局部实现(单点/少量文件改动)、代码审查、写测试',
  light: '询问杂务:纯提问/解释/咨询不改任何文件,文档与杂务(提交/写文档/升级依赖/格式化)',
};

/**
 * 四档需求判据(2026-11-08 v2.1 R-ref 预兜底票):与 ticketClassify 四档语义同口径。
 * 决策模型只投"这条任务**需要**哪一档能力",不猜结果、不猜价格——R4 仍只认用户显式点名。
 */
export const TIER_CRITERIA = {
  R1: '日常主力:纯提问/解释/咨询、文档与杂务(提交/写文档/格式化)、单点例行小改',
  R2: '增强:慎重修改——关键性/疑难信号(重构/迁移/线上/资金/并发…)、多处独立改动、全局范围改动',
  R3: '最强(慎投):高危顶格任务(生产事故/线上故障/资损/数据丢失/深层疑难内核级调试),或有确凿迹象表明增强档修不动',
  R4: '奢侈:用户显式点名要最强/最好的模型',
};

// ---------- 模型判定档案(2026-11-09 v3 方案 §2):门槛跟随被选模型,不跟全局数字 ----------
// 键=判定后端名(与 decision-ledger 的 backend 前缀同源):'ollama:<models.decision>' / 'local:<models.localDecision>'。
// '*' 结尾=品牌前缀匹配;未命中(未建档模型)回退 FALLBACK(=2026-11-08 硬编码默认,行为零漂移)。
// 客户端 config 覆盖通道已移除(2026-11-14 用户裁定):data JSON 的 decisionModel.profiles 不再被读取——
// arm1/arm2/signing 最终参数权威=代码档案表 → 服务器档案层(base 包下发);客户端不得以 config 打乱最终参数。
// window:'ambiguous'=仅词法置信≤0.5 的 R1 轮咨询(旧窄缝);'all-r1'=全部 R1 轮咨询(本地零成本下的标定窗)。
// 默认表按 2026-11-09 标定回放(240 条黄金集评测行,code-index/profileCalibrate.mjs --backend tev1|strands 可复跑,
// 报告 data/routing/profile-calibration-<后端>.md)取值:
//   tev1(GPU ollama,~150ms/题):arm1.minConf=0.6——实测 0.4 精准率仅 0.625(3 条误救=白付 R2 溢价),
//     0.6 处精准 1.0 零误救(较 0.4 仅损失 1 条真 R2 召回);window=all-r1(GPU 延迟预算内,0.6 闸下救 4 条 vs 窄缝 1 条);
//     signing.min=0.4(可签 63→100 条、真 R2 召回 0.265→0.306,质量下限由 quorum 保证);
//   strands(CPU 常驻,**~1.1s/题 q4f16**(2026-11-09 用户切换:q4f16 全面胜出 q8——73.3% vs 70.0%、1.77s vs 3.76s、1.04GB vs 1.72GB 同批 60 条)):
//     arm1.minConf=**0.5**/ambiguous 窗——q4f16 置信口径相对 q8 有偏移,ambiguous 窗内操作点从 0.6(1/0)移到 0.5(命中 3/误救 1,精准 0.75);
//     全窗曲线 0.7+ 无票;延迟 1.1s 仍不容 all-r1(≈60% 轮挂 1.1s,维持 ambiguous,未来若提速可复评);
//     signing.min=0.4(可签 115 条、multiRecall 0.462,与 q8 同构)。
//   两后端 maxChars=2000(本地零成本;评测语料 >1200 字 0 条);arm2.r3MinConf=0.85 保持——
//     2026-11-10 全量基准用**真实四档判定**复验:strands 判出 106 张 R3 票但最高置信 <0.85(零触发),
//     门槛降至 0.5 时 3 条候选精准 0 ⇒ **0.85 是有效安全阀,不可下调**(旧"三档投不出 R3,不可标定"作废)。
//   2026-11-10 全量夜间基准复验(test/dm-nightly-bench.mjs,240 条真题+49 场景×双后端,
//     报告 data/nightly/dm-bench/20261110-manual-1347/):arm1/signing 网格结论均为"维持现值"
//     (ollama arm1 0.6→0.4 覆盖 +0.02 但 95% CI 0~0.063 跨 0;ollama signing 候选召回 +0.002 CI -0.112~0.137),
//     数值零改动。⚠ strands 四档判定严重倾高(真值 R1 判 R2×90/R3×93/R1×5;tier 准确率 0.167 vs tev1 0.729):
//     local 模式 tier 票不可单独采信;type 准确率 0.625 vs 0.713,但 signing 侧 strands 更优
//     (可签 172 vs 160、行为一致率 0.738 vs 0.677、真 R2 召回 0.462 vs 0.288)。
//   **q8 备档(不删)**:strands 切 q4f16 前的 q8 标定=arm1 0.6/ambiguous、signing 0.4/0.85(240 条:65.4%,
//     ambiguous 窗 0.6→1/0 精准 1.0;全窗 0.7→0.818、0.85→1.0)——切回 q8(`:q8` 后缀)按此取值并复跑标定;
//     存档 data/routing/profile-calibration-strands-q8.md(两档置信口径有偏移,不可混用门槛)。
export const DECISION_PROFILES_DEFAULT = {
  'ollama:tev1:*': { signing: { min: 0.4, twoVote: 0.85 }, arm1: { live: true, minConf: 0.6, window: 'all-r1', maxChars: 2000 }, arm2: { rescue: true, r3MinConf: 0.85 } },
  'local:strands:*': { signing: { min: 0.4, twoVote: 0.85 }, arm1: { live: true, minConf: 0.5, window: 'ambiguous', maxChars: 2000, maxLatencyMs: 3000 }, arm2: { rescue: true, r3MinConf: 0.85 } }, // maxLatencyMs: 判定延迟预算(S9 实测 p95=1232,4.1× 余量;2026-11-10 落地)
};
export const DECISION_PROFILE_FALLBACK = { signing: { min: 0.6, twoVote: 0.9 }, arm1: { live: false, minConf: 0.75, window: 'ambiguous', maxChars: 1200 }, arm2: { rescue: true, r3MinConf: 0.85 } }; // S2-F4(2026-11-10 夜审):未建档模型恒影子(live:false),不实弹救回

/** 服务器下发档案层(2026-11-10 "一起发包"):档案可内嵌在 base 向量包(profiles 字段),
 *  也可放独立 decision-profiles.base.json(兼容旧部署);base 内嵌优先。
 *  解析顺序:代码默认表 → 服务器档案层(base 包)。客户端 config profiles 通道已移除(2026-11-14 用户裁定)。
 *  安全校验:只接受已知键;置信/门槛必须在 [0,1](越界拒绝,不钳成边界值);window 白名单;
 *  非法条目整体忽略(fail-open 到默认),服务器参数不能把判定链改到无法工作。 */
export const SERVER_PROFILES_FILE = 'decision-profiles.base.json';

function sanitizeProfileValue(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  const num01 = (x) => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null; };
  const posInt = (x) => { const n = Math.floor(Number(x)); return Number.isFinite(n) && n > 0 ? n : null; };
  if (v.signing && typeof v.signing === 'object') {
    const s = {};
    const m = num01(v.signing.min); if (m != null) s.min = m;
    const t = num01(v.signing.twoVote); if (t != null) s.twoVote = t;
    if (Object.keys(s).length) out.signing = s;
  }
  if (v.arm1 && typeof v.arm1 === 'object') {
    const a = {};
    if (typeof v.arm1.live === 'boolean') a.live = v.arm1.live;
    const mc = num01(v.arm1.minConf); if (mc != null) a.minConf = mc;
    if (v.arm1.window === 'all-r1' || v.arm1.window === 'ambiguous') a.window = v.arm1.window;
    const mx = posInt(v.arm1.maxChars); if (mx != null) a.maxChars = mx;
    const ml = posInt(v.arm1.maxLatencyMs); if (ml != null) a.maxLatencyMs = ml;
    if (Object.keys(a).length) out.arm1 = a;
  }
  if (v.arm2 && typeof v.arm2 === 'object') {
    const a = {};
    if (typeof v.arm2.rescue === 'boolean') a.rescue = v.arm2.rescue;
    const rc = num01(v.arm2.r3MinConf); if (rc != null) a.r3MinConf = rc;
    if (Object.keys(a).length) out.arm2 = a;
  }
  return Object.keys(out).length ? out : null;
}

/** 跨来源同键深合并(2026-11-10):独立文件与 base 内嵌可能各带一部分键,按 signing/arm1/arm2 深合并,
 *  后读来源覆盖同名键但不丢前一个来源的独有键。 */
function mergeProfileSections(dst, src) {
  return {
    signing: { ...(dst.signing || {}), ...(src.signing || {}) },
    arm1: { ...(dst.arm1 || {}), ...(src.arm1 || {}) },
    arm2: { ...(dst.arm2 || {}), ...(src.arm2 || {}) },
  };
}

/** 服务器档案层来源(2026-11-10 "一起发包"):
 *   ① 独立 decision-profiles.base.json(兼容早期部署,优先级低);
 *   ② base 向量包内嵌 `profiles` / `decisionProfiles` 字段(推荐:一个包同时带向量与档案,下载即生效)。
 *  同一键以 base 内嵌为准(后读覆盖);按文件 mtime 缓存,服务器换包后自动失效重读。 */
let _serverProfilesCache = { key: '', data: {} };
export function readServerProfiles(dataDir = DATA_DIR) {
  try {
    const paths = vectorsLayerPaths(dataDir);
    const files = [
      path.join(dataDir, 'routing', SERVER_PROFILES_FILE), // ① 独立文件(旧)
      paths.base.fixedFile,                                // ② base 旧固定名(迁移期)
      paths.base.slugFile,                                 // ② base 包内嵌(当前模型,权威)——S14-F1:slug 后读,旧固定名不得覆盖
    ];
    const mt = files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } });
    const key = `${dataDir}|${paths.slug}|${mt.join(',')}`;
    if (_serverProfilesCache.key === key) return _serverProfilesCache.data;
    const out = {};
    for (const f of files) {
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      const src = raw && (raw.profiles || raw.decisionProfiles);
      if (!src || typeof src !== 'object') continue;
      for (const [k, v] of Object.entries(src)) {
        if (!k || typeof v !== 'object') continue;
        const clean = sanitizeProfileValue(v);
        if (clean) out[String(k)] = mergeProfileSections(out[String(k)] || {}, clean); // 后读覆盖同名键,保留独有键
      }
    }
    _serverProfilesCache = { key, data: out };
    return out;
  } catch { return _serverProfilesCache.data || {}; }
}

/** 当前判定后端 → 生效档案(默认表 → 服务器层;客户端 config profiles 通道已移除,参数权威在档案)。 */
export function resolveDecisionProfile(config = null, { dataDir = DATA_DIR } = {}) {
  const cfg = { ...loadConfig(), ...(config || {}) };
  const isOllama = String(cfg.modelIn) === 'ollama';
  const name = String((isOllama ? (cfg.models && cfg.models.decision) : (cfg.models && cfg.models.localDecision)) || '').trim();
  const backend = name ? `${isOllama ? 'ollama' : 'local'}:${name}` : null;
  let prof = DECISION_PROFILE_FALLBACK;
  let matched = null;
  if (backend) {
    const serverProfiles = readServerProfiles(dataDir);
    // 两段匹配(2026-11-14 用户裁定:arm1/arm2 参数权威=模型档案,base 包同步到客户端;
    // **客户端 config 的 decisionModel.profiles 通道已移除**——不允许通过 data JSON 打乱最终参数,
    // 档案修正只能走服务器档案层随包下发)。默认表给标定基线,服务器层随包更新。
    for (const table of [DECISION_PROFILES_DEFAULT, serverProfiles]) {
      for (const [k, v] of Object.entries(table)) {
        if (!v || typeof v !== 'object') continue;
        const pat = String(k).replace(/\*$/, '');
        const hit = String(k).endsWith('*') ? backend.startsWith(pat) : backend === String(k);
        if (hit) {
          prof = {
            signing: { ...prof.signing, ...(v.signing || {}) },
            arm1: { ...prof.arm1, ...(v.arm1 || {}) },
            arm2: { ...prof.arm2, ...(v.arm2 || {}) },
          };
          matched = String(k);
          break;
        }
      }
    }
  }
  return { backend, matched, signing: { ...prof.signing }, arm1: { ...prof.arm1 }, arm2: { ...prof.arm2 } };
}

/**
 * 判定批大小(2026-11-08 v2.7 定档):恒 1,一题一判(2026-11-03 实测定档的置信最佳口径)。
 * chunkSize 不再支持配置;仅调用方显式传来的参数可覆盖(测试/高级用法),上限 MAX_QUESTIONS。
 */
export function decisionChunkSize(cfg = null) {
  return 1;
}

/** 解析 answers → [{id, type, confidence, probabilities}]。
 *  校验(2026-11-06 决策票四防线):①标签值域——choice 不在三类/旧八类白名单的按弃权(null),
 *  防未知值原样写进黄金集;②键位——answer 键解析出的序号超出本片 items 范围的整条丢弃,
 *  防"判定安到别的候选行头上";③重复 id 先到先得,后写不覆盖(网关同题多答不再随机盖);
 *  ④置信钳制——答案带 probabilities 时,所选标签的概率是网关独立给出的交叉校验,自报
 *  confidence 取 min(自报, 概率),防 LLM 自报虚高白拿 2 票权重。 */
export function parseAnswers(json, items = [], { valid = null } = {}) {
  const answers = (json && json.answers) || {};
  const valueRe = valid instanceof RegExp ? valid : /^(?:multi|routine|light|T[1-8])$/i;
  const out = [];
  const seenIds = new Set();
  for (const [k, a] of Object.entries(answers)) {
    if (!a || typeof a !== 'object') continue;
    const idx = Number(String(k).replace(/^\D+/, '')) - 1;
    if (!(idx >= 0 && idx < items.length)) continue; // 键位越界:不猜归属,整条丢弃
    const it = items[idx] || {};
    const id = it.id ?? idx + 1;
    if (seenIds.has(id)) continue; // 重复 id:先到先得
    seenIds.add(id);
    const choice = String(a.choice || '').trim();
    // 统一大小写口径:R# 恒大写(下游档位比较用),T# 恒大写,三档 T 型恒小写——与 valueRe 白名单对应
    const type = valueRe.test(choice)
      ? (/^R\d$/i.test(choice) || /^T/i.test(choice) ? choice.toUpperCase() : choice.toLowerCase())
      : null;
    let confidence = Number(a.confidence ?? 0);
    if (type && a.probabilities && typeof a.probabilities === 'object') {
      const prob = Number(a.probabilities[choice] ?? a.probabilities[type]);
      if (Number.isFinite(prob) && prob > 0) confidence = Math.min(confidence, prob);
    }
    out.push({ id, text: it.text ?? '', type, confidence: Number.isFinite(confidence) ? confidence : 0, probabilities: a.probabilities || {}, raw: a });
  }
  return out;
}

/**
 * 批量判定分派(2026-11-08 本地化定档):
 *   - local:'always' → 恒本地(localDecision.mjs),绝不碰网关;
 *   - local:'never'  → 恒远程(systemone 端点,旧行为);
 *   - local:'auto'(默认)→ 调用方显式注入 providers/provider/fetchFn(密闭测试/人工远程)时远程,
 *     否则本地——生产默认路径零远程调用。
 * 远程路径的行为不变:分片并发(默认 2),每请求一个 AbortController 超时;单分片失败只跳过该片,
 * **全部**分片失败才算 error;429/503/网络抖动指数退避(最多 2 次、最长 400ms)。
 * 本地路径:ollama/常驻都串行。两端判定批大小恒 1 题一判(v2.7:chunkSize 不支持配置)。
 * 返回 {answers, usage, latencyMs, endpoint, chunks, failedChunks, retriedChunks, backend, error?}。
 */
export async function judgeBatch(args = {}) {
  const { items, criteria = TYPE_CRITERIA, valueRe = null, fetchFn = null, config = null } = args;
  if (!items || !items.length) return { answers: [], usage: null };
  // v4(2026-11-09 用户裁定):远程 systemone 整链已删——判定恒走本地(judgeLocal:ollama systemone /
  // 常驻 strands)。providers/provider 参数已废(传入即忽略);local 参数失效化;fetchFn 仅供测试密闭
  // 注入(mock ollama 端点)。台账照记,backend=本地后端名。
  const useLocal = true;
  if (useLocal) {
    const valid = valueRe instanceof RegExp ? valueRe : (valueRe ? new RegExp(valueRe, 'i') : null);
    // 判定批大小恒 1(v2.7 2026-11-08:chunkSize 不支持配置,一题一判置信最佳);
    // 仅显式调用参数可覆盖(测试用)
    const effChunk = Number(args.chunkSize) > 0 ? Math.min(Math.floor(Number(args.chunkSize)), MAX_QUESTIONS) : 1;
    const chunks = [];
    for (let off = 0; off < items.length; off += effChunk) chunks.push(items.slice(off, off + effChunk));
    const started = Date.now();
    let endpoint = null;
    let backend = null;
    let failedChunks = 0;
    let lastErr = '';
    let skipped = false; // 批量嵌入让行:忙跳过不算故障(调用方不得据此跳闸)
    let usage = null;
    const parsedAll = [];
    for (const chunk of chunks) {
      const lr = await judgeLocal({ items: [chunk], criteria, valid, config, fetchFn: fetchFn || fetch, timeoutMs: args.timeoutMs || 30000, retries: args.retries ?? 1 });
      endpoint = endpoint || lr.endpoint;
      backend = backend || lr.backend;
      if (lr.skipped) skipped = true;
      if (lr.error) { lastErr = lr.error; }
      if (lr.usage) {
        usage = {
          input_tokens: (usage?.input_tokens || 0) + (lr.usage.input_tokens || 0),
          output_tokens: (usage?.output_tokens || 0) + (lr.usage.output_tokens || 0),
        };
      }
      const raw = (lr.rawChunks || [])[0];
      if (!raw) { failedChunks += 1; continue; }
      // ONNX 打分路径直接给归一答案图(shaped);ollama systemone 路径直接给归一答案图;文本路径走 extractJson+shapeAnswers
      const shaped = raw.shaped || shapeAnswers(extractJson(raw.text || ''), valid);
      const parsed = parseAnswers(shaped || {}, chunk, { valid: valid || undefined });
      if (!shaped) { failedChunks += 1; continue; }
      for (const a of parsed) a.id = chunk[a.id - 1] ? chunk[a.id - 1].id : a.id;
      parsedAll.push(...parsed);
    }
    parsedAll.sort((a, b) => a.id - b.id);
    const base = { answers: parsedAll, usage, latencyMs: Date.now() - started, endpoint, chunks: chunks.length, failedChunks, retriedChunks: 0, backend, skipped };
    // 与远程口径一致:只有**全部分片**失败才是 error(触发跳闸/弃权);部分失败只记 failedChunks,
    // 已判出的答案照常计票——否则一次超时就把整轮判定作废 + 误跳断路器
    if (!parsedAll.length) return { ...base, error: `本地决策模型判定失败:${lastErr || '无可解析答案'}` };
    // 决策台账(2026-11-09):判定成功即落盘,分模型识别;fetchFn 注入=密闭测试,不记防污染
    if (fetchFn == null) appendDecisionLedger({ model: backend, criteria, items, answers: parsedAll, latencyMs: base.latencyMs, usage });
    return base;
  }
  // v4:远程分派已删——恒本地,上方块内必 return(此处仅为语法兜底,不可达)
  return { answers: [], usage: null };
}

// ---------- 决策台账(2026-11-09 用户需求):决策模型核心数据集中单文件、分模型识别 ----------
//
// 每次成功判定一行 JSONL,追加写 data/routing/decision-ledger.jsonl(所有后端共用一个文件,model 字段区分):
//   {ts, model, kind:'type'|'tier', promptHead(≤200字), pkey, choice, confidence, probabilities, latencyMs, usage}
// 用途:①按模型统计判定质量与血缘追踪 ②后续上报服务器训练 KNN(promptHead+pkey→嵌入标签对),
// 同 pkey 重复=真实事件流水,训练侧按 pkey 去重取最新即可。失败判定不记(断路器另有审计)。
export function appendDecisionLedger({ model, criteria, items, answers, latencyMs, usage, dataDir = DATA_DIR }) {
  // 测试防污染开关:modelRouteProxy 等测试会起真实代理触发 R-ref 判定(fetchFn 无法注入到代理内部),
  // 测试文件顶部设 CODE_INDEX_NO_LEDGER=1 即全量静默;生产不设该变量,正常落盘。
  if (process.env.CODE_INDEX_NO_LEDGER === '1') return;
  try {
    const kind = criteria === TIER_CRITERIA ? 'tier' : 'type';
    const byId = new Map((items || []).map((it) => [it.id, it]));
    // batchSize/latencyMs 均摊(2026-11-09 修):批量代签时 latencyMs 是整批耗时,直读会误导延迟分析
    // (实测 200 条共享 25627ms);记录单题均值 = 整批 / 答案数,batchSize 保留批量上下文。
    const nAns = (answers || []).length || 1;
    const rows = (answers || []).map((a) => {
      const item = byId.get(a.id) || (items || [])[(a.id || 1) - 1] || {};
      const prompt = String(item.text || '');
      return {
        ts: Date.now(),
        model: String(model || 'unknown'),
        kind,
        promptHead: prompt.slice(0, 200),
        pkey: promptKey(prompt),
        choice: a.type,
        confidence: Number(a.confidence) || 0,
        probabilities: a.probabilities || {},
        batchSize: nAns,
        latencyMs: Math.round((Number(latencyMs) || 0) / nAns),
        usage: usage || null,
      };
    }).filter((r) => r.choice);
    if (!rows.length) return;
    fs.mkdirSync(path.join(dataDir, 'routing'), { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'routing', 'decision-ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch { /* 台账写失败不影响判定(磁盘满/占用) */ }
}

/** 便捷入口:给一批 prompt 直接判类型。 */
export async function classifyBatch(prompts, { criteria = TYPE_CRITERIA, ...opts } = {}) {
  const items = (prompts || []).map((text, i) => ({ id: i + 1, text: String(text) }));
  const r = await judgeBatch({ items, criteria, ...opts });
  return { ...r, byId: new Map(r.answers.map((a) => [a.id, a])) };
}

/**
 * 单条 prompt → 需求档位判定(R-ref 预兜底票,2026-11-08 v2.1)。
 * criteria=TIER_CRITERIA、值域白名单 R1-R4;返回 {answer:{type,confidence}|null, error, endpoint, latencyMs, usage}。
 * 热路径调用方(代理)自管断路器/开关/缓存,本函数只做"一题一判"。
 * fetchFn 缺省不注入 → judgeBatch 走本地判定(2026-11-08 本地化);注入时走显式远程。
 */
export async function judgeTier(prompt, { context = null, config = null, fetchFn = null, timeoutMs = 8000, chunkSize = 1, concurrency = 1, retries = 1, baseDelay = 150 } = {}) {
  // 上下文并入(S3,2026-11-09 v3 方案):调用方传入"前轮人类 prompt 摘要",在拼接层实现——零协议改动,
  // ollama systemone/文本生成/ONNX 打分三条判定路径同效(判的是同一份全文)。指代类("刚才的测试…")不再盲判。
  // S4-F3(2026-11-11 夜审):provider/providers/local 三个死参数清理——v4 判定恒本地,传入即被忽略。
  const text = context ? `【前文摘要】${String(context).slice(0, 400)}\n【本轮任务】${String(prompt || '')}` : String(prompt || '');
  const r = await judgeBatch({
    items: [{ id: 1, text }], criteria: TIER_CRITERIA,
    valueRe: /^R[1-4]$/i, config, fetchFn: fetchFn || undefined, timeoutMs, chunkSize, concurrency, retries, baseDelay,
  });
  return { ...r, answer: r.answers && r.answers.length ? r.answers[0] : null };
}

// ---------- 断路器(2026-11-03 用户定档):模型不可用自动关闭,零网关重试,人工探活恢复 ----------

/** 断路器状态文件:data/routing/decision-model-breaker.json。open=true 期间所有入口跳过网关。 */
export function breakerPath(dataDir = DATA_DIR) { return path.join(dataDir, 'routing', 'decision-model-breaker.json'); }

/** 断路器开着(返回 {open,at,reason})/没开(返回 null)。 */
export function breakerOpen(dataDir = DATA_DIR) {
  try {
    const j = JSON.parse(fs.readFileSync(breakerPath(dataDir), 'utf8'));
    return j && j.open === true ? j : null;
  } catch { return null; }
}

/** 跳闸:复核失败即写,之后零网关尝试;reason 留痕供人判断。
 *  S12-F1(2026-11-14 夜审):dataDir 校验必为字符串(省略=生产 DATA_DIR)——曾有 harness 误传
 *  对象作第二参,静默把断路器写进生产路径;错传就地抛错而非静默写错处。 */
export function tripBreaker(reason, dataDir = DATA_DIR) {
  if (dataDir !== undefined && dataDir !== null && typeof dataDir !== 'string') {
    throw new TypeError(`tripBreaker: dataDir 必须是字符串路径(收到 ${typeof dataDir},疑似参数误传)`);
  }
  try {
    fs.mkdirSync(path.dirname(breakerPath(dataDir)), { recursive: true });
    // 原子写(2026-11-10 夜审 S12-F4c):断路器半写 = 静默解除,崩溃留半截 JSON 会让下次读到"未跳闸"
    atomicWriteFileSync(breakerPath(dataDir), JSON.stringify({ open: true, at: Date.now(), reason: String(reason || '').slice(0, 200) }) + '\n');
    return true;
  } catch { return false; }
}

/** 复位(--probe 探活成功或人工删状态文件);2026-11-03 起会话启动自动探活(auto.mjs)成功同样复位。 */
export function resetBreaker(dataDir = DATA_DIR) {
  try { fs.rmSync(breakerPath(dataDir), { force: true }); return true; } catch { return false; }
}

/** 会话启动自动探活判定(2026-11-03 用户定档;v4 远程链删后恒本地):断路器开着才需要探——健康路径零开销。 */
export function autoProbeDue(dataDir = DATA_DIR) {
  return !!breakerOpen(dataDir);
}

function readCfg(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'code-index.config.json'), 'utf8')); } catch { return {}; }
}

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

/**
 * 黄金集复核(独立工具,2026-11-03 用户定档:不嵌入代签投票,只作复核):
 * 对 golden-set.jsonl 已签条目批量判定,产出 data/routing/decision-review.md——
 *   每条附 agree 与 reviewScore(四票 agreement × (一致?1:0.5) 的复核折减分,纯诊断);
 * **绝不写黄金集**(量尺写入面只有手工 CLI 与四票代签两处,红线不变)。
 * 断路器未开才判定;失败跳闸并退出 1。fetchFn 可注入(测试密闭,mock ollama)。
 */
export async function reviewGolden({ dataDir = DATA_DIR, goldenFile = null, limit = 0, decisionMinConf = 0.6, fetchFn = null } = {}) {
  const breaker = breakerOpen(dataDir);
  if (breaker) {
    return { skipped: true, reason: `断路器开(${breaker.reason || '未知原因'})——不再尝试网关;人工 --probe 探活成功后恢复` };
  }
  const file = goldenFile || path.join(dataDir, 'routing', 'golden-set.jsonl');
  let rows = readJsonl(file).filter((r) => (/^(multi|routine|light|T[1-8])$/.test(String(r.humanLabel || ''))) && r.prompt);
  if (limit > 0) rows = rows.slice(0, limit);
  if (!rows.length) return { skipped: true, reason: `无可复核的已签条目(${file})` };
  const dr = await classifyBatch(rows.map((r) => String(r.prompt)), { fetchFn: fetchFn || undefined, config: readCfg(dataDir) });
  if (dr.skipped) {
    // 批量嵌入让行:忙跳过 ≠ 故障,不断路、保留断路器现状,下次复核再试
    return { skipped: true, reason: dr.error || '批量嵌入进行中' };
  }
  if (dr.error) {
    tripBreaker(`黄金集复核失败:${dr.error}`, dataDir);
    return { error: dr.error, tripped: true };
  }
  const byId = dr.byId;
  let agree = 0;
  const entries = rows.map((r, i) => {
    const a = byId.get(i + 1) || null;
    const ok = !!(a && a.type && a.confidence >= decisionMinConf && a.type === r.humanLabel);
    if (ok) agree += 1;
    const baseAgreement = Number.isFinite(Number(r.agreement)) ? Number(r.agreement) : 1;
    return {
      id: r.id, prompt: String(r.prompt).replace(/\s+/g, ' ').slice(0, 90),
      humanLabel: r.humanLabel, dmType: a?.type || null, dmConfidence: a ? Number(a.confidence.toFixed(2)) : null,
      agree: ok, abstain: !a || !a.type || a.confidence < decisionMinConf,
      reviewScore: Math.round(baseAgreement * (ok ? 1 : 0.5) * 100) / 100,
    };
  });
  const report = [
    '# 决策模型黄金集复核(独立工具;只读报告,不改量尺)',
    '',
    `> 复核时间:${new Date().toISOString()}　已签条目:${rows.length}　判定一致:${agree}　复核折减(×0.5):${rows.length - agree}`,
    '> reviewScore = 四票 agreement × (一致 ? 1 : 0.5)——纯诊断分,不影响 humanLabel;分歧条目仅供人工判断词表/代签质量。',
    '> 判定恒本地(v4:ollama tev1 / 常驻 Strands,门槛走模型判定档案);失败自动跳闸,--probe 探活恢复。',
    '',
    '| id | prompt(截断) | 量尺 | 决策模型 | conf | 一致 | reviewScore |',
    '|---|---|---|---|---|---|---|',
    ...entries.map((e) => `| ${e.id} | ${e.prompt.replace(/\|/g, '/')} | ${e.humanLabel} | ${e.dmType ?? '(弃权)'} | ${e.dmConfidence ?? '-'} | ${e.abstain ? '-' : (e.agree ? '✓' : '✗')} | ${e.reviewScore} |`),
    '',
  ].join('\n');
  const out = path.join(dataDir, 'routing', 'decision-review.md');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    atomicWriteFileSync(out, report);
  } catch { /* 报告写不上不影响结论 */ }
  return { reviewed: rows.length, agree, disagree: rows.length - agree - entries.filter((e) => e.abstain).length, abstain: entries.filter((e) => e.abstain).length, agreementRate: Number((agree / rows.length).toFixed(3)), report: out, entries };
}

/** CLI:node decisionModel.mjs --classify "prompt1" "prompt2" ...
 *      node decisionModel.mjs --review-golden [--golden 文件] [--limit N](黄金集复核,报告制不改量尺)
 *      node decisionModel.mjs --probe(人工探活:成功清断路器,失败跳闸)
 *      node decisionModel.mjs --probe-if-tripped(会话启动自动探活:auto.mjs 后台拉起;开关关/断路器未开=静默跳过)
 */
const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); // fileURLToPath 自带解码,路径含空格/非 ASCII 也相等(2026-11-10 审计修复)
if (directRun) {
  const argv = process.argv.slice(2);
  const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
  if (argv.includes('--review-golden')) {
    reviewGolden({ dataDir: DATA_DIR, goldenFile: opt('--golden', null) || null, limit: Number(opt('--limit', 0)) || 0 })
      .then((r) => {
        console.log(JSON.stringify(r, null, 1));
        process.exit(r.error ? 1 : 0);
      });
  } else if (argv.includes('--probe')) {
    // 人工探活(v4 恒本地):一题判定。成功=复位断路器;失败=跳闸(理由留痕)。
    classifyBatch(['健康探活:这是一条用于探活的指令。'], { config: readCfg(DATA_DIR) }).then((r) => {
      if (r.skipped) { console.log(JSON.stringify({ skipped: true, reason: r.error })); process.exit(0); } // 批量嵌入让行:不算失败
      if (r.error) { tripBreaker(`探活失败:${r.error}`); console.error('[err]', r.error); process.exit(1); }
      resetBreaker();
      console.log(JSON.stringify({ ok: true, endpoint: r.endpoint, latencyMs: r.latencyMs, breaker: 'reset' }));
    });
  } else if (argv.includes('--probe-if-tripped')) {
    // 会话启动自动探活(auto.mjs SessionStart detached 拉起):仅"开关开 ∧ 断路器开着"才真实打网关。
    // 成功=复位;失败=续跳(更新留痕)。判定与 --probe 同源,只是多了跳过条件。
    // S2-F3(2026-11-11 夜审):常驻决策缺失(decisionOk=false)时探活必失败并续跳 → 决策票无限期弃权
    // (ensureLocalResident 不带 retryDecision 不重启决策缺失的常驻,而该参数此前只有手动 warm 调)。
    // 修复:失败且后端为 local 时,先 ensureLocalResident({retryDecision:true}) 重启常驻重拉,再复探一次。
    if (!autoProbeDue()) { console.log(JSON.stringify({ skipped: true })); process.exit(0); }
    const probeOnce = () => classifyBatch(['健康探活:这是一条用于探活的指令。'], { config: readCfg(DATA_DIR) });
    probeOnce().then(async (r) => {
      if (r.skipped) { console.log(JSON.stringify({ skipped: true, reason: r.error })); process.exit(0); } // 批量嵌入让行:保留断路器状态,下次再探
      if (r.error) {
        const cfg = readCfg(DATA_DIR);
        if (cfg.modelIn !== 'ollama') {
          try {
            const { ensureLocalResident } = await import('./localResident.mjs');
            await ensureLocalResident(() => {}, { retryDecision: true }); // 决策缺失 → 重启常驻重拉(等待就绪,上限 180s)
          } catch { /* 重拉失败,保持跳闸 */ }
          const r2 = await probeOnce();
          if (r2.skipped) { console.log(JSON.stringify({ skipped: true, reason: r2.error })); process.exit(0); }
          if (!r2.error) { resetBreaker(); console.log(JSON.stringify({ ok: true, endpoint: r2.endpoint, latencyMs: r2.latencyMs, breaker: 'reset', healed: true })); process.exit(0); }
          tripBreaker(`探活失败:${r2.error}`);
          console.log(JSON.stringify({ ok: false, error: r2.error, healed: false }));
          process.exit(1);
        }
        tripBreaker(`探活失败:${r.error}`);
        console.log(JSON.stringify({ ok: false, error: r.error }));
        process.exit(1);
      }
      resetBreaker();
      console.log(JSON.stringify({ ok: true, endpoint: r.endpoint, latencyMs: r.latencyMs, breaker: 'reset' }));
    });
  } else {
    const prompts = argv.filter((a) => !a.startsWith('--'));
    classifyBatch(prompts).then((r) => {
      if (r.error) { console.error('[err]', r.error); process.exit(1); }
      console.log(JSON.stringify({ endpoint: r.endpoint, latencyMs: r.latencyMs, usage: r.usage, answers: r.answers }, null, 1));
    });
  }
}
