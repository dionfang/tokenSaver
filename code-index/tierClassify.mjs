/**
 * 难度定档分类器(2026-11-04 用户定档 v2:按真实资费语义重排四档门槛)。
 * 资费梯度:R1=1x(日常主力)/ R2=8x(增强)/ R3=15x(最强)/ R4=100x(奢侈)⇒ 成本悬崖在 R1→R2(8 倍),
 * R2→R3 仅 ~2 倍,词法门槛据此设计:
 *   - R1:问答/杂务/单点例行编辑——单个编辑动词不构成升档理由(例行小改不值 8 倍);
 *   - R2:**慎重修改**才升——关键性/疑难信号命中,或编辑动词多重印证(≥2 处独立改动),或全局范围改动;
 *   - R3:2026-11-08 重建裁定改为**词法可达·顶格词+独立印证同击制**(推翻 2026-11-04"词法永不可达"):
 *     R3_SIGNS(事故/资损/底层疑难顶格词)命中且另有一池(CRITICAL/EDIT/SCOPE)在**非重叠跨度**上印证才判 R3;
 *     单顶格词命中维持 R2。实测依据:全期 R3 仅 16/2149 轮(0.7%),关键时刻强模型未被启用;
 *     成本口径已换挡(R3 倍率 1 vs R2 0.5,误升一轮仅 2 倍 R2 价),严格同击下试错成本可控。
 *     该池**不进优化器网格、不学权重**(黄金集 R3 正样本近乎为 0,优化器量尺看不见 R3 收益会压平通道;
 *     自进化 v2 重建(区间真值)落地后由有下界行赋予收益)。kill-switch:代理侧 modelRouting.r3Lexical.enabled。
 *   - R4:仅显式点名旗舰(FLAGSHIP_DEMAND,高置信,不受疑问/低置信影响)。
 * 旧 R3/R4 词表(重构/死锁/从零设计…)整体降为 R2 的**关键性证据池**:这类任务从 R2 起步,解决不了由 P2 上梯。
 * 裸"优化/算法/排查/规划"等泛词不入池(常规小优化与排期问答不值 8 倍档;强形态"性能优化/动态规划"保留)。
 * 词表人工扩充(2026-11-04 用户授权,优化器永不自动改):入池判据是"黄金集支持数 + 正例纯度 + 净代价"三件,
 * 不是"跟编程有关系"——本项目几乎所有 prompt 都是编程,按主题加词等于把全部轮次推到 8 倍档。本轮按实测入池
 * 4 个:`测试`(EDIT,8 命中/7 非R1)、`兜底`(CRITICAL,3/3)、`全量`(SCOPE,只在已有编辑动词上放大)、
 * `是不是`(VERIFY,8 命中里 7 条真值 R1);拒入 `zcode`/`qoder`/`data`/`进行`(语料来源代理,非难度形态)、
 * `部署`/`文案`(纯度 0.5 = 拿 8 倍掷硬币)。量尺 111 条:总代价 410.29→401.90M、准确率 68.5→69.4%、
 * R2 召回 20.5→23.1%、R1 召回 94.4% 不动、误升 4 条不变。
 * 否定感知(NEG_ZH_RE via hitsOf)与引用剥离(stripCitations)沿用 classify.mjs 同口径;纯 ASCII 词按整词
 * 边界匹配(add 不再误中 additional/fix 不再误中 prefix),重叠命中(如"修改成"同时含 修改/改成)按跨度合并计一次。
 * 纯函数,text 可注入;调用方 try/catch 兜底,分类失败回落 R1(最省)。
 *
 * **可学习面(2026-11-04 迭代优化器接入)**:词表本身永不自动改(#14 红线),自动的只有"每个信号的权重倍数 +
 * 三个门槛"。第二参数 `{calibration}` 传入 data/routing/tier-calibration.json 的内容即可生效:
 *   - signals[池][词].multiplier ∈ [0.4,2.0] 缩放该次命中贡献(默认 1);
 *   - thresholds.critMin(默认 1)/ editMin(默认 2)/ verifyOverride(默认 0=疑问拦截恒生效);
 *   - 全部取默认时,加权分与旧"命中数"逐位相等(collect 按跨度合并后每段取最大权重)⇒ 不带档案 = 现网行为。
 * 档案缺 enabled:true 一律不消费(与 calibrateSignals 同两道门,启用是人的决定)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { stripCitations, hitsOf } from './classify.mjs';

// 疑问/征询结构:出现即视为"在问不是在做"(同 classify.mjs 元提问防线思路)
const VERIFY_WORDS = ['吗', '呢', '是否', '是不是', '能不能', '会不会', '怎么样', '怎么', '怎样', '如何', '为什么', '什么', '多少', 'what is', 'how to', 'difference'];
// 强祈使前缀:有它才是确凿的"下命令";单独的动作词(做/写/改/重构)在疑问句里也出现,不足以推翻提问判定
const IMPERATIVE_PREFIX = ['帮我', '帮忙', '请', '麻烦', '给我', '替我', '你帮我', '为我', 'please'];
// 范围词:改动波及面大=慎重工作,编辑动词 + 范围词构成 R2 印证("全站统一改"不是单点例行编辑)
const SCOPE_WORDS = ['所有', '全部', '每个', '统一', '整体', '批量', '全站', '全项目', '整个', '全局', '全量', '跨模块', '多个文件', 'all ', 'every '];

// 显式点名旗舰模型 → R4(高置信,用户明确要求最好的;这是 R4 的唯一词法入口)
const FLAGSHIP_DEMAND = ['用最强', '最强的模型', '最好的模型', '用最好', '旗舰模型', '顶配', '最强模型', '用最贵', '上最好的', '用教授', '教授档', 'best model', 'strongest model'];
// R3 顶格词池(2026-11-08 重建裁定):事故/资损/底层疑难——词法可达 R3 的**必要不充分**条件。
// 判定口径(见 classifyDifficulty):单池命中只算证据,须另有一池(CRITICAL/EDIT/SCOPE)在**非重叠跨度**
// 上印证才判 R3;单顶格词命中维持 R2。与 CRITICAL 的重复词(死锁/内存泄漏/deadlock/memory leak)是有意的:
// 同词命中只算一次,印证必须来自别的词。本池不进 TIER_LEXICON(不学权重、不进优化器网格,#14 红线)。
const R3_SIGNS = ['生产事故', '线上事故', '线上故障', '服务不可用', '宕机', '资损', '资金损失', '数据丢失', '数据损坏', '误删',
  '死锁', '内存泄漏', '内核', '编译器', 'kernel panic', 'core dump', '竞态', 'race condition', 'heisenbug', '无法复现', 'paxos', 'raft'];
// R2 关键性证据池:命中即"慎重工作"(原 R3/R4 词表整体降档并入)——疑难调试/架构重构/全局影响/深权衡
const CRITICAL_SIGNS = ['慎重', '谨慎', '关键', '核心', '主流程', '线上', '生产', '高危', '不能出错', '资金', '支付', '安全', '敏感',
  '重构', '迁移', '改造', '抽离', '拆分', '架构', '系统设计', '技术方案', '方案', '选型', '性能优化', '优化性能',
  '疑难', '偶发', '诡异', '定位不了', '查不出', '并发', '线程安全', '死锁', '内存泄漏', '动态规划', '兜底',
  '从零设计', '从头设计', '从零搭', '大规模', '分布式', '跨领域', '深度分析', '梳理', '治理',
  'refactor', 'migrate', 'architecture', 'concurrency', 'deadlock', 'memory leak', 'architect from scratch', 'careful', 'carefully', 'critical', 'production', 'design'];
// R2 编辑印证池:单命中只是例行编辑(维持 R1),≥2 处独立改动或叠加范围词才升 R2
const EDIT_SIGNS = ['添加', '新增', '增加', '修改', '改成', '改为', '替换', '删除', '去掉', '去除', '换成', '调整', '接入', '联调', '补上', '加个', '加上', '实现', '修复', '改bug', '修 bug', '测试', '写测试', '单测', '单元测试', '测试用例', '覆盖率',
  '评审', '审查', '找问题', '隐患', '缺陷', '风险评估',
  'implement', 'add', 'modify', 'fix', 'bug', 'unit test', 'review', 'code review'];
// R1 杂务/文档/纯问答信号(最便宜档)
const R1_SIGNS = ['格式化', '翻译', '国际化', 'i18n', 'readme', 'changelog', '更新文档', '写文档', 'commit', '提交代码', '是什么', '什么意思', '怎么用', '有什么区别', '区别是什么', '在哪', '在哪里', '介绍一下', '讲解', '说明一下', 'format', 'translate'];

/** 可学习信号的池名 → 词表(迭代优化器按这些池逐词统计;R1 侧只学权重、不改判定顺序)。 */
export const TIER_LEXICON = { CRITICAL_SIGNS, EDIT_SIGNS, SCOPE_WORDS, R1_SIGNS, VERIFY_WORDS, FLAGSHIP_DEMAND };

