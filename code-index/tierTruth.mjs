/**
 * 档位真值的**行为侧通道**(2026-11-04,给"黄金集 R 真值"补一条独立量尺)。
 *
 * 为什么需要:类型→R 设计映射(TIER_FROM_TYPE)把 multi(重实现,旧 T4/T5)一律当 R2 难度,但"这一轮实际写了 10 个文件"
 * 与"这件事需要 8 倍档的慎重能力"不是一回事;而分类器自己的预测绝不能当真值(#14 红线:预测不回灌)。
 * 本模块只吃**结果侧证据**(这一轮实际做了什么:工具调用数/写入数/错误数/是否触发 P2 上梯/用户是否点名旗舰),
 * 函数签名里根本没有 prompt 参数 ⇒ 结构上无法自我确认。它与词法分类器正交,与类型映射并列,
 * 两条口径**分开报数、永不混算**(混了就分不清是"分类器不准"还是"量尺漂移")。
 *
 * 上梯口径与 modelRouteProxy 一致:P2 = 当前服务档连续 2 轮修复失败才升一档(R1→R2→R3,封顶 R3),
 * 所以"escalated 的那一轮"就是**低档确实干不动**的直接证据 ⇒ 真值 = 上梯后的那一档。
 * R4 真值只认"用户显式点名旗舰/客户端选定的模型本身就在 R4 档"这类用户侧事实,词法永远给不出 R4 真值。
 * D6 未落地(S2-F5②,2026-11-17):ESC_NEXT.R3 仍 null(thresholds.mjs),从 R3 上梯的真值恒 R3 不出 R4;
 * 日后扩 R3→R4 时,本文件 escalated 分支(:59-65)须与 thresholds.ESC_NEXT 同步改,勿只改一处。
 */
import { TIER_FROM_TYPE, TIER_FROM_INTENSITY } from './tierClassify.mjs';
import { ESC_NEXT } from './thresholds.mjs'; // S1-F4:上梯表单源(thresholds.mjs)

const TIERS = ['R1', 'R2', 'R3', 'R4'];

/** 黄金条目里的 evidence 归一化('—'/缺字段 → null,不把脏值当 0)。 */
export function evidenceOf(row = {}) {
  const ev = row.evidence || {};
  const n = (v) => (typeof v === 'string' && !v.trim() ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    calls: n(ev.toolCalls ?? ev.calls),
    writes: n(ev.writeEdits ?? ev.writes),
    reads: n(ev.reads),
    errors: n(ev.errors),
    escalated: ev.escalated === true,
    // '—'(影子账本里的"无记录")与空串一律当缺字段,别让脏值冒充合法档位
    servedTier: typeof ev.servedTier === 'string' && ev.servedTier.trim() && ev.servedTier.trim() !== '—' ? ev.servedTier.trim() : null,
    flagship: ev.flagship === true,
  };
}

/**
 * 结果侧证据 → 难度真值。返回 {tier, confidence, rule} 或 {tier:null}(证据不足就不编真值)。
 * 优先级:用户点名旗舰 > P2 上梯(最硬:低档真干不动了) > 疑难形态 > 重形态 > 轻问答/例行小改。
 */
/** 三档类型口径·行为计数域(2026-11-10 二次审计 P1-10.4):importRoutingLog 与 profileCalibrate
 *  两份独立实现合并为单一真源。light=零工具;multi=w≥3||c≥15;routine=w≥1;其余不猜(返回 null)。
 *  注:exportWeakLabels.labelTurn 属 prompt 形态域(we/total 是从 prompt 文本估的写数/总轮数,
 *  估计有噪 ⇒ routine 支多一道 total≥3 护栏),与行为计数域**有意不同**,勿盲目合并(见该文件头注)。 */
export function labelFromCounts({ writes = 0, dispatches = 0, calls = 0 } = {}) {
  const w = Number(writes) || 0;
  const d = Number(dispatches) || 0;
  const c = Number(calls) || 0;
  if (w === 0 && d === 0 && c === 0) return 'light';
  if (w >= 3 || c >= 15) return 'multi';
  if (w >= 1) return 'routine';
  return null;
}

export function deriveTierTruth(ev = {}) {
  const calls = Number.isFinite(ev.calls) ? ev.calls : null;
  const writes = Number.isFinite(ev.writes) ? ev.writes : null;
  const errors = Number.isFinite(ev.errors) ? ev.errors : null;

  if (ev.flagship === true) return { tier: 'R4', confidence: 0.9, rule: 'user-named-flagship' };
  if (ev.escalated === true) {
    // 上梯那一轮 = 低档真干不动的直接证据 ⇒ 真值取上梯后的目标档;R3 封顶(代理 P2 不上 R4),
    // 已在上限仍标 escalated 时**保持原档**,不能倒挂成低一档(那会把"最强档还失败"误读成"活儿轻")。
    const from = TIERS.includes(ev.servedTier) ? ev.servedTier : 'R1';
    const next = ESC_NEXT[from] || from;
    return { tier: next, confidence: 0.8, rule: `p2-escalated(from ${from})` };
  }
  if (writes === null && calls === null) return { tier: null, confidence: 0, rule: 'no-evidence' };
  if (errors !== null && errors >= 2 && (writes === 0 || writes <= 2)) {
    return { tier: 'R2', confidence: 0.65, rule: `troubleshoot-shape(e${errors})` };
  }
  if ((writes !== null && writes >= 3) || (calls !== null && calls >= 15)) {
    return { tier: 'R2', confidence: 0.6, rule: `heavy-shape(c${calls ?? '-'}w${writes ?? '-'})` };
  }
  if ((calls === null || calls <= 2) && writes === 0) return { tier: 'R1', confidence: 0.85, rule: 'answer-only' };
  if ((calls === null || calls <= 8) && (writes === null || writes <= 2)) {
    return { tier: 'R1', confidence: 0.6, rule: `light-shape(c${calls ?? '-'}w${writes ?? '-'})` };
  }
  return { tier: null, confidence: 0, rule: 'inconclusive-shape' };
}

