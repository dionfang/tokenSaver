/**
 * 难度定档分类器(2026-11-04 用户定档 v2:按真实资费语义重排四档门槛)。
 * 资费梯度:R1=1x(日常主力)/ R2=8x(增强)/ R3=15x(最强)/ R4=100x(奢侈)⇒ 成本悬崖在 R1→R2(8 倍),
 * R2→R3 仅 ~2 倍,词法门槛据此设计:
 *   - R1:问答/杂务/单点例行编辑——单个编辑动词不构成升档理由(例行小改不值 8 倍);
 *   - R2:**慎重修改**才升——关键性/疑难信号命中,或编辑动词多重印证(≥2 处独立改动),或全局范围改动;
 *   - R3:词法永不可达。只有 P2 证据升级(当前服务档连续 2 轮修复失败)逐级上梯 R1→R2→R3——
 *     "R2 明确无法解决"是行为证据,prompt 词法无法预知;
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
 * 返回 { words, count, score }:count 是合并重叠命中后的独立命中数("修改成"只算 1 次编辑动词);
 * score 是同跨度按权重(默认 1)取最大后的加权和 ⇒ 权重全为 1 时 score === count(旧行为逐位复现)。
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
  return { words: accepted, count, score };
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
 * 定档优先级:显式旗舰(R4)> 纯提问(R1)> 关键性信号(R2)> 编辑印证/范围(R2)> 杂务(R1)> 默认 R1。
 * 档位上限 R2:R3 只能由 P2 行为证据上梯、R4 只能显式点名(资费语义,见文件头)。
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
    return { tier: 'R1', confidence: q.length ? 0.85 : 0.6, signals: q.length ? q : [t.slice(0, 20)], reason: '纯提问/征询 → 日常主力档' };
  }

  const scores = { critical: Number(critical.score.toFixed(3)), edit: Number(edit.score.toFixed(3)), scope: Number(scopeW.score.toFixed(3)) };
  if (critical.score >= TH.critMin) {
    return {
      tier: 'R2', confidence: critical.count >= 2 ? 0.85 : 0.8, signals: critical.words,
      scores: calibration ? scores : undefined,
      reason: '关键性/慎重信号 → 增强档(R2 起步;仍解决不了由 P2 证据升级逐级上梯,词法不直达 R3)',
    };
  }
  const editSum = edit.score + (scopeW.score > 0 ? scopeW.score : 0);
  if (edit.count && editSum >= TH.editMin) {
    return {
      tier: 'R2', confidence: 0.75, signals: edit.words,
      scores: calibration ? scores : undefined,
      reason: scopeW.score > 0 ? '编辑改动 + 全局范围 → 增强档' : '多处独立编辑改动 → 增强档',
    };
  }
  if (r1.length) return { tier: 'R1', confidence: 0.7, signals: r1, reason: '杂务/文档/问答信号 → 日常主力档' };
  if (edit.count) return { tier: 'R1', confidence: 0.65, signals: edit.words, reason: '单个编辑动词:例行小改维持 R1(8 倍档需慎重/印证/范围)' };
  return { tier: 'R1', confidence: 0.4, signals: [], reason: '无信号命中 → 默认日常主力档' };
}

/**
 * 任务型 → R1-R2 难度档的**设计映射**(黄金集 R 真值来源,scoreGoldenTier 用)。
 * 2026-11-06 三档定稿:multi(多点改组,旧 T4/T5)= 慎重工作起步 R2;routine(例行,旧 T2/T3/T6/T7)
 * 与 light(询问杂务,旧 T1/T8)= R1(解决不了由 P2 逐级上梯)。
 * R3 仅 P2 行为证据可达、R4 仅显式点名可达——prompt 词法无法预知,故真值不含 R3/R4
 * (scoreGoldenTier 的 R3/R4 覆盖恒 0,R3 路由质量由 P2 探针与实弹账本观察)。
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