const ASCII_RE = /^[\x21-\x7e]+$/;
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 词是否命中(否定感知 + 纯 ASCII 整词边界)——与 collect 同一条判定,供优化器复用避免口径漂移。 */
export function termPresent(low, word) {
  const w = String(word).toLowerCase();
  if (!hitsOf(low, [w]).length) return false;
  if (ASCII_RE.test(w) && !new RegExp(`\\b${escRe(w)}\\b`).test(low)) return false;
  return true;
}

/**
 * 否定感知 + 整词边界 + 跨度合并的命中统计。
 * 返回 { words, count, score, spans }:count 是合并重叠命中后的独立命中数("修改成"只算 1 次编辑动词);
 * score 是同跨度按权重(默认 1)取最大后的加权和 ⇒ 权重全为 1 时 score === count(旧行为逐位复现);
 * spans 是 [start,end,word] 排序跨度表(2026-11-08 R3 同击:独立印证要用它判"非重叠跨度")。
 */
function collect(low, words, weightOf = () => 1) {
  const accepted = [];
  for (const w of hitsOf(low, words)) {
    const word = String(w).toLowerCase();
    // 纯 ASCII 词要求整词边界:add 不吃 additional、fix 不吃 prefix、design 不吃 designer
    if (ASCII_RE.test(word) && !new RegExp(`\\b${escRe(word)}\\b`).test(low)) continue;
    if (!accepted.includes(w)) accepted.push(w);
  }
  const spans = accepted
    .map((w) => { const i = low.indexOf(String(w).toLowerCase()); return i < 0 ? null : [i, i + String(w).length, w]; })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);
  let count = 0;
  let score = 0;
  let best = 0;
  let end = -1;
  for (const [s, e, w] of spans) {
    if (s >= end) { if (count) score += best; count += 1; best = weightOf(w); }
    else best = Math.max(best, weightOf(w));
    if (e > end) end = e;
  }
  if (count) score += best;
  return { words: accepted, count, score, spans };
}

