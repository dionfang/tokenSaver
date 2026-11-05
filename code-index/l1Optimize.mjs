#!/usr/bin/env node
/**
 * L1 词级倍率迭代优化器(2026-11-04,与 tierOptimize.mjs 同构的一轮可重复循环:评估→拟合→折外门控→报告)。
 * 目标:T1-T8 类型判定质量(accuracy + macro-F1);真值=黄金集 autoLabel/humanLabel(四票代签的弱真值,
 * 报告必须明示口径,不得当真值宣传)。
 *
 * 铁律(与 #14 治理一致,代码层强制):
 *   1. **词表永不自动改**:只学"已有词表里每个词的激活倍率";候选新词只进报告"待人工确认"清单(--mine)。
 *   2. **档案默认 enabled:false**;消费端 classify.loadL1Weights 只认真开;启用 = 人的决定。
 *   3. **折外门控接受**:候选倍率在 k 折交叉验证的折外样本上 accuracy 与 macro-F1 均不劣于现网(纯词表),
 *      且任一类召回下降 ≤ maxDrop,才落档案;否则只写报告。样本 < minRows 直接 abort(不把噪声学成规律)。
 *   4. 倍率只影响"类别是否激活"(Σ权重≥threshold),不改命中数→置信度换算;classifyPromptRaw 永为无权重基线。
 *   5. 全程 fail-open;不碰黄金集内容;档案未 enable 前线上纯词表工作,零行为变化。
 *
 * 用法:
 *   node l1Optimize.mjs --eval [--truth autoLabel|humanLabel]
 *   node l1Optimize.mjs --iterate [--folds 5] [--min-n 4] [--rounds 3] [--min-gain 0.02] [--max-drop 0.05] [--dry]
 *   node l1Optimize.mjs --mine [--min-freq 5] [--top 40]
 *   node l1Optimize.mjs --enable | --disable | --report | --history
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { classifyRules, L1_LEXICON, META_MARKERS, stripCitations, hitsOf } from './classify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = {
  golden: 'routing/golden-set.jsonl',
  weights: 'routing/l1-weights.json',
  report: 'routing/l1-optimize-report.md',
  history: 'routing/l1-optimize-history.jsonl',
  log: 'usage/routing-log.jsonl',
};
const DEFAULTS = {
  folds: 5, minN: 4, rounds: 3, minGain: 0.02, maxDrop: 0.05, minRows: 40,
  wMin: 0.2, wMax: 1.5, priorCorrect: 2, priorTotal: 4, truth: 'autoLabel',
};
/** 词表数组 → 该数组证据支持的类型(T4 由 scope/refactor 双条件构成,两数组都映射 T4)。 */
export const ARRAY_TYPE = {
  scope: 'T4', refactor: 'T4', edit: 'T3', error: 'T2',
  review: 'T6', plan: 'T5', test: 'T7', chore: 'T8', question: 'T1',
};
const TYPES = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const f = (dataDir, k) => path.join(dataDir, FILES[k]);
function readJsonl(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1) + '\n'); }

/** 稳定折划分:同一条目跨迭代恒定在同折(趋势可比),与 tierOptimize.foldOf 同算法。 */
export function foldOf(key, k = DEFAULTS.folds) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 131 + s.charCodeAt(i)) >>> 0;
  return h % Math.max(2, k);
}

/** 黄金集 → 评估行。truth 取 autoLabel(可换 humanLabel);非 T1-T8 标签/空 prompt 跳过。 */
export function loadEvalRows({ dataDir = DATA_DIR, goldenFile = null, truth = DEFAULTS.truth, truthFile = null } = {}) {
  const override = new Map();
  if (truthFile) {
    for (const r of readJsonl(truthFile)) {
      const key = r.id != null ? String(r.id) : (r.n != null ? String(r.n) : null);
      if (key != null) override.set(key, String(r.label || ''));
    }
  }
  const rows = readJsonl(goldenFile || f(dataDir, 'golden'));
  const out = [];
  for (const r of rows) {
    const ov = override.get(String(r.id));
    if (ov === 'skip') continue; // 人工评审明确跳过:不参训也不参评(不落回行为标签)
    const label = ov ? ov : (r[truth] || r.autoLabel);
    if (!label || !TYPES.includes(label)) continue; // 意图语料里 'meta'/'null' 等不参训(元提问不评 L1)
    const prompt = String(r.prompt || '').trim();
    if (prompt.length < 6) continue;
    out.push({ pkey: r.id || r.pkey || `k${out.length}`, prompt, truth: label, source: ov ? 'intent-human' : (r.humanLabel ? 'human+auto' : 'auto') });
  }
  return out;
}

