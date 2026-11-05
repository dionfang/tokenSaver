/**
 * 档位成本画像(单位:**R1 价 token 等效 / 每请求**)。2026-11-04 用户提供画像包,本模块把它固化成可计算的代价函数。
 *
 * 画像基线:1M = 965k 缓存读 + 34k 新输入 + 1k 输出(一次请求的 token 构成)。
 *   - 隐式缓存(自动、不可关,命中部分按输入标准价 20% 计费):热轮 0.23M / 冷轮 1.00M / 切换税 0.77M
 *   - 显式缓存(主动创建,创建 125%、命中 10%、5min TTL):创建轮 1.24M / 命中轮 0.13M / 换模型税 1.11M
 *   ⇒ 两条"税"都不是独立项,恒等于 (冷读价 − 热读价):隐式 1.00−0.23=0.77、显式 1.24−0.13=1.11。
 *     **切换模型最大的冷读付费就是缓存费**,所以路由的代价函数必须以"是否换档"为第一变量。
 * 档位倍率:R1=1x(日常主力)/ R2=8x(增强,慎重改动)/ R3=15x(最强,R2 明确解决不了)/ R4=100x(奢侈,仅显式点名)。
 *   倍率乘在**整轮价**上(缓存读写同样按该档模型自己的单价结算)⇒ 高档误升一轮的损失 = 倍率 ×(冷读 − 热读),
 *   这正是 tierClassify 把成本悬崖放在 R1→R2、并要求 P2 行为证据才上梯的量化理由。
 *
 * 本模块只做算术,不读黄金集、不判档位;判定在 tierOptimize.mjs,消费在 modelRouteProxy.mjs(影子口径)。
 * 两个"定价旋钮"必须诚实标注:`underTier.failTurns` 与 `qualityPenaltyPerStepM` 是**返工定价**,不是实测值
 * (实测只能给出 token 侧代价;"弱模型干重活"的质量损失无法从账本读出),改它们等于改优化目标,须人工决定。
 */

/** 画像默认值(用户 2026-11-04 给定口径,M = 100 万 R1 等效 token)。 */
export const DEFAULT_COST_PROFILE = {
  version: 1,
  builtAt: null,
  source: 'user-profile-20261104',
  /** 单次请求的 token 构成锚点(仅用于报告口径换算,不参与判定)。 */
  requestMix: { perRequestM: 1.0, cachedM: 0.965, freshM: 0.034, outputM: 0.001 },
  /** 档位单价倍率(相对 R1)。 */
  tierMultiplier: { R1: 1, R2: 8, R3: 15, R4: 100 },
  /** 隐式缓存:自动、命中 20%。 */
  implicit: { hitDiscount: 0.2, hotM: 0.23, coldM: 1.0 },
  /** 显式缓存:创建 125% / 命中 10% / TTL 5min。 */
  explicit: { hitDiscount: 0.1, createDiscount: 1.25, hotM: 0.13, coldM: 1.24, ttlMs: 5 * 60 * 1000 },
  /** 当前计费面(隐式=默认;显式需主动开启,本机以隐式为主)。 */
  cacheMode: 'implicit',
  /** 漏升(该升没升)的返工模型:P2 要连续 2 轮失败才上梯,故空转轮数 = 2。 */
  underTier: { failTurns: 2 },
  /** 每低一档的质量损失定价(M R1 等效;默认 1 个冷读轮 ≈ 一次返工,人工旋钮,非实测)。 */
  qualityPenaltyPerStepM: 1.0,
};

const TIERS = ['R1', 'R2', 'R3', 'R4'];
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);

