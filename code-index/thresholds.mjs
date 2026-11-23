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

/** 缓存「热→冷」时效(ms):超过该空闲时长即视为缓存冷(代理 cacheCold 门与显式缓存计价 TTL 同一事实)。
 *  消费方:modelRouteProxy(cacheCold 判定)、costProfile(显式缓存 ttlMs 默认)。S1-F4 20261118 双写收口。 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** L2 混合向量库的层权重(PU-001 A):base=服务器清洗权威层全权,local=本机自签辅助层降权。
 *  仅混合库(base 有数据)生效;纯 local 库 local 权重=1,行为与改前一致。
 *  消费方:config(系统域默认 knnLocalWeight)、modelRoute(knnClassify 层权重)。S14-F4 20261118 双写收口。 */
export const L2_LAYER_WEIGHTS = { base: 1, local: 0.6 };

/** R-ref 决策咨询单次超时兜底上限(ms):与档案 maxLatencyMs 取 min(S2-F1 单源,20261118)。
 *  消费方:modelRouteProxy(arm1/arm2 judgeTier 超时、装配默认)。方案文档语义=「超时上限」,降窗未实现。 */
export const RREF_CONSULT_TIMEOUT_MS = 5000;

/** R3 硬真值种子入池门槛:tier-evidence 的 p2-escalated→R3 行攒够该数才按 R3 类入样本池
 *  (沿 modelRoute.mjs l2TierRescue 头注"每类 ≥8 条后补嵌"的既定设计;不足则计数不入场,噪声隔离)。
 *  消费方:autoExemplars(R3 种子通道)。 */
export const R3_SEED_MIN = 8;

/** L2 降档救援影子门槛:kNN 以 ≥ 此置信投 light 时,词法 R2 轮记"改判 R1"影子(l2DownWould*),
 *  只记账对账不改实弹(2026-11-22 影子先行)。消费方:modelRouteProxy(影子账)。 */
export const L2_DOWN_MIN_CONF = 0.85;