/** 权重包 → classifyRules 的 weights 形态;空权重等价于无档案(null)。 */
export function toWeights(w) {
  if (!w) return null;
  const has = Object.values(w).some((m) => m && Object.keys(m).length);
  return has ? { threshold: 1, weights: w } : null;
}

export function predictType(prompt, weights) {
  return classifyRules(prompt, { weights: toWeights(weights) })?.type ?? null;
}

/** 评估:accuracy / macro-F1 / 按类 recall / 混淆(格式 "真值>预测",含 >null=漏判)。 */
export function metrics(rows, weights) {
  const per = {};
  for (const t of TYPES) per[t] = { tp: 0, fn: 0, fp: 0 };
  const confusion = {};
  let correct = 0;
  for (const row of rows) {
    const pred = predictType(row.prompt, weights);
    if (pred === row.truth) correct += 1;
    const a = per[row.truth];
    a[pred === row.truth ? 'tp' : 'fn'] += 1;
    if (pred && pred !== row.truth) per[pred].fp += 1;
    const key = `${row.truth}>${pred ?? 'null'}`;
    confusion[key] = (confusion[key] || 0) + 1;
  }
  const present = new Set(rows.map((r) => r.truth));
  const f1s = TYPES.filter((t) => present.has(t)).map((t) => {
    const { tp, fp, fn } = per[t];
    const p = tp + fp ? tp / (tp + fp) : 0;
    const r = tp + fn ? tp / (tp + fn) : 0;
    return p + r ? (2 * p * r) / (p + r) : 0;
  });
  return {
    n: rows.length,
    accuracy: rows.length ? r2(correct / rows.length) : 0,
    macroF1: f1s.length ? r2(f1s.reduce((s, v) => s + v, 0) / f1s.length) : 0,
    perType: Object.fromEntries(TYPES.map((t) => [t, {
      recall: per[t].tp + per[t].fn ? r2(per[t].tp / (per[t].tp + per[t].fn)) : null,
    }])),
    confusion,
  };
}

/** 词级统计(拟合输入):词在样本内触发次数 n 与"该样本真值=词表数组映射类型"的次数。
 *  注意是关联口径(不模拟整棵决策树),只用于产生候选倍率,最终接受与否由折外 accuracy 决定。 */
export function wordStats(rows, lexicon = L1_LEXICON) {
  const out = {};
  for (const arr of Object.keys(ARRAY_TYPE)) out[arr] = {};
  for (const row of rows) {
    const low = stripCitations(row.prompt).toLowerCase();
    for (const arr of Object.keys(ARRAY_TYPE)) {
      for (const w of hitsOf(low, lexicon[arr] || [])) {
        const s = out[arr][w] || (out[arr][w] = { n: 0, correct: 0 });
        s.n += 1;
        if (row.truth === ARRAY_TYPE[arr]) s.correct += 1;
      }
    }
  }
  return out;
}

/** 贪心拟合(训练折内):逐词试候选倍率 weight=clip(2×平滑精确率),只在训练 accuracy 严格变好时接受。
 *  严格改进 ⇒ 单调不劣;确定性顺序(数组固定序+词表原序)⇒ 结果可复现。 */
export function fitWeights(trainRows, opts = {}) {
  const { minN = DEFAULTS.minN, rounds = DEFAULTS.rounds, wMin = DEFAULTS.wMin, wMax = DEFAULTS.wMax, priorCorrect = DEFAULTS.priorCorrect, priorTotal = DEFAULTS.priorTotal, lexicon = L1_LEXICON } = opts;
  const stats = wordStats(trainRows, lexicon);
  const weights = {};
  let cur = metrics(trainRows, null).accuracy;
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (const arr of Object.keys(ARRAY_TYPE)) {
      for (const word of lexicon[arr] || []) {
        const st = stats[arr][word];
        if (!st || st.n < minN) continue;
        const p = (st.correct + priorCorrect) / (st.n + priorTotal);
        const cand = r2(clamp(2 * p, wMin, wMax));
        const prev = weights[arr]?.[word] ?? 1;
        if (cand === prev) continue;
        const trial = { ...weights, [arr]: { ...(weights[arr] || {}), [word]: cand } };
        const acc = metrics(trainRows, trial).accuracy;
        if (acc > cur + 1e-9) { weights[arr] = trial[arr]; cur = acc; moved = true; }
      }
    }
    if (!moved) break;
  }
  return { weights, trainAcc: cur, baseAcc: metrics(trainRows, null).accuracy };
}