/**
 * 独立印证数(R3 同击制):poolSpans 中与 baseSpans 任一跨度均不重叠的命中数([s,e) 半开区间互斥)。
 * "死锁"同时入 R3_SIGNS 与 CRITICAL 时,两池命中是同一跨度 ⇒ 不算印证,必须再来一个别的词。
 */
export function spansBeyond(poolSpans, baseSpans) {
  const bases = Array.isArray(baseSpans) ? baseSpans : [];
  let n = 0;
  for (const [s, e] of (Array.isArray(poolSpans) ? poolSpans : [])) {
    if (!bases.some(([bs, be]) => s < be && bs < e)) n += 1;
  }
  return n;
}

/** 逐词权重倍数档案 → weightOf 函数(clamp 到 [0.4,2.0];active===false 或非法值 → 1)。 */
function weightFn(pool, calibration) {
  const tbl = calibration?.signals?.[pool];
  if (!tbl) return () => 1;
  return (word) => {
    const e = tbl[String(word).toLowerCase()] || tbl[String(word)];
    if (!e || e.active === false || !Number.isFinite(Number(e.multiplier))) return 1;
    return clamp(Number(e.multiplier), 0.4, 2);
  };
}

/** 档案 → 门槛(全部缺省即旧判定;verifyMin=1 时疑问拦截与原 `some()` 逐位等价)。 */
function thresholdsOf(calibration) {
  const t = calibration?.thresholds || {};
  return { critMin: num(t.critMin, 1), editMin: num(t.editMin, 2), verifyMin: num(t.verifyMin, 1), verifyOverride: num(t.verifyOverride, 0) };
}

const _calibCache = new Map();

/**
 * 读难度倍数档案(data/routing/tier-calibration.json)。只认 `enabled === true`——
 * 优化器产出的候选档案默认关闭,人工 --enable 才被消费(#11 门控哲学,同 classify.loadCalibration)。
 * 按 mtime+大小缓存(同毫秒内的两次写入大小不同,不会读到旧内容),读失败返回 null(分类器退回纯词法,零影响)。
 */
