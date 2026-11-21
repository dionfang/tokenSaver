/** 托盘自动补权重(2026-11-18 用户拍板):安装完成后若 local 权重缺失,托盘周期检测并自动发起下载。
 *  纯决策 planAutoWeights 与可注入编排 createWeightsAuto 分离,便于密闭单测。
 *  节流:cooldownMs 内不重复发起;在途/向导忙时不插队(防与向导下载并发写同一 .part)。 */
import { WEIGHT_MODELS } from './weightsOnline.mjs';

const KEY_MAP = { embed: 'embedding', rerank: 'reranker', decision: 'decision' };

/** 纯决策:local 模式且有任一权重明确缺失(false)、无在途、非忙、超冷却 → 应发起。
 *  null(未知)不触发(避免路径未就绪时误下载)。 */
export function planAutoWeights({ modelIn, localWeights, now, lastAttemptAt = 0, inFlight = false, busy = false, cooldownMs = 10 * 60 * 1000 } = {}) {
  const missing = ['embedding', 'reranker', 'decision'].filter((k) => localWeights?.[k] === false);
  const should = modelIn === 'local' && missing.length > 0 && !inFlight && !busy && (now - (lastAttemptAt || 0) >= cooldownMs);
  return { should, missing };
}

export function createWeightsAuto({ downloadWeights, downloader, getBaseDir, log = () => {}, cooldownMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  const state = { inFlight: false, lastAttemptAt: 0 };
  async function maybe(localWeights, modelIn, { busy = false } = {}) {
    const plan = planAutoWeights({ modelIn, localWeights, now: now(), lastAttemptAt: state.lastAttemptAt, inFlight: state.inFlight, busy, cooldownMs });
    if (!plan.should) return { started: false };
    const baseDir = typeof getBaseDir === 'function' ? getBaseDir() : getBaseDir;
    if (!baseDir) return { started: false };
    state.inFlight = true; state.lastAttemptAt = now();
    const models = WEIGHT_MODELS.filter((m) => plan.missing.includes(KEY_MAP[m.key]));
    log(`[auto] 检测到缺失权重(${plan.missing.join(',')})，托盘自动发起下载`);
    try {
      const r = await downloadWeights({ models, downloader, baseDir, onLine: log });
      state.lastAttemptAt = now(); // S14-2(20261119 夜审):冷却按「完成时刻」起算,长下载失败不再吃掉冷却窗(否则弱网每次 poll 重发)
      log(r.ok ? '[ok] 托盘自动补权重完成' : '[fail] 托盘自动补权重部分失败(下轮冷却后重试)');
      return { started: true, ok: r.ok };
    } catch (e) {
      state.lastAttemptAt = now(); // S14-2:异常路径同样按完成时刻起算
      log(`[fail] 托盘自动补权重异常:${e && e.message ? e.message : e}`);
      return { started: true, ok: false };
    } finally {
      state.inFlight = false;
    }
  }
  return { maybe, _state: state };
}