/** 折外门控比较:候选折外指标须 accuracy 与 macro-F1 均不劣,且任一类召回降幅 ≤ maxDrop。 */
export function acceptProfile(cand, base, { minGain = DEFAULTS.minGain, maxDrop = DEFAULTS.maxDrop } = {}) {
  const problems = [];
  if (cand.accuracy < base.accuracy + minGain) problems.push(`折外 accuracy ${cand.accuracy} < 基线 ${base.accuracy}+${minGain}`);
  if (cand.macroF1 < base.macroF1) problems.push(`折外 macroF1 ${cand.macroF1} < 基线 ${base.macroF1}`);
  for (const t of TYPES) {
    const cb = cand.perType[t]?.recall;
    const bb = base.perType[t]?.recall;
    if (cb == null || bb == null) continue;
    if (bb - cb > maxDrop) problems.push(`T 类 ${t} 召回降 ${r2(bb - cb)} > ${maxDrop}`);
  }
  return { ok: !problems.length, problems };
}

/** 交叉验证:逐折训练→折外评估,返回折外聚合(候选 vs 基线)。 */
export function crossValidate(rows, opts = {}) {
  const k = opts.folds || DEFAULTS.folds;
  const cand = [];
  const base = [];
  for (let fold = 0; fold < k; fold++) {
    const train = rows.filter((r) => foldOf(r.pkey, k) !== fold);
    const test = rows.filter((r) => foldOf(r.pkey, k) === fold);
    if (!test.length) continue;
    const { weights } = fitWeights(train, opts);
    cand.push(metrics(test, weights));
    base.push(metrics(test, null));
  }
  const agg = (list) => ({
    accuracy: list.length ? r2(list.reduce((s, m) => s + m.accuracy, 0) / list.length) : 0,
    macroF1: list.length ? r2(list.reduce((s, m) => s + m.macroF1, 0) / list.length) : 0,
    perType: Object.fromEntries(TYPES.map((t) => {
      const vals = list.map((m) => m.perType[t]?.recall).filter((v) => v != null);
      return [t, { recall: vals.length ? r2(vals.reduce((s, v) => s + v, 0) / vals.length) : null }];
    })),
  });
  return { base: agg(base), cand: agg(cand), folds: k };
}

// ---------- 候选新词挖掘(--mine):uncertain 日志里的高频词,只进报告不进词表 ----------

const MINE_STOP = new Set(['这个', '那个', '一下', '我们', '可以', '帮我', '为什么', '怎么', '什么', '现在', '还是', '就是', '然后', '已经', '没有', '一个', '你好', '继续', '执行', '场景', '内容', '上下文', '文件', '问题', '功能', '代码', '模型', '配置', '路由', '代理', '钩子', '词表', '分类', '信号', '档位', '拦截', '记账', '向量', '索引', '路由log', 'hbuilderx', 'project', 'tokensaver', 'token', 'zcode', 'qoder', 'cursor', 'mjs', 'json', 'node', 'data', 'config', 'baseurl', 'openai', 'key', 'model', 'auto', 'init', 'hooks', 'read', 'session', 'flash', 'glm', 'max']);