export function loadTierCalibration(file = path.join(DATA_DIR, 'routing', 'tier-calibration.json')) {
  try {
    const st = fs.statSync(file);
    const hit = _calibCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = raw && raw.enabled === true ? raw : null;
    _calibCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch { return null; }
}

/** 清掉档案缓存(测试与"刚改完档案就想立刻生效"的调用方用)。 */
export function resetTierCalibrationCache() { _calibCache.clear(); }

/**
 * prompt → 难度档。返回 {tier, confidence, signals, reason, scores?}。
 * 定档优先级:显式旗舰(R4)> 纯提问(R1)> 顶格词+独立印证(R3)> 关键性信号(R2)> 编辑印证/范围(R2)> 杂务(R1)> 默认 R1。
 * 档位上限 R3(顶格词+印证同击可达;P2 行为证据亦可逐级上梯)、R4 只能显式点名(2026-11-08 重建裁定,见文件头)。
 * scores 仅在传入 calibration 时附带(审计用:优化器要看加分来自哪些信号)。
 */
export function classifyDifficulty(text, { calibration = null } = {}) {
  const raw = String(text || '');
  const t = stripCitations(raw).trim();
  if (t.length < 2) return { tier: 'R1', confidence: 0.3, signals: [], reason: '过短/空 → 默认日常主力档' };
  const low = t.toLowerCase();
  const TH = thresholdsOf(calibration);

  // 显式点名旗舰 → R4(用户明确要最好的,高置信)
  const flagship = collect(low, FLAGSHIP_DEMAND);
  if (flagship.count) return { tier: 'R4', confidence: 0.95, signals: flagship.words, reason: '显式点名旗舰模型 → 奢侈档' };

  // 关键性/编辑印证得分先算:疑问拦截在 verifyOverride>0 且证据够硬时可被推翻(档案门控,默认关闭)
  const critical = collect(low, CRITICAL_SIGNS, weightFn('CRITICAL_SIGNS', calibration));
  const edit = collect(low, EDIT_SIGNS, weightFn('EDIT_SIGNS', calibration));
  const scopeW = collect(low, SCOPE_WORDS, weightFn('SCOPE_WORDS', calibration));
  const r1 = hitsOf(low, R1_SIGNS);

  // 纯提问/征询(疑问词 + 无强祈使前缀)→ R1:在问不是在做,防止"什么是重构""重构怎么做"误升档
  const hasVerify = VERIFY_WORDS.some((w) => low.includes(w));
  // 档案存在时疑问拦截改按加权分触发:低纯度疑问词(样本内常伴重活)单独不足以拦停靠
  const verifyScore = calibration ? collect(low, VERIFY_WORDS, weightFn('VERIFY_WORDS', calibration)).score : null;
  const verifyFires = hasVerify && (verifyScore === null || verifyScore >= TH.verifyMin);
  const hasImperative = IMPERATIVE_PREFIX.some((w) => low.includes(w.toLowerCase()));
  // 审查/评审是动作不是提问("review 一下有什么隐患"=找问题,不是问问题):强审查词豁免疑问拦截
  const strongReview = collect(low, ['review', '审查', '评审', '代码检查', '找问题', 'code review']).count > 0;
  if (verifyFires && !hasImperative && !strongReview && !(TH.verifyOverride > 0 && critical.score >= TH.verifyOverride)) {
    const q = r1;
    return { tier: 'R1', confidence: q.length ? 0.85 : 0.6, signals: q.length ? q : [t.slice(0, 20)], flags: { verifyBlocked: true }, reason: '纯提问/征询 → 日常主力档' };
  }

  // R3 词法可达·顶格词+独立印证同击(2026-11-08 重建裁定,见文件头):
  // 顶格词命中(≥1)且 CRITICAL/EDIT/SCOPE 在非重叠跨度上另有印证才判 R3;否则落回下文的 R2/R1 常规池。
  // 疑问拦截(上方)已把"为什么死锁"类返 R1;旗舰点名(函数头部)已把"用最强的模型排查线上故障"返 R4。
  const r3hits = collect(low, R3_SIGNS);
  if (r3hits.count >= 1) {
    const beyond = spansBeyond([...critical.spans, ...edit.spans, ...scopeW.spans], r3hits.spans);
    if (beyond >= 1) {
      return {
        tier: 'R3', confidence: 0.8, signals: r3hits.words,
        scores: calibration ? { critical: Number(critical.score.toFixed(3)), edit: Number(edit.score.toFixed(3)), scope: Number(scopeW.score.toFixed(3)), corroborate: beyond } : undefined,
        reason: `顶格词+独立印证同击(R3_${r3hits.words.join('+')},非重叠印证 ${beyond} 处)→ R3(词法可达上限;误升面由影子审计观察)`,
      };
    }
  }

  const scores = { critical: Number(critical.score.toFixed(3)), edit: Number(edit.score.toFixed(3)), scope: Number(scopeW.score.toFixed(3)) };
  if (critical.score >= TH.critMin) {
    return {
      tier: 'R2', confidence: critical.count >= 2 ? 0.85 : 0.8, signals: critical.words,
      scores: calibration ? scores : undefined,
      // D4 临界 flags(2026-11-09):r3NearMiss=顶格词命中但独立印证不足(差一步到 R3);marginalR2=单信号边际置信
      flags: (r3hits.count >= 1 || critical.count < 2) ? { ...(r3hits.count >= 1 ? { r3NearMiss: true } : {}), ...(critical.count < 2 ? { marginalR2: true } : {}) } : undefined,
      reason: '关键性/慎重信号 → 增强档(R2 起步;仍解决不了由 P2 证据升级逐级上梯;直达 R3 需顶格词同击)',
    };
  }
  const editSum = edit.score + (scopeW.score > 0 ? scopeW.score : 0);
  if (edit.count && editSum >= TH.editMin) {
    return {
      tier: 'R2', confidence: 0.75, signals: edit.words,
      scores: calibration ? scores : undefined,
      flags: { marginalR2: true }, // D4:编辑印证型 R2 属边际置信,供临界仲裁票影子对账
      reason: scopeW.score > 0 ? '编辑改动 + 全局范围 → 增强档' : '多处独立编辑改动 → 增强档',
    };
  }
  if (r1.length) return { tier: 'R1', confidence: 0.7, signals: r1, reason: '杂务/文档/问答信号 → 日常主力档' };
  if (edit.count) return { tier: 'R1', confidence: 0.65, signals: edit.words, reason: '单个编辑动词:例行小改维持 R1(8 倍档需慎重/印证/范围)' };
  return { tier: 'R1', confidence: 0.4, signals: [], reason: '无信号命中 → 默认日常主力档' };
}

// ---------- 短轮判定(2026-11-22) ----------
// 历史会话数据:难度影子账本 877 轮里 ≤30 字短轮占 36.9%;其中 71% 是无信号兜底/纯提问拦截——
// 不是因为"简单",而是"单看这句判不出"。任务档是任务的属性不是单句的属性:
// 第一档落地(用户定档 2026-11-22):isContinuationTurn 进实弹 decideTarget——续接轮在阶段内
// 沿用阶段档,不触发 R1 降档拆阶段;classifyShortTurn 保留为影子账 shortTurn 字段的细分类。

/** 确认句词集(归一后精确相等才算,避免"对这个函数…"里的"对"误判)。ASCII 小写比较。 */
const ACK_TURNS = new Set(['好的', '好', '好嘞', '好滴', '收到', '对', '对的', '嗯', '嗯嗯', '是的', '可以', '行', 'ok', 'okay', '继续', '明白', '懂了', '了解', '同意', 'yes', 'right', 'continue', 'go on']);
/** 短轮阈值:归一后(去空白/标点)≤8 字符——好的/继续/对/修一下/改成蓝色 都在内;完整指令不会,会被当非短轮。 */
const SHORT_TURN_MAX = 8;
const _noiseRe = /[\s，。,.\u0021\u003f\u3001\u2026~～]/g;

/** 归一:去中英标点与空白(做类别判定用,不含词法信号语义)。 */
function _normalizeShort(text) { return String(text || '').replace(_noiseRe, '').toLowerCase(); }

/**
 * 短轮类别(2026-11-22 影子账 shortTurn 字段细分类):short=归一后字符数 ≤8;kind ∈ 'ack'(确认句)|'instr'(新短指令)|null(非短轮)。
 * 非短轮 kind=null,调用方跳过。续接闸的粗判定用 isContinuationTurn(下方);本函数只管影子账细分类,不改实弹。
 */
export function classifyShortTurn(text) {
  const norm = _normalizeShort(text);
  if (!norm || norm.length > SHORT_TURN_MAX) return { short: false, kind: null, norm };
  const kind = ACK_TURNS.has(norm) ? 'ack' : 'instr';
  return { short: true, kind, norm };
}

/** 换题标记:命中即"这是新任务",阶段档不延续(续接闸对它放行,按当轮难度重定档)。 */
const SWITCH_TOPIC_MARKS = ['另外', '换个', '换一个', '换任务', '先不管', '新任务', '还有一件事', '题外话'];
/** 指代/续接标记:长轮须含其一才算续接(短轮凭长度已够);不含"它"(避开"其他"误命中)。 */
const CONTINUATION_MARKS = ['这个', '那个', '这些', '那些', '刚才', '上面', '继续', '接着', '然后', '下一步', '还是', '该'];

/**
 * 续接轮判定(2026-11-22 第一档,进实弹 decideTarget):判断本轮是否在延续阶段内的任务。
 * 多信号,按优先级:①换题标记 → 明确新任务(kind='switch');②确认句精确命中(kind='ack');
 * ③短碎片(归一后 ≤8)一律当续接(kind='instr',阶段在途时短指令/短插问都 presumption 续接,
 * 阶段轮数上限+cache TTL 兜底);④长轮须含指代标记才算(kind='deictic')。
 * 非短轮且无指代 → 不是续接,按当轮难度独立定档(纯新指令不受影响)。
 */
export function isContinuationTurn(text) {
  const norm = _normalizeShort(text);
  if (!norm) return { continuation: false, kind: null, norm };
  if (SWITCH_TOPIC_MARKS.some((m) => norm.includes(m))) return { continuation: false, kind: 'switch', norm };
  if (ACK_TURNS.has(norm)) return { continuation: true, kind: 'ack', norm };
  if (norm.length <= SHORT_TURN_MAX) return { continuation: true, kind: 'instr', norm };
  if (CONTINUATION_MARKS.some((m) => norm.includes(m))) return { continuation: true, kind: 'deictic', norm };
  return { continuation: false, kind: null, norm };
}

/**
 * 任务型 → R1-R2 难度档的**设计映射**(黄金集 R 真值来源,scoreGoldenTier 用)。
 * 2026-11-06 三档定稿:multi(多点改组,旧 T4/T5)= 慎重工作起步 R2;routine(例行,旧 T2/T3/T6/T7)
 * 与 light(询问杂务,旧 T1/T8)= R1(解决不了由 P2 逐级上梯)。
 * R3 **真值**仍仅 P2 行为证据可达、R4 真值仅显式点名可达(词法 R3 是预测侧通道,#14 预测不回灌,
 * 故真值表仍不含 R3/R4;scoreGoldenTier 的 R3/R4 覆盖续为 0,词法 R3 质量由影子审计+实弹账本观察,
 * 自进化 v2 区间真值落地后有下界行才进量尺)。
 * 该槽位由四票代签写入(L1 词法/L2 向量/行为形态各 1 票 + 决策模型加权,见 autoLabel.mjs);
 * 四票里没有 classifyDifficulty(被评者),行为票是结果侧证据 ⇒ 非预测回灌。
 * 兼容键:旧 T1-T8 值保留(历史黄金集/日志的 R 真值派生),映射与三档定稿同口径。
 */
export const TIER_FROM_TYPE = {
  multi: 'R2', routine: 'R1', light: 'R1',
  T1: 'R1', T8: 'R1',
  T2: 'R1', T3: 'R1', T6: 'R1', T7: 'R1',
  T4: 'R2', T5: 'R2',
};

/**
 * 双轴强度 → R 档(2026-11-06):**仅作回落通道**,不作为 R 真值首选。
 * 依据(实测,当前黄金集 172 行):R 真值按语义轴派生 acc 0.767,按强度轴派生只有 0.671——强度轴量的是
 * "这轮实际干了多重的活"(结果侧),活多不等于要强模型(读 15 个文件的轮照样 R1)。强度轴的正当用途是
 * 行为成本度量(跨档占比/漏升返工),不是"应该需要哪一档"。
 */
export const TIER_FROM_INTENSITY = {
  heavy: 'R2', normal: 'R1', light: 'R1',
};
