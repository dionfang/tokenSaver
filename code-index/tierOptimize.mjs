/**
 * 黄金集迭代优化器(2026-11-04,把"扩样 → 定真值 → 评成本 → 学参数 → 门控 → 报告"串成一轮可重复跑的循环)。
 *
 * 它优化的是什么:**难度档命中率的经济后果**,不是裸准确率。
 *   资费 R1 1x / R2 8x / R3 15x / R4 100x,缓存画像见 costProfile.mjs(隐式热 0.23 / 冷 1.00 / 税 0.77)。
 *   ⇒ 误升一档 = 换档必冷读 = 倍率 × 冷读(损失按倍率放大);漏升一档 = 弱档空转 failTurns 轮 + 之后照样冷读 + 质量损失。
 *   目标函数 = 逐行 decisionCost 之和(M R1 等效 token),报告里与 alwaysR1 / oracle 两条基准线并排给出。
 *
 * 铁律(与 #14 治理一致,代码层强制):
 *   1. **预测不回灌**:真值只来自①结果侧行为形态(tierTruth.mjs,签名里没有 prompt)②T→R 设计映射。
 *      本模块学的只是"已有词表里每个信号的权重倍数 + 四个门槛(critMin/editMin/verifyMin/verifyOverride)",**永不自动改词表**;
 *      词表候选(新词)只进报告的"待人工确认"清单,附带样本内模拟收益,不自动入库。
 *   2. **候选档案默认 enabled:false**,消费端 loadTierCalibration 只认真开;启用 = 人的决定(#11 两道门)。
 *   3. **门控接受**:候选档案必须在 k 折交叉验证的**折外**代价上优于现网(或代价不升且准确率明显提升),
 *      且 R1 召回不得倒退超过 maxR1RecallDrop ⇒ 否则只写报告不落档案。小样本(现 111 条)必过 CV,防把噪声学成规律。
 *   4. 双真值口径**分开报数**(behavior / map),两者一致率本身作为"量尺软硬度"指标输出,永不混算。
 *   5. 全程 fail-open:任何一步失败只留痕,不影响黄金集已有内容与线上路由。
 *
 * 用法:
 *   node tierOptimize.mjs --iterate [--force] [--no-grow] [--fit-cost] [--folds 5] [--min-n 6]
 *                         [--allow-boost] [--quality-penalty 1.0] [--dry]
 *   node tierOptimize.mjs --eval [--truth behavior|map]     # 只评估,不写档案
 *   node tierOptimize.mjs --mine                             # 词表候选(人工确认清单)
 *   node tierOptimize.mjs --enable | --disable | --profile | --history | --report
 * 自动:prompt-guard 的 --check 后台分支按 modelRouting.tierOptimize.enabled(默认 false)+ 6h 节流调用 maybeOptimizeTier。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { classifyDifficulty, TIER_LEXICON, termPresent, loadTierCalibration } from './tierClassify.mjs';
import { reconcile, evidenceOf } from './tierTruth.mjs';
import { resolveCostProfile, policyCost, fitFromLedger, DEFAULT_COST_PROFILE } from './costProfile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = {
  golden: 'routing/golden-set.jsonl',
  profile: 'routing/tier-calibration.json',                 // live:消费端唯一读取面(loadTierCalibration)
  candidate: 'routing/tier-calibration-candidate.json',     // 最近一次折外过门控的候选(恒 enabled:false)
  prev: 'routing/tier-calibration-prev.json',               // 晋升前的 live 备份(回滚恢复源)
  promotion: 'routing/tier-promotion.jsonl',                // 晋升/停用/回滚台账(带签名与冷却期)
  cost: 'routing/cost-profile.json',
  report: 'routing/tier-optimize-report.md',
  history: 'routing/tier-optimize-history.jsonl',
  state: 'routing/tier-optimize-state.json',
  usage: 'usage/proxy-usage.jsonl',
};
const DEFAULTS = {
  folds: 5, minN: 6, priorN: 8, allowBoost: false, truth: 'behavior',
  minImprovement: 0.03, minAccGain: 0.05, maxR1RecallDrop: 0.02,
  // 门槛搜索网格:只搜四个门槛的小网格,组合数受控(过拟合面比逐词学习更小)
  // verifyMin:疑问拦截的加权分门槛(>1 让低纯度疑问词单独拦不住 R2);verifyOverride:关键性分够高时豁免疑问拦截
  grid: { critMin: [1], editMin: [2, 3], verifyMin: [1, 1.2], verifyOverride: [0, 2] },
};
const TIERS = ['R1', 'R2', 'R3', 'R4'];
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r3 = (v) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(3)) : null);

const f = (dataDir, k) => path.join(dataDir, FILES[k]);
function readJsonl(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1) + '\n'); }
function appendJsonl(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(obj) + '\n'); }

/** 稳定折划分:按 pkey/id 哈希,同一条目跨迭代恒定在同折(否则"折外"每次换人,趋势不可比)。 */
export function foldOf(key, k = DEFAULTS.folds) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 131 + s.charCodeAt(i)) >>> 0;
  return h % Math.max(2, k);
}

/**
 * 黄金集 → 评估行(带双真值 + 现网预测)。只收"至少一条真值通道给得出档"的条目。
 * truthSource='behavior' 用行为侧(独立于词法),'map' 用 T→R 映射,'both' 只留两条一致的条目(最硬子集)。
 */
export function loadEvalRows({ dataDir = DATA_DIR, goldenFile = null, truth = 'behavior' } = {}) {
  const rows = readJsonl(goldenFile || f(dataDir, 'golden'));
  const out = [];
  for (const r of rows) {
    const rec = reconcile(r, { prefer: truth === 'map' ? 'map' : 'behavior' });
    const bTruth = rec.behavior;
    const mTruth = rec.map;
    let trueTier = null;
    let source = null;
    if (truth === 'map') { trueTier = mTruth; source = 'map'; }
    else if (truth === 'both') { if (bTruth && mTruth && rec.agree) { trueTier = bTruth; source = 'both'; } }
    else { trueTier = bTruth || mTruth; source = bTruth ? 'behavior' : (mTruth ? 'map' : null); }
    if (!trueTier) continue;
    const pred = classifyDifficulty(r.prompt || '');
    out.push({
      id: r.id || null, pkey: r.pkey || r.id || String(r.prompt || '').slice(0, 40),
      prompt: r.prompt || '', type: r.humanLabel || null, autoSigned: r.autoSigned === true,
      evidence: evidenceOf(r), trueTier, truthSource: source, behaviorTruth: bTruth, mapTruth: mTruth,
      agree: rec.agree, predTier: pred.tier, predSignals: pred.signals || [], predReason: pred.reason,
    });
  }
  return out;
}

