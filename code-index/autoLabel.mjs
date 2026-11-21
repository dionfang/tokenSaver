/**
 * 自动代签(2026-11-02,用户要求:彻底去掉人工签字环节)。
 *
 * 做法:**四票合议**(2026-11-03 三投票+一加权定档;2026-11-09 v3 口径正式化——决策票为常驻合议方,
 *   起投/2 票权重门槛按模型判定档案标定;L3 层已取消——语义兜底由四档分档承担):
 *   ① L1 规则(classify.mjs)      —— 词法信号,1 票
 *   ② L2 向量 kNN(modelRoute.mjs) —— 语义近邻,1 票
 *   ③ 行为形态(importRoutingLog)  —— 该轮实际写了几个文件/调了几次工具(结果侧证据),1 票
 *   ④ 决策模型(decisionModel.mjs)—— 常驻合议方,按档案门槛加权计票,可影响代签结果;
 *          断网/跳闸自动弃权,三票照常。
 * 投给黄金集(label=该轮真实动作类型)——**行为票与词法/语义互不自我确认**,是打破闭环的关键。
 *
 * 规则:
 *   - 唯一得票领先且 ≥2 票 ⇒ 自动签(humanLabel + reviewed + auto 标记 + 票型明细);
 *   - 平票/只有 1 票 ⇒ **不签**,条目只留在样本池(不进量尺)——量尺保持"高置信子集"的性质;
 *   - 续写类指令(继续/接着/下一步…)本身不可独立分类 ⇒ 直接排除;
 *   - 短 prompt(<8 字)不签(信号不足);
 *   - 标签冲突时不做人工裁决,一律按票数走;分歧项进"分歧报告"仅作诊断,不需要人处理。
 *
 * 代价与取舍(用户已知并接受):行为形态是代理指标,续写/状态询问类会标错(见 pending/分歧报告);
 * 兜底路径(不切换、用当前模型)本身最省,所以错分派的代价可控。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { promptKey } from './buildExemplars.mjs';
import { normalizeType } from './classify.mjs';

/** 续写类指令:不可独立分类,排除。 */
export const CONTINUATION_RE = /^\s*(继续|接着|然后|下一步|那就|好的|go on|continue|next)/i;
/** 最短可签长度(太短信号不足)。 */
export const MIN_SIGNABLE_LEN = 8;

/** 是否可签(过滤续写与过短)。 */
export function signable(prompt) {
  const t = String(prompt || '').trim();
  if (t.length < MIN_SIGNABLE_LEN) return false;
  if (CONTINUATION_RE.test(t)) return false;
  return true;
}

/**
 * 双轴标签(2026-11-06):把"这轮是重活/例行/杂务"这一个标签拆成**两个正交轴**——
 *   语义形态轴 semanticType = multi/routine/light:由 L1 词法 / L2 向量 / 决策模型合议得出,
 *     回答"**这句话要求的是不是多点改组**"(意图侧,prompt 形态);
 *   行为强度轴 intensityType = heavy/normal/light:由行为票(该轮实际写了几次文件/调了几次工具)得出,
 *     回答"**这一轮实际干了多重的活**"(结果侧,evidence 重放)。
 * 为什么拆:此前两者塞进同一个 humanLabel 比较,而黄金集的 multi 实际是**行为强度标签**(46/46 行为 heavy),
 * L1 的 multi 却是**句式形态标签**(只认出 7/46)⇒ 同一标签名下两把尺子,multi 一致率被压到 0.2,
 * 连带 scoreGoldenTier 的 R2 门禁(acc 0.362)不过。拆开后各轴各评各的,天花板才可能翻。
 * 两轴都是机器合议的**弱真值**,不是外部人工真值——报告里必须这样标注,不得冒充准确率。
 */
// 双轴值域常量已物理下沉到 buildExemplars(2026-11-10 审计修复:modelRoute 取常量不必加载本模块全图);此处重导出兼容旧调用方
export { SEMANTIC_AXIS, INTENSITY_AXIS } from './buildExemplars.mjs';

/** 行为强度标签(three-class 行为票)→ 双轴的强度轴取值。行为票只认 heavy(写≥3/调用≥15)与 light(零工具),中间=normal。 */
export function toIntensity(type) {
  const t = String(type || '');
  if (t === 'multi') return 'heavy';
  if (t === 'light') return 'light';
  if (t === 'routine') return 'normal';
  return null;
}

/**
 * 双轴投票:同一批 voters 分两轴各算一次(纯函数)。
 *   语义轴票源 = l1 / l2 / decision(意图侧);强度轴票源 = behavior(结果侧,唯一来源);
 *   行为票**不参与**语义轴计票,决策/L1/L2 **不参与**强度轴——两轴互不污染。
 * 强度轴只有行为票一个源 ⇒ 单源不构成 quorum(沿用"≥2 票且 ≥2 源"纪律的"源数≥1 即出结果"例外:
 *   强度轴本就只有一条证据通道,拿不出票就置 null,不猜)。
 * 返回 {semantic:{type,votes,sources,agreement}, intensity:{...}}。
 */