export function mineCandidates({ logFile = f(DATA_DIR, 'log'), lexicon = L1_LEXICON, minFreq = 5, top = 40 } = {}) {
  const meta = (META_MARKERS || []).map((x) => String(x).toLowerCase());
  const rows = readJsonl(logFile).filter((r) => {
    if (r.type) return false;
    const head = String(r.promptHead || '').toLowerCase();
    return !meta.some((m) => m && head.includes(m)); // 讨论路由本身的行不产生候选词
  });
  const freq = new Map();
  const examples = new Map();
  for (const r of rows) {
    // 先剥句末/口语助词再切词,避免"靠谱吗"这类粘连 run(审查发现的挖掘盲区)
    const text = String(r.promptHead || '').replace(/[吗呢吧啊呀哦哈的了呀,。!?!?;；:、'"]+/g, ' ');
    const segs = text.match(/[一-鿿]{2,4}|[a-zA-Z][a-zA-Z0-9_-]{2,}/g) || [];
    for (const s of segs) {
      const w = s.toLowerCase();
      if (MINE_STOP.has(w)) continue;
      if (w.length < 2 || /^(吗|呢|吧|啊|呀|哦|哈)$/.test(w)) continue;
      if (Object.values(lexicon).some((arr) => (arr || []).some((x) => String(x).toLowerCase() === w))) continue; // 已在词表
      freq.set(w, (freq.get(w) || 0) + 1);
      if (!examples.has(w)) examples.set(w, []);
      examples.get(w).push(String(r.promptHead || '').slice(0, 60));
    }
  }
  return [...freq.entries()]
    .filter(([w, c]) => c >= minFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([w, c]) => ({ word: w, count: c, examples: (examples.get(w) || []).slice(0, 2) }));
}

// ---------- 报告/档案/历史 ----------

function writeHistory(dataDir, rec) {
  try {
    const p = f(dataDir, 'history');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: Date.now(), ...rec }) + '\n');
  } catch { /* 历史写失败不影响主流程 */ }
}

function reportText({ rows, truth, cv, verdict, profile, mined }) {
  const L = [];
  L.push('# L1 词级倍率优化报告');
  L.push('');
  L.push(`- 样本:${rows.length} 条(黄金集,truth=${truth})`);
  L.push('- **弱真值警示**:标签来自四票代签(非人工逐条),指标是"与代签一致率",不是人工准确率;');
  L.push('  改进方向可信,绝对数值打折看。');
  L.push(`- 交叉验证:${cv.folds} 折(折外聚合,候选=词级倍率 / 基线=纯词表)`);
  L.push('');
  L.push('| 指标 | 基线(纯词表) | 候选(词级倍率) |');
  L.push('| --- | --- | --- |');
  L.push(`| accuracy | ${cv.base.accuracy} | ${cv.cand.accuracy} |`);
  L.push(`| macro-F1 | ${cv.base.macroF1} | ${cv.cand.macroF1} |`);
  L.push('');
  L.push('按类召回(折外):');
  for (const t of TYPES) {
    const b = cv.base.perType[t]?.recall;
    const c = cv.cand.perType[t]?.recall;
    if (b == null && c == null) continue;
    L.push(`- ${t}: ${b ?? '-'} → ${c ?? '-'}`);
  }
  L.push('');
  L.push(`门控结论:${verdict.ok ? '**通过** → 档案已写出(默认 disabled,须人工 --enable 生效)' : '**未通过**,只出报告不落档案'}`);
  if (verdict.problems?.length) for (const p of verdict.problems) L.push(`- ${p}`);
  if (profile) {
    L.push('');
    L.push('倍率变动(≠1 的词):');
    const movers = [];
    for (const [arr, m] of Object.entries(profile.weights || {})) {
      for (const [w, v] of Object.entries(m || {})) if (Number(v) !== 1) movers.push(`- ${arr}/${w}: ${v}`);
    }
    L.push(movers.length ? movers.join('\n') : '(无)');
  }
  if (mined?.length) {
    L.push('');
    L.push('候选新词(高频 uncertain 日志挖掘;**须人工确认后手动加入词表,永不自动入库**):');
    for (const m of mined) L.push(`- ${m.word} ×${m.count} — ${m.examples.join(' / ')}`);
  }
  L.push('');
  L.push('治理铁律:词表永不自动改;档案 enabled 默认 false;classifyPromptRaw 永为无权重基线(校准统计不被污染)。');
  return L.join('\n') + '\n';
}