/** 逐档 precision/recall + 混淆矩阵(以真值为行、预测为列)。 */
export function tierMatrix(rows, predOf = (r) => r.predTier) {
  const conf = {};
  for (const r of rows) {
    const p = predOf(r) || 'R1';
    (conf[r.trueTier] || (conf[r.trueTier] = {}))[p] = (conf[r.trueTier]?.[p] || 0) + 1;
  }
  const perTier = {};
  for (const t of TIERS) {
    const actual = rows.filter((r) => r.trueTier === t).length;
    const predicted = rows.filter((r) => (predOf(r) || 'R1') === t).length;
    const hit = rows.filter((r) => r.trueTier === t && (predOf(r) || 'R1') === t).length;
    if (!actual && !predicted) continue;
    perTier[t] = { actual, predicted, hit, recall: actual ? r3(hit / actual) : null, precision: predicted ? r3(hit / predicted) : null };
  }
  return { perTier, confusion: conf };
}

/**
 * 学逐信号倍数(纯统计,不看预测)。以"该轮真值是否需要 ≥R2"为正例,对每个池逐词算
 * Laplace 收缩后的相对倍率:倍率 = 平滑后正例率 / 全局基准率。
 * 默认**只降不升**(allowBoost=false ⇒ 倍率上限 1),与 calibrateSignals 同一条保守红线;
 * 支持样本不足 minN 的词一律不动(multiplier=1、active=false)。
 */
/**
 * 学逐信号倍数(纯统计,不看预测)。每个池先定**方向**再统计,因为两个池的"正例"含义相反:
 *   - CRITICAL/EDIT/SCOPE 是给 R2 加分的证据 ⇒ 正例 = 真值 ≥R2;倍率 <1 = 这类词在样本里其实常是例行活,该降权;
 *   - VERIFY_WORDS 是"在问不是在做"的**拦停靠** ⇒ 正例 = 真值 R1;倍率 <1 = 这个疑问词单独不足以拦停。
 *   - R1_SIGNS 不参与(它只改 reason/置信,不改档位)、FLAGSHIP_DEMAND 不参与(R4 只认显式点名)。
 * Laplace 向基准率收缩:倍率 = (正例 + priorN×基准) / (支持 + priorN) / 基准;支持 < minN 一律不动。
 * 默认**只降不升**(allowBoost=false ⇒ 倍率上限 1),与 calibrateSignals 同一条保守红线。
 */
const POOL_DIRECTION = { CRITICAL_SIGNS: 'R2', EDIT_SIGNS: 'R2', SCOPE_WORDS: 'R2', VERIFY_WORDS: 'R1' };

export function learnSignals({ rows = [], minN = DEFAULTS.minN, priorN = DEFAULTS.priorN, allowBoost = DEFAULTS.allowBoost } = {}) {
  const labeled = rows.filter((r) => r.trueTier);
  const heavy = labeled.filter((r) => TIERS.indexOf(r.trueTier) >= 1).length;
  const baseR2 = labeled.length ? heavy / labeled.length : 0;
  const baseR1 = labeled.length ? 1 - baseR2 : 0;
  const lo = 0.4;
  const hi = allowBoost ? 2 : 1;
  const signals = {};
  const skipped = [];
  for (const [pool, words] of Object.entries(TIER_LEXICON)) {
    const dir = POOL_DIRECTION[pool];
    if (!dir) continue;
    const baseRate = dir === 'R2' ? baseR2 : baseR1;
    const tbl = {};
    for (const word of words) {
      let n = 0;
      let pos = 0;
      for (const r of labeled) {
        if (!termPresent(String(r.prompt || '').toLowerCase(), word)) continue;
        n += 1;
        const isHeavy = TIERS.indexOf(r.trueTier) >= 1;
        if (dir === 'R2' ? isHeavy : !isHeavy) pos += 1;
      }
      if (n < minN) { skipped.push({ pool, word, n }); continue; }
      const smoothed = (pos + priorN * baseRate) / (n + priorN);
      const mult = baseRate > 0 ? smoothed / baseRate : 1;
      tbl[String(word).toLowerCase()] = { n, positive: pos, direction: dir, rate: r3(pos / n), multiplier: r3(Math.min(hi, Math.max(lo, mult))), active: true };
    }
    if (Object.keys(tbl).length) signals[pool] = tbl;
  }
  return { signals, baseRate: r3(baseR2), baseRateR1: r3(baseR1), labeled: labeled.length, minN, priorN, allowBoost, skippedTerms: skipped.length };
}

/** 档案对象(学习产物 + 门槛)——消费端与评估端同一形状。 */
function candidateProfile({ learned, thresholds }) {
  return { signals: learned.signals, thresholds: { critMin: thresholds.critMin, editMin: thresholds.editMin, verifyMin: thresholds.verifyMin, verifyOverride: thresholds.verifyOverride } };
}

/** 一套参数在给定行集上的完整评估(准确率 + 成本 + 逐档 + 混淆)。 */
export function evaluate({ rows = [], calibration = null, cost = null } = {}) {
  const cp = resolveCostProfile(cost);
  const withPred = rows.map((r) => ({ ...r, predTier: (classifyDifficulty(r.prompt, { calibration }) || {}).tier || 'R1' }));
  const pol = policyCost(cp, withPred.map((r) => ({ trueTier: r.trueTier, predTier: r.predTier })));
  const { perTier, confusion } = tierMatrix(withPred);
  const tokOnly = policyCost({ ...cp, qualityPenaltyPerStepM: 0 }, withPred.map((r) => ({ trueTier: r.trueTier, predTier: r.predTier })));
  return { rows: withPred, ...pol, perTier, confusion, tokenOnlyTotal: tokOnly.total, tokenOnlyAccuracy: tokOnly.accuracy };
}

/**
 * k 折交叉验证:每折用**其余折**学倍数,在本折上评估;现网与候选都在"同一折内序列"上算代价
 * (折边界状态重置,两边口径逐字一致 —— 否则序列代价因切分不同而不可比,这是本模块最容易骗自己的地方)。
 * 每折只学一次倍数,门槛组合复用;取折外总代价最低的一套进入接受门控。
 */