/** 合并画像:部分传入即可,缺字段回落默认;非法值一律丢弃(纯函数)。 */
export function resolveCostProfile(p) {
  const d = DEFAULT_COST_PROFILE;
  if (!p || typeof p !== 'object') return { ...d };
  const merge = (base, over) => {
    const out = { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(base)) {
      if (Number.isFinite(Number(over[k])) || typeof over[k] === 'string') out[k] = k === 'ttlMs' ? num(over[k], base[k]) : (typeof base[k] === 'number' ? num(over[k], base[k]) : String(over[k] || base[k]));
    }
    return out;
  };
  const mult = { ...d.tierMultiplier };
  if (p.tierMultiplier) for (const t of TIERS) if (Number.isFinite(Number(p.tierMultiplier[t])) && Number(p.tierMultiplier[t]) > 0) mult[t] = Number(p.tierMultiplier[t]);
  const cacheMode = p.cacheMode === 'explicit' ? 'explicit' : p.cacheMode === 'implicit' ? 'implicit' : d.cacheMode;
  return {
    version: num(p.version, d.version),
    builtAt: p.builtAt || null,
    source: p.source || d.source,
    requestMix: merge(d.requestMix, p.requestMix),
    tierMultiplier: mult,
    implicit: merge(d.implicit, p.implicit),
    explicit: merge(d.explicit, p.explicit),
    cacheMode,
    underTier: merge(d.underTier, p.underTier),
    qualityPenaltyPerStepM: num(p.qualityPenaltyPerStepM, d.qualityPenaltyPerStepM),
  };
}

/** 档位序数(R1=1…R4=4);未知档按 R1 计(最省侧,与分类器回落同口径)。 */
export function tierRank(tier) {
  const i = TIERS.indexOf(tier);
  return i < 0 ? 1 : i + 1;
}

/** 该档单价倍率。 */
export function tierMultiplier(profile, tier) {
  const p = resolveCostProfile(profile);
  return num(p.tierMultiplier[tier], 1);
}

/**
 * 单轮基础价(M R1 等效,不含档位倍率)。
 * state: 'hot'(吃热缓存/命中) | 'cold'(冷读,含换档即付的切换税)。
 */
export function baseTurn(profile, { state = 'hot', cacheMode = null } = {}) {
  const p = resolveCostProfile(profile);
  const side = (cacheMode || p.cacheMode) === 'explicit' ? p.explicit : p.implicit;
  return state === 'cold' ? side.coldM : side.hotM;
}

/** 切换税(M R1 等效,按目标档倍率放大)——报告用,判定用不到(冷读里已含)。 */
export function switchTax(profile, { toTier = 'R1', cacheMode = null } = {}) {
  const cold = baseTurn(profile, { state: 'cold', cacheMode });
  const hot = baseTurn(profile, { state: 'hot', cacheMode });
  return Number(((cold - hot) * tierMultiplier(profile, toTier)).toFixed(4));
}

/**
 * **一轮定档决定**的代价(M R1 等效)+ 转移后的档位状态。纯函数;序列由 policyCost 折叠。
 * 约定(关键是"换档必冷读"对正确/错误决定**一视同仁**,否则基线不公平):
 *   - 判对(pred===true):与上一轮同档 → 吃热缓存 hot×mult;跨档而来 → 冷读 cold×mult(正确的升档照样付税)
 *   - 误升(pred>true):当轮在高档付费(换档即冷读),阶段驻留 ⇒ 下一轮仍在这档(与代理阶段机制同口径)
 *   - 漏升(pred<true):先在弱档空转 failTurns 轮(P2 要连续 2 轮失败才上梯),再由证据升上去付一次冷读,
 *     状态转到真值档;另加质量损失 steps × qualityPenaltyPerStepM
 * qualityPenaltyPerStepM=0 ⇒ 退化为纯 token 口径(此时"恒 R1"往往最省,这是事实不是 bug)。
 * prevTier 缺省视为 'R1'(auto 会话的 sticky 基准)。
 */
