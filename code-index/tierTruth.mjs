/**
 * 档位真值的**行为侧通道**(2026-11-04,给"黄金集 R 真值"补一条独立量尺)。
 *
 * 为什么需要:T→R 设计映射(TIER_FROM_TYPE)把 T4(重实现)一律当 R2 难度,但"这一轮实际写了 10 个文件"
 * 与"这件事需要 8 倍档的慎重能力"不是一回事;而分类器自己的预测绝不能当真值(#14 红线:预测不回灌)。
 * 本模块只吃**结果侧证据**(这一轮实际做了什么:工具调用数/写入数/错误数/是否触发 P2 上梯/用户是否点名旗舰),
 * 函数签名里根本没有 prompt 参数 ⇒ 结构上无法自我确认。它与词法分类器正交,与 T 映射并列,
 * 两条口径**分开报数、永不混算**(混了就分不清是"分类器不准"还是"量尺漂移")。
 *
 * 上梯口径与 modelRouteProxy 一致:P2 = 当前服务档连续 2 轮修复失败才升一档(R1→R2→R3,封顶 R3),
 * 所以"escalated 的那一轮"就是**低档确实干不动**的直接证据 ⇒ 真值 = 上梯后的那一档。
 * R4 真值只认"用户显式点名旗舰/客户端选定的模型本身就在 R4 档"这类用户侧事实,词法永远给不出 R4 真值。
 */
import { TIER_FROM_TYPE } from './tierClassify.mjs';

const TIERS = ['R1', 'R2', 'R3', 'R4'];
const ESC_NEXT = { R1: 'R2', R2: 'R3', R3: null, R4: null };

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
  if ((writes !== null && writes >= 3) || (calls !== null && calls >= 12)) {
    return { tier: 'R2', confidence: 0.6, rule: `heavy-shape(c${calls ?? '-'}w${writes ?? '-'})` };
  }
  if ((calls === null || calls <= 2) && writes === 0) return { tier: 'R1', confidence: 0.85, rule: 'answer-only' };
  if ((calls === null || calls <= 8) && (writes === null || writes <= 2)) {
    return { tier: 'R1', confidence: 0.6, rule: `light-shape(c${calls ?? '-'}w${writes ?? '-'})` };
  }
  return { tier: null, confidence: 0, rule: 'inconclusive-shape' };
}

/** T→R 设计映射口径的 R 真值(现网 --score-golden-tier 用的就是它)。 */
export function truthFromType(row = {}) {
  return TIER_FROM_TYPE[String(row.humanLabel || '')] || null;
}

/**
 * 双通道并排:返回 {behavior, map, agree, tier}(tier 取"用哪条做优化目标"的那条,默认行为侧)。
 * 两条都缺 ⇒ tier=null,该行不进量尺。
 */
export function reconcile(row = {}, { prefer = 'behavior' } = {}) {
  const behavior = deriveTierTruth(evidenceOf(row));
  const map = truthFromType(row);
  const agree = !!(behavior.tier && map) ? behavior.tier === map : null;
  const tier = prefer === 'map' ? (map || behavior.tier || null) : (behavior.tier || map || null);
  const source = tier && tier === behavior.tier ? (map ? (agree ? 'both' : 'behavior') : 'behavior') : (tier ? 'map' : null);
  return { behavior: behavior.tier, behaviorRule: behavior.rule, behaviorConfidence: behavior.confidence, map, agree, tier, source };
}