export function crossValidate({ rows = [], cost = null, folds = DEFAULTS.folds, minN = DEFAULTS.minN, priorN = DEFAULTS.priorN, allowBoost = DEFAULTS.allowBoost, grid = DEFAULTS.grid } = {}) {
  const cp = resolveCostProfile(cost);
  const labeled = rows.filter((r) => r.trueTier);
  const buckets = [];
  for (let i = 0; i < folds; i++) buckets.push([]);
  for (const r of labeled) buckets[foldOf(r.pkey, folds)].push(r);
  const combos = [];
  for (const critMin of grid.critMin) for (const editMin of grid.editMin) for (const verifyMin of grid.verifyMin) for (const verifyOverride of grid.verifyOverride) combos.push({ critMin, editMin, verifyMin, verifyOverride });
  const foldData = [];
  for (let i = 0; i < folds; i++) {
    const test = buckets[i];
    if (!test.length) continue;
    const train = buckets.filter((_, j) => j !== i).flat();
    const learned = learnSignals({ rows: train, minN, priorN, allowBoost });
    foldData.push({
      i,
      leg: evaluate({ rows: test, calibration: null, cost: cp }),
      cand: combos.map((th) => evaluate({ rows: test, calibration: candidateProfile({ learned, thresholds: th }), cost: cp })),
    });
  }
  const agg = (pick) => {
    let total = 0;
    let token = 0;
    let penalty = 0;
    let hit = 0;
    let over = 0;
    let under = 0;
    let switches = 0;
    let n = 0;
    const perFold = [];
    const allRows = [];
    for (const fd of foldData) {
      const e = pick(fd);
      total += e.total;
      token += e.tokenCost;
      penalty += e.qualityPenalty;
      hit += e.hit;
      over += e.over;
      under += e.under;
      switches += e.switches;
      n += e.n;
      allRows.push(...e.rows);
      perFold.push({ fold: fd.i, n: e.n, total: Number(e.total.toFixed(2)), accuracy: e.accuracy });
    }
    return {
      n, hit, over, under, switches, perFold,
      total: Number(total.toFixed(3)), tokenCost: Number(token.toFixed(3)), qualityPenalty: Number(penalty.toFixed(3)),
      accuracy: n ? Number((hit / n).toFixed(3)) : null,
      perTier: tierMatrix(allRows).perTier,
    };
  };
  const legacy = agg((fd) => fd.leg);
  const runs = combos.map((th, idx) => ({ thresholds: th, ...agg((fd) => fd.cand[idx]) })).sort((a, b) => a.total - b.total);
  const best = runs[0] || null;
  // 接受门控:折外代价显著优于现网,或代价不升但准确率明显提升;且 R1 召回不倒退超容忍
  const legacyR1Recall = legacy.perTier.R1?.recall ?? null;
  const bestR1Recall = best?.perTier?.R1?.recall ?? null;
  const reasons = [];
  let accepted = false;
  if (!best || !foldData.length) reasons.push('无可用折外结果');
  else {
    const gain = legacy.total > 0 ? (legacy.total - best.total) / legacy.total : 0;
    const accGain = best.accuracy - legacy.accuracy;
    const recallDrop = legacyR1Recall !== null && bestR1Recall !== null ? legacyR1Recall - bestR1Recall : 0;
    if (gain >= num(DEFAULTS.minImprovement, 0.03)) accepted = true;
    else if (best.total <= legacy.total && accGain >= num(DEFAULTS.minAccGain, 0.05)) accepted = true;
    else reasons.push(`折外代价改善 ${(gain * 100).toFixed(1)}% < 门槛 ${DEFAULTS.minImprovement * 100}%,准确率变化 ${accGain >= 0 ? '+' : ''}${accGain.toFixed(3)}`);
    if (accepted && recallDrop > num(DEFAULTS.maxR1RecallDrop, 0.02)) { accepted = false; reasons.push(`R1 召回倒退 ${recallDrop.toFixed(3)} > 容忍 ${DEFAULTS.maxR1RecallDrop}`); }
    if (accepted && best.under > legacy.under) reasons.push(`注意:漏升数 ${legacy.under}→${best.under}(代价仍降,因误升更贵)`);
  }
  return { legacy, best, runs: runs.slice(0, 4), accepted, reasons, folds: folds, labeled: labeled.length, perBucket: buckets.map((b) => b.length) };
}

const ASCII_TOKEN = /[a-z][a-z0-9._+-]{2,}/g;
const CJK_RUN = /[一-龥]{2,}/g;
const STOP_BIGRAM = new Set(['的话', '什么', '这个', '那个', '现在', '已经', '可以', '不是', '就是', '一个', '我们', '还是', '如果', '因为', '所以', '但是', '一下', '目前', '然后', '项目', '代码', '文件', '麻烦', '帮我']);

/**
 * 词法候选挖掘:**只用于报告,永不自动入词表**(#14 红线)。
 * 中文取二字组、ASCII 取整词,筛"支持数 ≥minSupport 且 R2+ 正例率 ≥minRate"的词,按正例支持数排序。
 * 模拟收益是把该词当作**已加入 CRITICAL_SIGNS**后的近似(命中即 R2,疑问拦截仍在前),且词就是从这批行挖出来的
 * ⇒ 样本内乐观值,只用来排序"值不值得人工看一眼"。
 */
export function mineTerms({ rows = [], minSupport = 5, minRate = 0.7, limit = 20, cost = null } = {}) {
  const cp = resolveCostProfile(cost);
  const labeled = rows.filter((r) => r.trueTier);
  const existing = new Set(Object.values(TIER_LEXICON).flat().map((w) => String(w).toLowerCase()));
  const stat = new Map();
  for (const r of labeled) {
    const low = String(r.prompt || '').toLowerCase();
    const toks = new Set();
    for (const m of low.match(ASCII_TOKEN) || []) toks.add(m);
    for (const run of low.match(CJK_RUN) || []) for (let i = 0; i + 2 <= run.length; i++) toks.add(run.slice(i, i + 2));
    const pos = TIERS.indexOf(r.trueTier) >= 1;
    for (const tk of toks) {
      if (existing.has(tk) || STOP_BIGRAM.has(tk) || /^\d/.test(tk)) continue;
      const s = stat.get(tk) || { term: tk, n: 0, pos: 0 };
      s.n += 1;
      if (pos) s.pos += 1;
      stat.set(tk, s);
    }
  }
  const candidates = [...stat.values()].filter((s) => s.n >= minSupport && s.pos / s.n >= minRate).sort((a, b) => b.pos - a.pos || b.n - a.n).slice(0, limit);
  const preds = labeled.map((r) => ({ trueTier: r.trueTier, legacy: classifyDifficulty(r.prompt).tier, low: String(r.prompt || '').toLowerCase() }));
  const before = policyCost(cp, preds.map((p) => ({ trueTier: p.trueTier, predTier: p.legacy })));
  const simulation = [];
  for (const c of candidates.slice(0, 8)) {
    const after = policyCost(cp, preds.map((p) => {
      const promoted = termPresent(p.low, c.term) && p.legacy === 'R1';
      return { trueTier: p.trueTier, predTier: promoted ? 'R2' : p.legacy };
    }));
    simulation.push({ term: c.term, n: c.n, pos: c.pos, total: after.total, accuracy: after.accuracy, deltaTotal: r3(after.total - before.total), deltaAcc: r3(after.accuracy - before.accuracy) });
  }
  return { before: { n: before.n, total: before.total, accuracy: before.accuracy }, candidates, simulation };
}