export function turnCost(profile, { prevTier = null, trueTier, predTier } = {}) {
  const p = resolveCostProfile(profile);
  const hot = baseTurn(p, { state: 'hot' });
  const cold = baseTurn(p, { state: 'cold' });
  const t = TIERS.includes(trueTier) ? trueTier : 'R1';
  const q = TIERS.includes(predTier) ? predTier : 'R1';
  const pv = TIERS.includes(prevTier) ? prevTier : 'R1';
  const mt = tierMultiplier(p, t);
  const mq = tierMultiplier(p, q);
  const sameAsPrev = q === pv;
  let kind = 'correct';
  let steps = 0;
  let tokenCost;
  let nextTier = q;
  if (q === t) {
    tokenCost = (sameAsPrev ? hot : cold) * mq;
  } else if (tierRank(q) > tierRank(t)) {
    kind = 'over';
    steps = tierRank(q) - tierRank(t);
    tokenCost = (sameAsPrev ? hot : cold) * mq;
  } else {
    kind = 'under';
    steps = tierRank(t) - tierRank(q);
    const fail = Math.max(1, num(p.underTier.failTurns, 2));
    tokenCost = (sameAsPrev ? fail * hot : cold + (fail - 1) * hot) * mq + cold * mt;
    nextTier = t;
  }
  const qualityPenalty = kind === 'under' ? steps * num(p.qualityPenaltyPerStepM, 0) : 0;
  return {
    kind,
    steps,
    tokenCost: Number(tokenCost.toFixed(4)),
    qualityPenalty: Number(qualityPenalty.toFixed(4)),
    total: Number((tokenCost + qualityPenalty).toFixed(4)),
    nextTier,
  };
}

/** 兼容旧名:无状态的单轮代价(prevTier 默认 R1)。 */
export const decisionCost = (profile, { trueTier, predTier } = {}) => {
  const { nextTier, ...rest } = turnCost(profile, { trueTier, predTier });
  return rest;
};

/**
 * 一个策略在**按时间顺序**排列的真值行上的总代价(逐行折叠档位状态 ⇒ 行序=会话时序,黄金集 id 序即是)。
 * 基准线走同一条折叠规则,可横向比较:alwaysR1=恒判 R1;oracle=每轮判对(真实难度变化照样要付切换税)。
 */
export function policyCost(profile, rows = []) {
  const p = resolveCostProfile(profile);
  const fold = (predOf) => {
    let prev = null;
    let token = 0;
    let penalty = 0;
    let switches = 0;
    for (const r of rows) {
      const c = turnCost(p, { prevTier: prev, trueTier: r.trueTier, predTier: predOf(r) });
      token += c.tokenCost;
      penalty += c.qualityPenalty;
      if ((prev || 'R1') !== c.nextTier) switches += 1;
      prev = c.nextTier;
    }
    return { token: Number(token.toFixed(3)), penalty: Number(penalty.toFixed(3)), total: Number((token + penalty).toFixed(3)), switches };
  };
  const actual = fold((r) => r.predTier || 'R1');
  let hit = 0;
  let over = 0;
  let under = 0;
  for (const r of rows) {
    const k = turnCost(p, { trueTier: r.trueTier, predTier: r.predTier }).kind;
    if (k === 'over') over += 1;
    else if (k === 'under') under += 1;
    else hit += 1;
  }
  const n = rows.length;
  const alwaysR1 = fold(() => 'R1');
  const oracle = fold((r) => r.trueTier);
  return {
    n,
    hit,
    over,
    under,
    accuracy: n ? Number((hit / n).toFixed(3)) : null,
    tokenCost: actual.token,
    qualityPenalty: actual.penalty,
    total: actual.total,
    switches: actual.switches,
    perRowMean: n ? Number((actual.total / n).toFixed(4)) : null,
    baselines: { alwaysR1: alwaysR1.total, alwaysR1Token: alwaysR1.token, oracle: oracle.total, oracleToken: oracle.token },
  };
}

const pct = (arr, q) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))];
};

/**
 * 用代理账本(data/usage/proxy-usage.jsonl)复核画像。同一口径下
 *   equiv = inTok + cacheRead × 命中折扣 + cacheWrite × 创建折扣
 * **关键是归一化**:画像锚点是"1M 上下文的一口价"(热 0.23 / 冷 1.00),而账本里的请求上下文从几十 K 到
 * 几十万 K 不等——直接取 equiv 的 p50 会得到"冷 0.0004M < 热 0.047M"这种**尺寸混杂的假结论**。
 * 故按 contextM = (inTok+cacheRead+cacheWrite)/1e6 归一(perM = equivM / contextM),
 * 再与锚点 0.23/1.00 直接可比;contextM < minContextM 的请求固定开销占比过大,剔除不参与复核。
 * tierOf 由调用方注入(modelRoute.tierOfModel),避免本模块依赖路由模块造成循环引用。
 */