/** T→R 设计映射口径的 R 真值(旧口径;现网优先走强度轴,见 tierTruthFromAxes)。 */
export function truthFromType(row = {}) {
  return TIER_FROM_TYPE[String(row.humanLabel || '')] || null;
}

/**
 * 双轴 → R 真值(2026-11-06 现网口径):**语义轴优先**,强度轴仅作回落。
 * 为什么语义轴优先:R 档问的是"这件事需要多强的能力",与**意图形态**(多点改组⇒慎重档)同源;
 *   强度轴量的是"这轮实际干了多重的活"(结果侧)——活多不等于要强模型(读 15 个文件的轮照样 R1)。
 *   实测(当前黄金集 172 行):语义轴派生 R 真值 acc 0.767,强度轴派生只有 0.671 ⇒ 强度轴派生会**变差**,不采用。
 *   强度轴的正当用途是"实际行为成本度量"(跨档占比/漏升返工),不是"应该需要哪一档"。
 * 兼容:两轴都缺 ⇒ null(该行不进量尺)。
 */
export function tierTruthFromAxes(row = {}) {
  const sem = String(row.semanticType || row.humanLabel || '');
  if (TIER_FROM_TYPE[sem]) return { tier: TIER_FROM_TYPE[sem], source: 'semantic' };
  const inten = row.intensityType ? String(row.intensityType) : null;
  if (inten && TIER_FROM_INTENSITY[inten]) return { tier: TIER_FROM_INTENSITY[inten], source: 'intensity' };
  return { tier: null, source: null };
}

/**
 * 双通道并排:返回 {behavior, map, agree, tier}(tier 取"用哪条做优化目标"的那条,默认行为侧)。
 * 两条都缺 ⇒ tier=null,该行不进量尺。
 * 2026-11-06 双轴:map 通道改走**强度轴优先**(tierTruthFromAxes)——语义轴被当强度用会把 R2 门禁压到 0.362。
 */
export function reconcile(row = {}, { prefer = 'behavior' } = {}) {
  const behavior = deriveTierTruth(evidenceOf(row));
  const axes = tierTruthFromAxes(row);
  const map = axes.tier;
  const agree = !!(behavior.tier && map) ? behavior.tier === map : null;
  const tier = prefer === 'map' ? (map || behavior.tier || null) : (behavior.tier || map || null);
  const source = tier && tier === behavior.tier ? (map ? (agree ? 'both' : 'behavior') : 'behavior') : (tier ? `map:${axes.source}` : null);
  return { behavior: behavior.tier, behaviorRule: behavior.rule, behaviorConfidence: behavior.confidence, map, mapSource: axes.source, agree, tier, source, interval: tierIntervalOf(row) };
}

/**
 * 结果侧证据 → 难度真值**区间**(自进化 v2,2026-11-08 重建裁定;推翻"点值即真值")。
 * 任务所需档 N 是未知量,证据只给出区间 [min,max]:
 *   - escalated(上梯)⇒ [目标档, 目标档] 精确点:低档已连续失败(硬下界)、目标档完成过该段任务(上界),双界同点;
 *   - 疑难/重形态/轻问答等形状规则 ⇒ 与 v1 逐位相同的单点区间(量尺向后兼容,历史数可比);
 *   - 行内已带 tierInterval/interval(离线抽取器产物,如干净完成 ⇒ [R1, served] 的可解性上界;上梯+段内
 *     干净完成 ⇒ 精确点)——直接采用,抽取器已做时间线级证据合成,比行内形状规则强;
 *   - 两通道都给不出 ⇒ null(该行不进量尺)。
 * 优先序:行内区间证据 > 行为侧形状 > T→R 双轴回落。预测绝不参与(#14,本函数看不见 prompt)。
 */
export function tierIntervalOf(row = {}) {
  const iv = row.tierInterval && typeof row.tierInterval === 'object' ? row.tierInterval
    : (row.interval && typeof row.interval === 'object' ? row.interval : null);
  if (iv && TIERS.includes(iv.min) && TIERS.includes(iv.max)) {
    if (TIERS.indexOf(iv.min) <= TIERS.indexOf(iv.max)) return { min: iv.min, max: iv.max, src: iv.src || 'evidence' };
    // 倒置区间=脏数据:不采信,继续走行为侧/映射回落(不 return null)
  }
  const b = deriveTierTruth(evidenceOf(row));
  if (b.tier) return { min: b.tier, max: b.tier, src: `behavior:${b.rule}` };
  const axes = tierTruthFromAxes(row);
  if (axes.tier) return { min: axes.tier, max: axes.tier, src: `axes:${axes.source}` };
  return null;
}