export function voteLabelDual(voters = {}) {
  const semanticVoters = {};
  for (const k of ['l1', 'l2', 'decision']) if (voters[k]) semanticVoters[k] = voters[k];
  const semantic = voteLabel(semanticVoters);
  const b = voters.behavior;
  const intensityType = b && b.type ? toIntensity(b.type) : null;
  const intensity = intensityType
    ? { type: intensityType, votes: 1, sources: 1, total: 1, agreement: 1, voters: { [intensityType]: ['behavior'] }, contested: false }
    : { type: null, votes: 0, sources: 0, total: 0, agreement: 0, voters: {}, contested: true };
  return { semantic, intensity };
}

/**
 * 加权投票。voters: {l1:{type}, l2:{type}, decision:{type,confidence}, behavior:{type}}(L3 投票源已随层级取消删除);
 * 每个投票者可带 weight(默认 1)。决策模型按 confidence 给权重:≥0.9 记 2 票、≥0.6 记 1 票、更低弃权。
 *
 * 门槛(2026-11-02 修漏洞):**必须至少两个不同投票源**,否则即便权重合计 ≥2 也不签——
 * 原实现只有"权重≥2"这一条,导致决策模型单票(权重2)即可独签黄金集,等于"一个模型自己说了算"。
 * 权重只用于比较领先幅度,不再充当"票数"。
 * 返回 {type, votes(权重和), sources(投票源数), total, agreement, voters, contested}。
 */
export function voteLabel(voters = {}) {
  const tally = {};
  const detail = {};
  const sources = new Set();
  let total = 0;
  for (const [name, v] of Object.entries(voters)) {
    const t = v && v.type ? String(v.type) : null;
    if (!t) continue;
    let w = Number.isFinite(Number(v.weight)) && Number(v.weight) > 0 ? Number(v.weight) : 1;
    // 决策票加权只许"救回"不许压制(2026-11-06):行为票是四票里唯一的结果侧证据;决策票与行为票
    // 相左时加权降回 1 票,回到同等话语权交其余票仲裁——防两个同源文本票(决策+L1)联合压掉行为证据。
    if (name === 'decision' && w > 1 && voters.behavior && voters.behavior.type && normalizeType(t) !== normalizeType(String(voters.behavior.type))) w = 1; // 归一后比较:行为票旧 T1-T8 值折叠为三类再比,防跨值域恒不相等误降权(2026-11-10 审计修复)
    tally[t] = (tally[t] || 0) + w;
    total += w;
    sources.add(name);
    // 血缘(2026-11-09):决策票在 labelRule 里带模型身份(decision@<model>);存量旧票无 model 照旧输出 decision。
    detail[t] = (detail[t] || []).concat(name === 'decision' && v.model ? `decision@${v.model}` : name);
  }
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { type: null, votes: 0, sources: 0, agreement: 0, voters: detail, contested: true };
  const [top, n] = entries[0];
  const tied = entries.length > 1 && entries[1][1] === n;
  const agreement = total ? n / total : 0;
  const topSources = (detail[top] || []).length; // 支持最高票标签的**不同投票源**数
  // 唯一领先 + 权重 ≥2 + 最高票标签有 ≥2 个不同投票源 ⇒ 可签
  const ok = !tied && n >= 2 && topSources >= 2;
  // 1B(20261119 用户裁定):行为票否决权——行为票是四票里唯一的结果侧证据。当最高票标签由
  // ≥2 个非行为票(L1/L2/决策)联盟撑起、而行为票明确指向另一类时,不签(降级 contested),
  // 防文本/检索联盟压掉真实行为证据。行为票缺席或同意最高票时不触发。
  const behaviorOpposes = ok && voters.behavior && voters.behavior.type
    && normalizeType(String(voters.behavior.type)) !== normalizeType(top);
  const okFinal = ok && !behaviorOpposes;
  return { type: okFinal ? top : null, votes: n, sources: topSources, total, agreement: Math.round(agreement * 100) / 100, voters: detail, contested: !okFinal };
}

/**
 * 对一批候选做自动代签:voters 由调用方提供(各判别器的结果)。
 * 返回 {signed, contested, skipped}。
 */
export function autoSign(candidates, votersOf, { minVotes = 2 } = {}) {
  const signed = [];
  const contested = [];
  const skipped = [];
  for (const c of candidates || []) {
    if (!signable(c.prompt)) { skipped.push({ ...c, reason: '不可独立分类(续写/过短)' }); continue; }
    const voters = votersOf(c);
    const v = voteLabel(voters);
    // 双轴(2026-11-06):语义轴合议走原口径(写 humanLabel,向后兼容);强度轴取行为票单源。
    // 两者**分别记录**——评测时按轴各评各的,不再把两种尺子塞进同一标签名下比。
    const dual = voteLabelDual(voters);
    if (v.contested || !v.type || v.votes < minVotes) {
      contested.push({ ...c, vote: v, dual });
      continue;
    }
    signed.push({
      project: c.project || 'TokenSaver',
      prompt: c.prompt,
      autoLabel: v.type,
      humanLabel: v.type,
      // 双轴字段(2026-11-06):语义形态轴=意图侧合议;行为强度轴=结果侧证据(可能为 null=行为证据缺失)
      semanticType: dual.semantic.type || v.type,
      intensityType: dual.intensity.type,
      reviewed: true,
      autoSigned: true,
      labelRule: `ensemble(${Object.values(v.voters).flat().join('+')})`,
      agreement: v.agreement,
      votes: v.votes,
      sources: v.sources,
      voters,
      evidence: { toolCalls: c.shape ? c.shape.calls : '-', writeEdits: c.shape ? c.shape.writes : '-' },
    });
  }
  return { signed, contested, skipped };
}