/** 档案签名:门槛 + 所有被学习且非默认倍率的信号词 → "同一解法"判定(晋升去重/回滚冷却)。 */
export function profileSignature(profile) {
  const th = profile && typeof profile === 'object' && profile.thresholds && typeof profile.thresholds === 'object' ? profile.thresholds : {};
  const sig = { th: { critMin: th.critMin, editMin: th.editMin, verifyMin: th.verifyMin, verifyOverride: th.verifyOverride }, s: {} };
  for (const [pool, tbl] of Object.entries(profile?.signals || {})) {
    if (!tbl || typeof tbl !== 'object') continue;
    for (const [w, e] of Object.entries(tbl)) {
      if (!e || e.active === false || !Number.isFinite(Number(e.multiplier))) continue;
      if (Number(e.multiplier) !== 1) sig.s[`${pool}/${String(w)}`] = Number(e.multiplier);
    }
  }
  return JSON.stringify(sig);
}

/** 候选档案落盘(恒 enabled:false,**绝不写 live**)。迭代优化器唯一的档案落盘面。 */
export function writeTierCandidate({ dataDir = DATA_DIR, profile = {} } = {}) {
  writeJson(f(dataDir, 'candidate'), { ...profile, enabled: false });
  return { file: f(dataDir, 'candidate'), enabled: false };
}

/**
 * 晋升:候选 → live(enabled:true)。旧 live(若有)备份到 prev;逐次晋升落台账(签名在场,供稳定性门控/回滚读)。
 * 兼容旧制:无候选文件时,把旧 live 文件里 disabled 且非 rejected 的档案当候选迁移(一次)。
 * live 与候选同签名且已启用 → 不重复晋升(幂等)。
 */
export function promoteCandidate({ dataDir = DATA_DIR, reason = 'manual', now = Date.now() } = {}) {
  let cand = readJson(f(dataDir, 'candidate'));
  if (!cand) {
    const legacy = readJson(f(dataDir, 'profile'));
    if (legacy && legacy.enabled !== true && !legacy.rejected) cand = legacy;
  }
  if (!cand || typeof cand !== 'object') return { error: '候选档案不存在,先跑 --iterate' };
  const cur = readJson(f(dataDir, 'profile'));
  if (cur && cur.enabled === true && profileSignature(cand) === profileSignature(cur)) {
    return { file: f(dataDir, 'profile'), enabled: true, prevBackedUp: false, unchanged: true };
  }
  if (cur) writeJson(f(dataDir, 'prev'), { ...cur, backedUpAt: now });
  writeJson(f(dataDir, 'profile'), { ...cand, enabled: true, promotedAt: now, promotedBy: String(reason || 'manual') });
  appendJsonl(f(dataDir, 'promotion'), { ts: now, type: 'promote', reason: String(reason || 'manual'), signature: profileSignature(cand), buildAt: cand.builtAt || null });
  return { file: f(dataDir, 'profile'), enabled: true, prevBackedUp: !!cur };
}

/** 手动一键关(live enabled → false,内容保留可再开)。开 = 晋升候选。 */
export function setTierProfileEnabled({ dataDir = DATA_DIR, enabled, reason = 'manual' } = {}) {
  if (enabled) return promoteCandidate({ dataDir, reason });
  const cur = readJson(f(dataDir, 'profile'));
  if (!cur) return { error: 'live 档案不存在,先晋升候选' };
  cur.enabled = false;
  cur.updatedAt = Date.now();
  writeJson(f(dataDir, 'profile'), cur);
  appendJsonl(f(dataDir, 'promotion'), { ts: Date.now(), type: 'disable', reason: String(reason || 'manual'), signature: profileSignature(cur) });
  return { file: f(dataDir, 'profile'), enabled: false };
}

/** 读成本画像(data/routing/cost-profile.json),缺字段回落画像默认值。 */
export function loadCostProfile({ dataDir = DATA_DIR } = {}) {
  return resolveCostProfile(readJson(f(dataDir, 'cost')) || null);
}

/**
 * 用代理账本校准画像(fitFromLedger)并把"拟合值 vs 画像常数"写进档案缓存段(不改判定,只供报告与人工比对)。
 * tierOf 需 modelRoute.tierOfModel —— 只在真要用到时动态取,避免钩子冷启动拖进重模块。
 */
export async function applyCostFit({ dataDir = DATA_DIR, cost = null } = {}) {
  const base = cost || loadCostProfile({ dataDir });
  const rows = readJsonl(f(dataDir, 'usage'));
  if (!rows.length) return { ...base, fitted: null, fitNote: '账本不可读,沿用画像常数' };
  let tierOf = undefined;
  try { ({ tierOfModel: tierOf } = await import('./modelRoute.mjs')); } catch { /* 拟合降级为不分档 */ }
  const fit = fitFromLedger({ rows, tierOf });
  if (!fit.used) return { ...base, fitted: null, fitNote: '账本里没有可用 token 计数,沿用画像常数' };
  const out = {
    ...base,
    // fitted 只在"样本可比且够多"时才给数;否则只留 fitSample 说明为什么不给(不许拿混杂尺寸的数字装复核)
    fitted: fit.comparable && fit.implied ? { ...fit.implied, n: fit.used } : null,
    fitSample: { used: fit.used, droppedBySize: fit.droppedBySize, minContextM: fit.minContextM, comparable: fit.comparable },
    fitGroups: fit.groups.slice(0, 10),
  };
  if (!fit.comparable) {
    const hn = fit.groups.find((g) => g.key === 'R1|hot')?.n ?? 0;
    const cn = fit.groups.find((g) => g.key === 'R1|cold')?.n ?? 0;
    out.fitNote = `R1 热/冷样本不足(${fit.minContextM}M 上下文门槛下热 ${hn} / 冷 ${cn},各需 ≥20)⇒ 沿用人工画像常数,不做伪复核`;
  }
  try { writeJson(f(dataDir, 'cost'), out); } catch { /* 落盘失败不影响本轮 */ }
  return out;
}

