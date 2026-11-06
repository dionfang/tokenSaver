/**
 * 自动代签(2026-11-02,用户要求:彻底去掉人工签字环节)。
 *
 * 做法:**三投票 + 一加权**(2026-11-03 用户定档,L3 层已取消——语义兜底由四档分档承担):
 *   ① L1 规则(classify.mjs)      —— 词法信号,1 票
 *   ② L2 向量 kNN(modelRoute.mjs) —— 语义近邻,1 票
 *   ③ 行为形态(importRoutingLog)  —— 该轮实际写了几个文件/调了几次工具(结果侧证据),1 票
 *   加权 = 决策模型(decisionModel.mjs)—— 开关生效且可达时按置信加权计票,可影响代签结果;
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
    const w = Number.isFinite(Number(v.weight)) && Number(v.weight) > 0 ? Number(v.weight) : 1;
    tally[t] = (tally[t] || 0) + w;
    total += w;
    sources.add(name);
    detail[t] = (detail[t] || []).concat(name);
  }
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { type: null, votes: 0, sources: 0, agreement: 0, voters: detail, contested: true };
  const [top, n] = entries[0];
  const tied = entries.length > 1 && entries[1][1] === n;
  const agreement = total ? n / total : 0;
  const topSources = (detail[top] || []).length; // 支持最高票标签的**不同投票源**数
  // 唯一领先 + 权重 ≥2 + 最高票标签有 ≥2 个不同投票源 ⇒ 可签
  const ok = !tied && n >= 2 && topSources >= 2;
  return { type: ok ? top : null, votes: n, sources: topSources, total, agreement: Math.round(agreement * 100) / 100, voters: detail, contested: !ok };
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
    const v = voteLabel(votersOf(c));
    if (v.contested || !v.type || v.votes < minVotes) {
      contested.push({ ...c, vote: v });
      continue;
    }
    signed.push({
      project: c.project || 'TokenSaver',
      prompt: c.prompt,
      autoLabel: v.type,
      humanLabel: v.type,
      reviewed: true,
      autoSigned: true,
      labelRule: `ensemble(${Object.values(v.voters).flat().join('+')})`,
      agreement: v.agreement,
      votes: v.votes,
      sources: v.sources,
      voters: votersOf(c),
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
      }
      continue;
    }
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