export function fitFromLedger({ rows = [], tierOf = null, minContextM = 0.05 } = {}) {
  const p = resolveCostProfile(null);
  const groups = new Map();
  let used = 0;
  let droppedBySize = 0;
  for (const r of rows) {
    const inTok = Number(r.inTok), outTok = Number(r.outTok), cr = Number(r.cacheRead), cw = Number(r.cacheWrite);
    if (![inTok, outTok, cr, cw].every(Number.isFinite)) continue;
    const contextM = (inTok + cr + cw) / 1e6;
    if (!(contextM > 0)) continue;
    if (contextM < minContextM) { droppedBySize += 1; continue; }
    const cache = cr > 0 ? 'hot' : 'cold';
    const tier = (r.tier && TIERS.includes(r.tier)) ? r.tier : (tierOf ? tierOf(r.served || r.target || '') : null) || 'unknown';
    const equivM = (inTok + cr * p.implicit.hitDiscount + cw * p.explicit.createDiscount) / 1e6;
    used += 1;
    const key = `${tier}|${cache}${r.switched ? '|switch' : ''}`;
    const g = groups.get(key) || { key, tier, cache, switched: !!r.switched, vals: [], ctx: [] };
    g.vals.push(equivM / contextM);
    g.ctx.push(contextM);
    groups.set(key, g);
  }
  const out = [...groups.values()].map((g) => ({
    key: g.key, tier: g.tier, cache: g.cache, switched: g.switched, n: g.vals.length,
    perMP50: Number(pct(g.vals, 0.5).toFixed(4)), perMP90: Number(pct(g.vals, 0.9).toFixed(4)),
    perMMean: Number((g.vals.reduce((s, v) => s + v, 0) / g.vals.length).toFixed(4)),
    contextMP50: Number(pct(g.ctx, 0.5).toFixed(4)),
  })).sort((a, b) => b.n - a.n);
  const hotR1 = out.find((g) => g.tier === 'R1' && g.cache === 'hot' && !g.switched);
  const coldR1 = out.find((g) => g.tier === 'R1' && g.cache === 'cold');
  const enough = (g) => g && g.n >= 20;
  return {
    used,
    droppedBySize,
    minContextM,
    groups: out,
    // comparable=false 时 implied 为 null:账本里没有够大且够多的样本 ⇒ **不许拿不可比的数当成"复核通过"**
    comparable: !!(enough(hotR1) && enough(coldR1)),
    implied: enough(hotR1) && enough(coldR1)
      ? {
        perMHot: hotR1.perMP50, perMCold: coldR1.perMP50,
        switchTaxPerM: Number((coldR1.perMP50 - hotR1.perMP50).toFixed(4)),
        nHot: hotR1.n, nCold: coldR1.n,
      }
      : null,
    againstProfile: { perMHot: p.implicit.hotM, perMCold: p.implicit.coldM },
  };
}

// CLI:node costProfile.mjs --fit [--usage 文件] | --explain
const directRun = process.argv[1] && process.argv[1].endsWith('costProfile.mjs');
if (directRun) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DATA_DIR } = await import('./config.mjs');
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  if (argv.includes('--fit')) {
    const file = opt('--usage', path.join(DATA_DIR, 'usage', 'proxy-usage.jsonl'));
    let rows = [];
    try { rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { console.error(`账本不可读:${file}`); process.exit(1); }
    const { tierOfModel } = await import('./modelRoute.mjs');
    console.log(JSON.stringify(fitFromLedger({ rows, tierOf: (m) => tierOfModel(m) }), null, 1));
  } else {
    const p = resolveCostProfile(null);
    for (const t of TIERS) {
      console.log(`${t} ×${p.tierMultiplier[t]}: 热轮 ${(baseTurn(p, { state: 'hot' }) * p.tierMultiplier[t]).toFixed(2)}M / 冷轮 ${(baseTurn(p, { state: 'cold' }) * p.tierMultiplier[t]).toFixed(2)}M / 切换税 ${switchTax(p, { toTier: t }).toFixed(2)}M`);
    }
  }
}