/** 把自动代签结果并入黄金集(已签条目优先保留 + 补新自动签,按 promptKey 去重)。
 *  2026-11-04 起黄金集全为四票代签:人工/构造条目的判据(reviewed 或 非 auto 的 T 标签)保留,只兼容旧数据;
 *  2026-11-06 费解:同一 pkey 的新鲜代签条目会更新原条目的票型/voters/labelRule/agreement,
 *  但不改 humanLabel/reviewed/evidence,让黄金集跟上可观测性改进。 */
export function mergeAutoSigned(freshRows, existing = []) {
  const byKey = new Map();
  const isSigned = (r) => r.reviewed === true || /^(multi|routine|light|T[1-8])$/.test(r.humanLabel || '');
  const keyOf = (r) => r.pkey || promptKey(r.prompt || '');
  for (const r of existing.filter(isSigned)) {
    const k = keyOf(r);
    if (!byKey.has(k)) byKey.set(k, r);
  }
  const kept = [...byKey.values()];
  // 双轴回填(2026-11-06):旧条目只有 humanLabel(单轴混合),从已存的 voters 反推两轴——
  // 语义轴=l1/l2/decision 三票合议,强度轴=behavior 单源;回填只**加字段**,不改 humanLabel。
  for (const r of kept) {
    if (r.semanticType === undefined && r.voters) {
      const d = voteLabelDual(r.voters);
      if (d.semantic.type) r.semanticType = d.semantic.type;
      if (d.intensity.type) r.intensityType = d.intensity.type;
    }
  }
  const seen = new Set(kept.map(keyOf));
  const out = [...kept];
  for (const r of freshRows) {
    const k = keyOf(r);
    if (seen.has(k)) {
      const old = byKey.get(k);
      if (old && r.voters) {
        old.voters = r.voters;
        old.labelRule = r.labelRule;
        old.agreement = r.agreement;
        old.votes = r.votes;
        old.sources = r.sources;
        // 双轴字段(2026-11-06):随新鲜代签刷新,否则旧条目永远没有轴(两轴评测无从做起)
        if (r.semanticType !== undefined) old.semanticType = r.semanticType;
        if (r.intensityType !== undefined) old.intensityType = r.intensityType;
      }
      continue;
    }
    // S14-F6(20261118):isSigned 先验后占坑——同 key 先非法后合法时,合法行不再被 seen 挡在池外
    // (S12-F1 兜底的正序化:先复检再进 seen;非法行不消费坑位)。
    if (!isSigned(r)) continue;
    seen.add(k);
    out.push({ ...r, pkey: k });
  }
  return out;
}

/** 诊断报告(不需要人签字,只看统计)。 */
export function writeReport({ signed, contested, skipped }, { dataDir = DATA_DIR, decisionNote = '' } = {}) {
  const out = path.join(dataDir, 'routing', 'auto-label-report.md');
  const dist = {};
  const sourceTally = { l1: 0, l2: 0, decision: 0, behavior: 0 };
  for (const s of signed) {
    dist[s.humanLabel] = (dist[s.humanLabel] || 0) + 1;
    if (s.voters) {
      for (const src of ['l1', 'l2', 'decision', 'behavior']) {
        if (s.voters[src]) sourceTally[src] += 1;
      }
    }
  }
  const head = [
    '# 自动代签报告(无需人工处理)',
    '',
    `> 代签时间:${new Date().toISOString()}　已签:${signed.length}　分歧:${contested.length}　排除(续写/过短):${skipped.length}`,
    `> 规则:L1 词法 / L2 向量 / 行为形态 三票 + 决策模型加权,唯一领先且 ≥2 票才签;平票与单票只留样本池。${decisionNote ? '　' + decisionNote : ''}`,
    '',
    '## 已签标签分布',
    '',
    '| 类型 | 条数 |',
    '|---|---|',
    ...Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## 投票源参与(已签样本)',
    '',
    '| 投票源 | 条数 |',
    '|---|---|',
    ...Object.entries(sourceTally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## 分歧项(仅诊断,不进量尺)',
    '',
    '| 票型 | prompt(截断) |',
    '|---|---|',
    ...contested.slice(0, 40).map((c) => `| ${JSON.stringify(c.vote && c.vote.voters)} | ${String(c.prompt).replace(/\|/g, '/').slice(0, 70)} |`),
    '',
  ];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, head.join('\n'));
  return { out, signed: signed.length, contested: contested.length, skipped: skipped.length };
}