function runIterate({ dataDir, opts }) {
  const rows = loadEvalRows({ dataDir, truth: opts.truth, truthFile: opts.truthFile });
  if (rows.length < DEFAULTS.minRows) {
    const msg = `样本不足(${rows.length} < ${DEFAULTS.minRows}),abort——小样本必过折外门控,不把噪声学成规律`;
    console.log(`[abort] ${msg}`);
    return { ok: false, reason: 'small-sample', rows: rows.length };
  }
  const cv = crossValidate(rows, opts);
  const verdict = acceptProfile(cv.cand, cv.base, opts);
  let profile = null;
  if (verdict.ok) {
    const fit = fitWeights(rows, opts); // 全量重拟合(折外只用于门控,档案用全量,与 tierOptimize 同策略)
    profile = {
      enabled: false,
      threshold: 1,
      weights: fit.weights,
      meta: { ts: Date.now(), n: rows.length, folds: cv.folds, truth: opts.truth, trainAcc: fit.trainAcc, heldOutAcc: cv.cand.accuracy, heldOutAccBase: cv.base.accuracy, heldOutF1: cv.cand.macroF1, source: 'l1Optimize' },
    };
    if (!opts.dry) {
      writeJson(f(dataDir, 'weights'), profile);
      writeHistory(dataDir, { action: 'iterate', accepted: true, heldOutAcc: cv.cand.accuracy, base: cv.base.accuracy, n: rows.length });
    }
  } else if (!opts.dry) {
    writeHistory(dataDir, { action: 'iterate', accepted: false, problems: verdict.problems, n: rows.length });
  }
  const mined = mineCandidates({ dataDir });
  const text = reportText({ rows, truth: opts.truth, cv, verdict, profile, mined });
  if (!opts.dry) { fs.mkdirSync(path.dirname(f(dataDir, 'report')), { recursive: true }); fs.writeFileSync(f(dataDir, 'report'), text); }
  console.log(text);
  return { ok: verdict.ok, rows: rows.length };
}

function runEval({ dataDir, opts }) {
  const rows = loadEvalRows({ dataDir, truth: opts.truth, truthFile: opts.truthFile });
  const current = readJson(f(dataDir, 'weights'));
  const enabled = current && current.enabled === true ? { threshold: current.threshold || 1, weights: current.weights } : null;
  const base = metrics(rows, null);
  const actM = enabled ? metrics(rows, enabled.weights) : null;
  console.log(JSON.stringify({ n: rows.length, truth: opts.truth, weightsEnabled: !!enabled, base: { accuracy: base.accuracy, macroF1: base.macroF1 }, withWeights: actM ? { accuracy: actM.accuracy, macroF1: actM.macroF1 } : null }, null, 1));
}

function flipEnabled(dataDir, on) {
  const p = f(dataDir, 'weights');
  const j = readJson(p);
  if (!j || typeof j !== 'object') { console.log('[warn] 无档案,先跑 --iterate'); return; }
  j.enabled = !!on;
  writeJson(p, j);
  writeHistory(dataDir, { action: on ? 'enable' : 'disable' });
  console.log(`[ok] l1-weights enabled=${!!on}(生产 classify 即时生效,mtime 缓存)`);
}

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const hasFlag = (name) => process.argv.includes(name);

async function main() {
  const dataDir = DATA_DIR;
  const opts = {
    folds: Number(arg('--folds', DEFAULTS.folds)), minN: Number(arg('--min-n', DEFAULTS.minN)),
    rounds: Number(arg('--rounds', DEFAULTS.rounds)), minGain: Number(arg('--min-gain', DEFAULTS.minGain)),
    maxDrop: Number(arg('--max-drop', DEFAULTS.maxDrop)), truth: arg('--truth', DEFAULTS.truth),
    truthFile: arg('--truth-file', null), dry: hasFlag('--dry'),
  };
  if (hasFlag('--iterate')) return runIterate({ dataDir, opts });
  if (hasFlag('--eval')) return runEval({ dataDir, opts });
  if (hasFlag('--mine')) {
    const mined = mineCandidates({ dataDir, minFreq: Number(arg('--min-freq', 5)), top: Number(arg('--top', 40)) });
    console.log(JSON.stringify(mined, null, 1));
    return;
  }
  if (hasFlag('--enable')) return flipEnabled(dataDir, true);
  if (hasFlag('--disable')) return flipEnabled(dataDir, false);
  if (hasFlag('--report')) { const t = fs.readFileSync(f(dataDir, 'report'), 'utf8'); console.log(t); return; }
  if (hasFlag('--history')) { for (const l of readJsonl(f(dataDir, 'history')).slice(-20)) console.log(JSON.stringify(l)); return; }
  console.log('用法: node l1Optimize.mjs --eval | --iterate [--dry] | --mine | --enable | --disable | --report | --history');
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) main().catch((e) => { console.error('[err]', e.message); process.exit(1); });