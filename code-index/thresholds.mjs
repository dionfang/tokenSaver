/**
 * thresholds.mjs — 跨模块共享阈值单源(S1-F4 收口,2026-11-14)。
 * 背景:同一语义阈值散落多处字面量,改一处漏其余(keep_alive '2h' 双写已实证一次)。
 * 本模块不 import 任何本仓模块(叶子,config.mjs 可反向引用),只放"多模块共享"的常量;
 * 单模块私有的阈值仍留在该模块内,不要为了集中而集中。
 */

/** R1 歧义置信上限:≤ 此值的 R1 判定属"词法最瞎区"(判不出而非明确日常轮)。
 *  消费方:modelRouteProxy(arm1 触发窗 / R1 宽限歧义轮 / 影子对账)、profileCalibrate(ambiguous 窗)。 */
export const R1_AMBIGUOUS_CONF = 0.5;

/** P2 证据升级的逐级上梯表(R1→R2→R3 封顶;R4 恒不可达,只认显式点名)。
 *  消费方:modelRouteProxy(实弹上梯)、tierTruth(影子对账同口径)。 */
export const ESC_NEXT = { R1: 'R2', R2: 'R3', R3: null, R4: null };

/** 升档阶段最长人类轮数(到顶回主循环)。消费方:config 默认值、init 播种骨架、modelRouteProxy 读取。 */
export const MAX_PHASE_TURNS = 4;

/** 切换税门控的上下文上限(tokens,≈640KB 请求体)。消费方:config 默认值、init 播种骨架。 */
export const SWITCH_GUARD_MAX_CONTEXT_TOKENS = 200000;