const pctv = (v) => (v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%');

/** 报告(量尺 → 现网 → 候选 → 词表候选 → 口径与局限)。 */
export function renderReport({ cost, rows, legacy, cv, mined, learned, profilePath, liveEnabled = null, grow, history }) {
  const bySource = {};
  for (const r of rows) bySource[r.truthSource] = (bySource[r.truthSource] || 0) + 1;
  const agreeN = rows.filter((r) => r.agree === true).length;
  const agreeAll = rows.filter((r) => r.behaviorTruth && r.mapTruth).length;
  const L = [];
  L.push('# 难度档迭代优化报告(tierOptimize)');
  L.push('');
  L.push(`> 生成时间:${new Date().toISOString()}　量尺:${rows.length} 条　候选档案:${profilePath}　live:${liveEnabled === null ? '未运行' : (liveEnabled ? '已启用' : '未启用')}`);
  if (grow) L.push(`> 本轮扩样:${JSON.stringify(grow)}`);
  L.push('');
  L.push('## 0. 成本画像(单位 M = 100 万 R1 等效 token / 每请求)');
  L.push('');
  L.push('| 档 | 倍率 | 热轮 | 冷轮(含切换税) |');
  L.push('|---|---|---|---|');
  for (const t of TIERS) L.push(`| ${t} | ×${cost.tierMultiplier[t]} | ${(cost.implicit.hotM * cost.tierMultiplier[t]).toFixed(2)} | ${(cost.implicit.coldM * cost.tierMultiplier[t]).toFixed(2)} |`);
  L.push('');
  L.push(`漏升返工:${cost.underTier.failTurns} 轮空转 + 升档冷读 + 每档差质量损失 ${cost.qualityPenaltyPerStepM}M(质量定价是**人工旋钮**,非实测)。`);
  if (cost.fitted) L.push(`账本拟合(每 M 上下文,R1 热/冷/税):${JSON.stringify(cost.fitted)}　对照画像常数:热 ${DEFAULT_COST_PROFILE.implicit.hotM} / 冷 ${DEFAULT_COST_PROFILE.implicit.coldM}。`);
  else if (cost.fitSample) L.push(`账本拟合**未做**:${cost.fitNote || `可用样本 ${cost.fitSample.used} 条(尺寸门槛剔除 ${cost.fitSample.droppedBySize}),不足以与画像锚点比,沿用人工常数`}。`);
  L.push('');
  L.push('## 1. 量尺(双真值口径)');
  L.push('');
  L.push('| 真值来源 | 条数 |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(bySource)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push(`行为侧与 T→R 映射的一致率:${agreeAll ? pctv(agreeN / agreeAll) : '—'}(${agreeN}/${agreeAll})——一致率就是"量尺软硬"的读数,低说明映射口径在漂。`);
  L.push('');
  L.push('## 2. 现网分类器(无档案)');
  L.push('');
  L.push(`准确率 ${pctv(legacy.accuracy)}　命中/误升/漏升 ${legacy.hit}/${legacy.over}/${legacy.under}　总代价 ${legacy.total}M(纯 token 口径 ${legacy.tokenOnlyTotal}M)　基准:恒 R1 ${legacy.baselines.alwaysR1}M / 理想 ${legacy.baselines.oracle}M`);
  L.push('');
  L.push('| 真值档 | n | 召回 | 精确 |');
  L.push('|---|---|---|---|');
  for (const [t, v] of Object.entries(legacy.perTier)) L.push(`| ${t} | ${v.actual} | ${pctv(v.recall)} | ${pctv(v.precision)} |`);
  L.push('');
  L.push('## 3. 候选档案(交叉验证折外)');
  L.push('');
  if (!cv.best) L.push('无有效折外结果(样本或折数不足)。');
  else {
    L.push(`**结论:${cv.accepted ? '✅ 通过门控,候选已落盘(disabled,不覆盖 live)' : '❌ 未通过门控,不落任何档案(候选/live 均原样保留)'}**`);
    L.push('');
    L.push(`| 指标 | 现网(折内同切分) | 候选(折外) |`);
    L.push(`|---|---|---|`);
    L.push(`| 总代价 M | ${cv.legacy.total} | ${cv.best.total} |`);
    L.push(`| 纯 token 代价 M | ${cv.legacy.tokenCost} | ${r3(cv.best.tokenCost)} |`);
    L.push(`| 准确率 | ${pctv(cv.legacy.accuracy)} | ${pctv(cv.best.accuracy)} |`);
    L.push(`| 误升 / 漏升 | ${cv.legacy.over}/${cv.legacy.under} | ${cv.best.over}/${cv.best.under} |`);
    L.push(`| 换档次数 | ${cv.legacy.switches} | ${cv.best.switches} |`);
    L.push('');
    L.push(`门槛:${JSON.stringify(cv.best.thresholds)}　折:${cv.folds}(各折条数 ${cv.perBucket.join(',')})　逐折代价 ${cv.best.perFold.map((x) => `f${x.fold}:${x.total}`).join(' ')}`);
    L.push('');
    for (const s of cv.reasons) L.push(`- ${s}`);
    L.push('');
    L.push('### 被降权的信号(样本内该信号正例率低于其方向基准)');
    L.push('');
    L.push('| 池 | 词 | n | 正例率 | 倍率 |');
    L.push('|---|---|---|---|---|');
    const flat = [];
    for (const [pool, tbl] of Object.entries(learned.signals)) for (const [w, e] of Object.entries(tbl)) if (e.multiplier < 0.999) flat.push({ pool, w, ...e });
    flat.sort((a, b) => a.multiplier - b.multiplier);
    for (const x of flat.slice(0, 25)) L.push(`| ${x.pool} | ${x.w} | ${x.n} | ${pctv(x.rate)} | ${x.multiplier} |`);
    if (!flat.length) L.push('| — | 无可降权信号(全池正例率≥基准或支持不足) | — | — | — |');
    L.push('');
    L.push(`基准正例率 ${pctv(learned.baseRate)};支持数 < minN(${learned.minN})的 ${learned.skippedTerms} 个词一律不动(倍率恒 1)。`);
    L.push('');
    L.push('### 全部网格组合(按折外代价排序,前 4;证明不是"挑最好的那次"——同一切分下全摆出来)');
    L.push('');
    for (const run of cv.runs) L.push(`- ${JSON.stringify(run.thresholds)} → 折外代价 ${run.total}M / 准确率 ${pctv(run.accuracy)}`);
  }
  L.push('');
  L.push('## 4. 词表候选(只列不入库,需人工确认)');
  L.push('');
  L.push('| 候选词 | 支持 | 正例 | 加入后总代价 ΔM | 准确率 Δ |');
  L.push('|---|---|---|---|---|');
  for (const s of mined.simulation) L.push(`| ${s.term} | ${s.n} | ${s.pos} | ${s.deltaTotal >= 0 ? '+' : ''}${s.deltaTotal} | ${s.deltaAcc >= 0 ? '+' : ''}${s.deltaAcc} |`);
  if (!mined.simulation.length) L.push('| — | — | — | 无满足支持/纯度的候选 | — |');
  L.push('');
  L.push('> Δ 是**样本内模拟**(词就是从这批行挖出来的),必然乐观;只有与现网差距明显才值得人工加词。');
  L.push('');
  L.push('## 5. 迭代趋势');
  L.push('');
  L.push('| 时间 | 量尺 | 现网(折内) | 现网准确率 | 候选(折外) | 折外改善 | 接受 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const h of (history || []).slice(-10)) {
    const fl = h.foldLegacyTotal ?? h.legacyTotal ?? '—';
    const imp = h.foldImprovement != null ? `${(h.foldImprovement * 100).toFixed(1)}%` : '—';
    L.push(`| ${h.at ? new Date(h.at).toISOString().slice(0, 16) : '—'} | ${h.rows ?? '—'} | ${fl} | ${pctv(h.foldLegacyAccuracy ?? h.legacyAccuracy)} | ${h.candidateTotal ?? '—'} | ${imp} | ${h.accepted ? '是' : '否'} |`);
  }
  L.push('');
  L.push('> 折内/折外同切分可比;"现网全序列代价"(含跨折状态延续,更贴近实弹)在第 2 节单独列。');
  L.push('');
  L.push('## 6. 口径与局限(不掩饰)');
  L.push('');
  L.push('- 真值仍是**代理指标**:行为侧把"写得多"当"需要强模型",重实现 ≠ 慎重修改;T→R 映射是设计口径。两者一致率是本量尺的天花板。');
  L.push('- 词表永不自动改,自动的只有逐信号倍数与四个门槛(critMin/editMin/verifyMin/verifyOverride);档案 enabled 默认 false,不改现网。');
  L.push('- 现网 R4 词法入口与 P2 上梯不在黄金集里评(黄金集无 R3/R4 行为真值),R4 误升只能看 routing-shadow。');
  L.push('- 质量惩罚是人工定价旋钮:调到 0 时"恒 R1"就是最优解(纯 token 口径的事实),要谈升档价值必须先给它定价。');
  L.push('');
  return L.join('\n');
}

/** 一轮迭代(可被钩子节流调用)。全程 fail-open,返回摘要。 */
export async function runIteration({
  dataDir = DATA_DIR, grow = true, fit = false, now = Date.now(),
  folds = DEFAULTS.folds, minN = DEFAULTS.minN, priorN = DEFAULTS.priorN,
  allowBoost = DEFAULTS.allowBoost, truth = DEFAULTS.truth, qualityPenalty = null,
  dry = false, enable = false, spawnGrow = null,
} = {}) {
  let growResult = null;
  if (grow) {
    try {
      const { maybeGrowPool } = spawnGrow || await import('./autoExemplars.mjs');
      growResult = await (spawnGrow ? spawnGrow() : maybeGrowPool({ dataDir, now }));
    } catch (e) { growResult = { state: 'failed', reason: String(e && e.message ? e.message : e) }; }
  }
  let cost = loadCostProfile({ dataDir });
  if (fit) cost = await applyCostFit({ dataDir, cost });
  // 拟合元数据不进判定(resolveCostProfile 白名单会丢掉它们),单独带进报告——
  // 否则"上一轮拟过像但样本不足"这件事在报告里会凭空消失,读报告的人以为从没复核过。
  const rawCost = readJson(f(dataDir, 'cost')) || {};
  cost = { ...cost, fitted: cost.fitted ?? rawCost.fitted ?? null, fitSample: cost.fitSample || rawCost.fitSample || null, fitNote: cost.fitNote || rawCost.fitNote || null };
  if (qualityPenalty !== null) cost.qualityPenaltyPerStepM = Number(qualityPenalty);
  const rows = loadEvalRows({ dataDir, truth });
  if (!rows.length) return { state: 'skipped', reason: `黄金集无可评估行(truth=${truth})` };
  const legacy = evaluate({ rows, calibration: null, cost });
  const learned = learnSignals({ rows, minN, priorN, allowBoost });
  const cv = crossValidate({ rows, cost, folds, minN, priorN, allowBoost });
  const mined = mineTerms({ rows, cost });
  const history = readJsonl(f(dataDir, 'history'));
  const summary = {
    at: now, rows: rows.length, truth,
    // costTotal/legacyTotal = 现网分类器在"全序列"上的代价(实弹口径,含跨折延续的状态)
    // foldLegacy/foldCandidate = 同一折切分下的现网 vs 候选(门控只认这一对,口径逐字一致)
    costTotal: legacy.total, legacyTotal: legacy.total, legacyAccuracy: legacy.accuracy,
    foldLegacyTotal: cv.legacy ? cv.legacy.total : null, foldLegacyAccuracy: cv.legacy ? cv.legacy.accuracy : null,
    candidateTotal: cv.best ? cv.best.total : null,
    candidateAccuracy: cv.best ? cv.best.accuracy : null,
    foldImprovement: cv.legacy && cv.best && cv.legacy.total > 0
      ? Number(((cv.legacy.total - cv.best.total) / cv.legacy.total).toFixed(4)) : null,
    accepted: !!cv.accepted,
    candidateWritten: !!(cv.accepted && cv.best && !dry),
    over: legacy.over, under: legacy.under, grow: growResult && growResult.state,
  };
  if (cv.accepted && cv.best && !dry) {
    writeTierCandidate({
      dataDir,
      profile: {
        version: 1, builtAt: new Date(now).toISOString(), source: `tierOptimize ${new Date(now).toISOString()}`,
        truthChannel: truth, params: { folds, minN, priorN, allowBoost },
        cost: { cacheMode: cost.cacheMode, tierMultiplier: cost.tierMultiplier, implicit: cost.implicit, qualityPenaltyPerStepM: cost.qualityPenaltyPerStepM },
        thresholds: cv.best.thresholds, signals: learned.signals,
        cv: { legacy: { total: cv.legacy.total, accuracy: cv.legacy.accuracy, over: cv.legacy.over, under: cv.legacy.under }, candidate: { total: cv.best.total, accuracy: cv.best.accuracy, over: cv.best.over, under: cv.best.under, perFold: cv.best.perFold } },
      },
    });
    if (enable === true) promoteCandidate({ dataDir, reason: 'manual --enable', now });
  }
  // 未过门控:**不落任何档案文件**。候选与 live 原样保留——旧实现把 rejected 档案覆写进 live,
  // 一次噪声迭代就能静默关掉已启用的校准(自进化先修的自伤 bug)。
  if (!dry) {
    try {
      fs.mkdirSync(path.dirname(f(dataDir, 'report')), { recursive: true });
      fs.writeFileSync(f(dataDir, 'report'), renderReport({ cost, rows, legacy, cv, mined, learned, profilePath: f(dataDir, 'candidate'), liveEnabled: readJson(f(dataDir, 'profile'))?.enabled === true, grow: growResult, history: history.concat([summary]) }));
      fs.appendFileSync(f(dataDir, 'history'), JSON.stringify(summary) + '\n');
      writeJson(f(dataDir, 'state'), { at: now, rows: rows.length, accepted: !!cv.accepted });
    } catch (e) { return { state: 'grown_report_failed', reason: String(e && e.message ? e.message : e), summary }; }
  }
  return { state: 'done', summary, legacy, cv, mined, learned, cost, rows: rows.length, grow: growResult };
}

/** 钩子节流入口:配置 modelRouting.tierOptimize.enabled 为真才跑,默认 6h 一次,失败静默。
 *  2026-11-04 自进化闭环:迭代之后接晋升门控 + 回滚观察,全部 fail-open。
 *  live 文件的 enabled 只由晋升/关停/回滚改变,迭代本身绝不改写(旧 bug:每轮把 enabled 写回 false)。 */
export async function maybeOptimizeTier({ dataDir = DATA_DIR, minIntervalMs = 6 * 60 * 60 * 1000, now = Date.now() } = {}) {
  try {
    const cfg = readJson(path.join(dataDir, 'code-index.config.json')) || {};
    const opt = cfg?.modelRouting?.tierOptimize || {};
    if (opt.enabled !== true) return { state: 'skipped', reason: 'modelRouting.tierOptimize.enabled 未打开' };
    const st = readJson(f(dataDir, 'state')) || {};
    if (st.at && now - Number(st.at) < num(opt.minIntervalMs, minIntervalMs)) return { state: 'skipped', reason: '距上次不足间隔' };
    const r = await runIteration({ dataDir, now, grow: opt.grow !== false, fit: opt.fitCost === true, folds: num(opt.folds, DEFAULTS.folds), minN: num(opt.minN, DEFAULTS.minN), allowBoost: opt.allowBoost === true, dry: opt.dry === true });
    const promote = await maybePromoteTier({ dataDir, lastRun: r, opt, now });
    const rollback = await maybeRollbackTier({ dataDir, opt, now });
    return { ...r, promote, rollback };
  } catch (e) { return { state: 'failed', reason: String(e && e.message ? e.message : e) }; }
}

/**
 * 晋升门控(自进化闭环,2026-11-04):连续 N 轮折外过门控、相邻接受轮间隔 ≥ 半节流窗
 * (同批重复跑不算时间稳定性)、候选逐折无回归(允许 1‰ 浮点噪声)、签名不等于现网 live、
 * 签名不在回滚冷却期 ⇒ 自动晋升候选到 live。
 * 参数可由 modelRouting.tierOptimize.promote 覆盖:enabled/consecutiveRounds/minSpacingMs/perFoldTolerance。
 */
export async function maybePromoteTier({ dataDir = DATA_DIR, lastRun = null, opt = {}, now = Date.now() } = {}) {
  try {
    const p = opt && opt.promote && typeof opt.promote === 'object' ? opt.promote : {};
    if (p.enabled === false) return { state: 'skipped', reason: 'promote.enabled=false' };
    const cv = lastRun && lastRun.cv ? lastRun.cv : null;
    if (!cv || cv.accepted !== true || !cv.best) return { state: 'skipped', reason: '本轮未过 CV 门控' };
    const consecutive = Math.max(1, num(p.consecutiveRounds, 2));
    const throt = num(opt.minIntervalMs, 6 * 60 * 60 * 1000);
    const minSpacingMs = num(p.minSpacingMs, throt / 2);
    const accepts = readJsonl(f(dataDir, 'history')).filter((h) => h.accepted === true);
    const lastN = accepts.slice(-consecutive);
    if (lastN.length < consecutive) return { state: 'skipped', reason: `接受轮次不足 ${consecutive}(仅 ${lastN.length},样本会变,别把一次高分当规律)` };
    for (let i = 1; i < lastN.length; i += 1) {
      if ((lastN[i].at || 0) - (lastN[i - 1].at || 0) < minSpacingMs) {
        return { state: 'skipped', reason: '相邻接受轮间隔不足,同批重跑不算时间稳定性' };
      }
    }
    const tol = 1.001 + (Number.isFinite(Number(p.perFoldTolerance)) ? Number(p.perFoldTolerance) : 0);
    for (const fl of cv.best.perFold || []) {
      const same = (cv.legacy?.perFold || []).find((x) => x.fold === fl.fold);
      if (same && fl.total > same.total * tol) return { state: 'skipped', reason: `折 ${fl.fold} 候选 ${fl.total} > 现网 ${same.total}(逐折无回归)` };
    }
    const cand = readJson(f(dataDir, 'candidate'));
    if (!cand) return { state: 'skipped', reason: '候选档案缺失' };
    const sig = profileSignature(cand);
    const ledger = readJsonl(f(dataDir, 'promotion'));
    const rb = [...ledger].reverse().find((e) => e.type === 'rollback');
    if (rb && rb.signature === sig && rb.cooldownUntil && now < Number(rb.cooldownUntil)) {
      return { state: 'skipped', reason: `该签名在回滚冷却期(至 ${new Date(Number(rb.cooldownUntil)).toISOString()})` };
    }
    const live = readJson(f(dataDir, 'profile'));
    if (live && live.enabled === true && profileSignature(live) === sig) {
      return { state: 'skipped', reason: '候选与正在运行的 live 同签名,不重复晋升' };
    }
    const r = promoteCandidate({ dataDir, reason: 'auto-promote', now });
    if (r.error) return { state: 'skipped', reason: r.error };
    return { state: 'promoted', file: r.file, signature: sig };
  } catch (e) { return { state: 'failed', reason: String(e && e.message ? e.message : e) }; }
}

/** 账本行 → 每请求归一成本(M R1 等效,按上下文规模归一防尺寸混杂):等价输入价 × 档位倍率。 */
function normalizedRowCost(r, profile, tierOf) {
  const inTok = Number(r.inTok); const cr = Number(r.cacheRead); const cw = Number(r.cacheWrite);
  if (![inTok, cr, cw].every(Number.isFinite)) return null;
  const contextM = (inTok + cr + cw) / 1e6;
  if (!(contextM > 0.02)) return null;
  const base = (inTok + cr * profile.implicit.hitDiscount + cw * profile.explicit.createDiscount) / contextM;
  let tier = TIERS.includes(r.tier) ? r.tier : null;
  if (!tier && tierOf) tier = tierOf(r.served || r.requested || '') || null;
  const mult = tier ? (profile.tierMultiplier[tier] ?? 1) : 1;
  return base * mult;
}

/**
 * 晋升后观察回滚(自进化安全网,2026-11-04):晋升满观察窗(默认 24h)后,取晋升前后两个等长窗口的
 * 每请求归一成本中位数;后窗涨超阈值(默认 15%)才回滚。样本不足不回滚(不拿噪声当恶化)。
 * 回滚 = 恢复 prev 备份(无备份则关 live),台账带 cooldownUntil(该签名冷却期内不再自动晋升)。fail-open。
 */
export async function maybeRollbackTier({ dataDir = DATA_DIR, opt = {}, now = Date.now() } = {}) {
  try {
    const p = opt && opt.promote && typeof opt.promote === 'object' ? opt.promote : {};
    const ledger = readJsonl(f(dataDir, 'promotion'));
    const lastPromote = [...ledger].reverse().find((e) => e.type === 'promote');
    if (!lastPromote) return { state: 'skipped', reason: '无晋升记录' };
    if (ledger.length && ledger[ledger.length - 1].type === 'rollback') return { state: 'skipped', reason: '最近已是回滚,无活动晋升' };
    if (ledger.length && ledger[ledger.length - 1].type === 'disable') return { state: 'skipped', reason: 'live 已手动关闭,不观察' };
    const wentLiveAt = Number(lastPromote.ts);
    if (!Number.isFinite(wentLiveAt) || now - wentLiveAt < num(p.minObserveMs, 24 * 60 * 60 * 1000)) {
      return { state: 'skipped', reason: '观察窗未满' };
    }
    const win = num(p.observeWindowMs, 24 * 60 * 60 * 1000);
    const rows = readJsonl(f(dataDir, 'usage'));
    if (!rows.length) return { state: 'skipped', reason: '账本不可读' };
    let tierOf = null;
    try { ({ tierOfModel: tierOf } = await import('./modelRoute.mjs')); } catch { /* 无 tierOf 时只认账本 tier 字段 */ }
    const cp = loadCostProfile({ dataDir });
    const cost = (row) => normalizedRowCost(row, cp, tierOf);
    const pre = rows.filter((r) => r.ts >= wentLiveAt - win && r.ts < wentLiveAt).map(cost).filter((v) => v !== null);
    const post = rows.filter((r) => r.ts >= wentLiveAt && r.ts <= now).map(cost).filter((v) => v !== null);
    const minRows = Math.max(1, num(p.minRows, 20));
    if (pre.length < minRows || post.length < minRows) return { state: 'skipped', reason: `样本不足(前 ${pre.length}/后 ${post.length},各需 ${minRows}),不拿噪声当恶化` };
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
    const beforeM = med(pre); const afterM = med(post);
    const thr = Number.isFinite(Number(p.rollbackThreshold)) ? Number(p.rollbackThreshold) : 0.15;
    if (!(afterM > beforeM * (1 + thr))) {
      return { state: 'skipped', reason: `成本中位 ${beforeM.toFixed(3)}→${afterM.toFixed(3)}M,未超 ${(thr * 100).toFixed(0)}%` };
    }
    const cur = readJson(f(dataDir, 'profile'));
    const prev = readJson(f(dataDir, 'prev'));
    if (prev) writeJson(f(dataDir, 'profile'), { ...prev, rolledBackAt: now });
    else if (cur) { cur.enabled = false; cur.rolledBackAt = now; writeJson(f(dataDir, 'profile'), cur); }
    const cooldownUntil = now + num(p.rollbackCooldownMs, 7 * 24 * 60 * 60 * 1000);
    appendJsonl(f(dataDir, 'promotion'), { ts: now, type: 'rollback', signature: cur ? profileSignature(cur) : null, beforeMedian: r3(beforeM), afterMedian: r3(afterM), cooldownUntil });
    return { state: 'rolled-back', before: r3(beforeM), after: r3(afterM), restoredPrev: !!prev };
  } catch (e) { return { state: 'failed', reason: String(e && e.message ? e.message : e) }; }
}

/** 手动回滚(自动观察回滚之外的人工兜底):立即恢复 prev 备份,无备份则关 live。 */
export function rollbackNow({ dataDir = DATA_DIR, reason = 'manual', now = Date.now() } = {}) {
  const ledger = readJsonl(f(dataDir, 'promotion'));
  const lastPromote = [...ledger].reverse().find((e) => e.type === 'promote');
  if (!lastPromote) return { error: '无晋升记录,无可回滚' };
  const cur = readJson(f(dataDir, 'profile'));
  const prev = readJson(f(dataDir, 'prev'));
  if (prev) writeJson(f(dataDir, 'profile'), { ...prev, rolledBackAt: now });
  else if (cur) { cur.enabled = false; cur.rolledBackAt = now; writeJson(f(dataDir, 'profile'), cur); }
  appendJsonl(f(dataDir, 'promotion'), { ts: now, type: 'rollback', reason: String(reason || 'manual'), signature: cur ? profileSignature(cur) : null });
  return { state: 'rolled-back', restoredPrev: !!prev };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const dataDir = opt('--data', DATA_DIR);
  const has = (n) => argv.includes(n);
  try {
    const wantsEnable = has('--enable') || has('--disable');
    if (has('--rollback-now')) {
      console.log(JSON.stringify(rollbackNow({ dataDir }), null, 1));
    } else if (wantsEnable && !has('--iterate')) {
      if (has('--enable')) console.log(JSON.stringify(promoteCandidate({ dataDir, reason: 'manual --enable' }), null, 1));
      else console.log(JSON.stringify(setTierProfileEnabled({ dataDir, enabled: false, reason: 'manual --disable' }), null, 1));
    } else if (has('--profile')) {
      console.log(JSON.stringify({ live: readJson(f(dataDir, 'profile')), candidate: readJson(f(dataDir, 'candidate')), prev: readJson(f(dataDir, 'prev')), promotion: readJsonl(f(dataDir, 'promotion')).slice(-20) }, null, 1));
    } else if (has('--history')) {
      for (const h of readJsonl(f(dataDir, 'history'))) console.log(JSON.stringify(h));
    } else if (has('--report')) {
      console.log(fs.readFileSync(f(dataDir, 'report'), 'utf8'));
    } else if (has('--mine')) {
      const rows = loadEvalRows({ dataDir, truth: opt('--truth', DEFAULTS.truth) });
      console.log(JSON.stringify(mineTerms({ rows, minSupport: Number(opt('--min-support', 5)), cost: loadCostProfile({ dataDir }) }), null, 1));
    } else if (has('--eval')) {
      let cost = loadCostProfile({ dataDir });
      if (has('--fit-cost')) cost = await applyCostFit({ dataDir, cost });
      if (has('--quality-penalty')) cost.qualityPenaltyPerStepM = Number(opt('--quality-penalty', 1));
      const rows = loadEvalRows({ dataDir, truth: opt('--truth', DEFAULTS.truth) });
      const calibration = loadTierCalibration(f(dataDir, 'profile'));
      console.log(JSON.stringify({
        rows: rows.length, truth: opt('--truth', DEFAULTS.truth), profileEnabled: !!calibration,
        cost: { tierMultiplier: cost.tierMultiplier, implicit: cost.implicit, qualityPenaltyPerStepM: cost.qualityPenaltyPerStepM },
        legacy: evaluate({ rows, cost }), withProfile: calibration ? evaluate({ rows, calibration, cost }) : null,
      }, null, 1));
    } else {
      const r = await runIteration({
        dataDir, grow: !has('--no-grow'), fit: has('--fit-cost'), dry: has('--dry'),
        folds: Number(opt('--folds', DEFAULTS.folds)), minN: Number(opt('--min-n', DEFAULTS.minN)),
        priorN: Number(opt('--prior-n', DEFAULTS.priorN)), allowBoost: has('--allow-boost'),
        enable: has('--enable'), truth: opt('--truth', DEFAULTS.truth),
        qualityPenalty: has('--quality-penalty') ? Number(opt('--quality-penalty', 1)) : null,
      });
      const { rows, legacy, cv, mined, summary, ...rest } = r;
      console.log(JSON.stringify({ summary, legacy: legacy && { total: legacy.total, accuracy: legacy.accuracy, over: legacy.over, under: legacy.under, perTier: legacy.perTier }, cv: cv && { accepted: cv.accepted, reasons: cv.reasons, best: cv.best && { thresholds: cv.best.thresholds, total: cv.best.total, accuracy: cv.best.accuracy, perTier: cv.best.perTier }, runs: cv.runs }, mined: mined && { candidates: mined.candidates.slice(0, 10), simulation: mined.simulation }, rest }, null, 1));
    }
  } catch (e) { console.error(`[err] ${e && e.message ? e.message : e}`); process.exit(1); }
}
