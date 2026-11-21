#!/usr/bin/env node
/**
 * R-ref 影子对账报告(D5 验收通道,2026-11-09 v3 方案 §3 D5/D6)。
 *
 * 只读:data/usage/r-ref-shadow.jsonl × data/usage/proxy-usage.jsonl × data/routing/tier-evidence.jsonl
 * 产出:data/routing/rref-audit-report.md——
 *   ① arm1/arm2 救回对账:救回轮的后续证据(P2 再上梯=救晚了/干净完成=救对了),以"误救率/漏救数"给 D4/D5 解锁依据;
 *   ② D4 临界影子(arm=d4-critical):三类 flags 的决策票 vs 词法一致率;
 *   ③ D6 影子:R3 服务轮中报错≥2 或死循环证据计数(若 D6 开将上 R4 的次数,不真上梯);
 *   ④ 延迟 p95 / 缓存命中率(档案门槛标定的健康面)。
 * 跑法:node rrefAudit.mjs [--data <dataDir>](缺省 DATA_DIR);exit 0 恒(报告工具,失败写 stderr)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url'; // S2-4:directRun 解码 %20
import { DATA_DIR } from './config.mjs';

const readJsonl = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
};
const p95 = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};

export function auditRRef({ dataDir = DATA_DIR, now = new Date() } = {}) {
  const shadow = readJsonl(path.join(dataDir, 'usage', 'r-ref-shadow.jsonl'));
  const usage = readJsonl(path.join(dataDir, 'usage', 'proxy-usage.jsonl'));
  const evidence = readJsonl(path.join(dataDir, 'routing', 'tier-evidence.jsonl'));
  // pkey → 轮后证据:该 pkey 任一轮 escalated=true ⇒ "低档确实干不动"直接证据
  const escByPkey = new Map();
  for (const u of usage) {
    if (!u || !u.pkey) continue;
    const acc = escByPkey.get(u.pkey) || { escalated: false, to: null, served: 0 };
    if (u.escalated === true) acc.escalated = true;
    if (u.escalationTo) acc.to = u.escalationTo;
    acc.served += 1;
    escByPkey.set(u.pkey, acc);
  }
  const evByPkey = new Map((evidence || []).filter((e) => e && e.pkey).map((e) => [e.pkey, e]));

  const rref = shadow.filter((r) => r && (r.arm === 'r1-amb' || r.arm === 'r3-rescue'));
  const d4 = shadow.filter((r) => r && r.arm === 'd4-critical');
  const lat = rref.map((r) => Number(r.latencyMs)).filter((n) => Number.isFinite(n) && n > 0);

  // 臂级对账:救回(applied)轮 → pkey 后续 P2 上梯 ⇒ 该轮原档确实不够(救回方向正确);
  // 未救回行 + 词法低档 → 后续上梯 ⇒ 漏救(决策票投了高档但没过闸,或词法没触发臂)。
  const byArm = {};
  for (const r of rref) {
    const a = byArm[r.arm] || (byArm[r.arm] = { rows: 0, applied: 0, cached: 0, appliedEscalatedLater: 0 });
    a.rows += 1;
    if (r.applied) a.applied += 1;
    if (r.cached) a.cached += 1;
    if (r.applied) {
      const e = escByPkey.get(r.pkey);
      if (e && e.escalated) a.appliedEscalatedLater += 1; // 救回后同 pkey 仍上梯 = 该轮强度被低估(救不到位或救错向)
    }
  }
  // D6 影子:R3 服务轮 + 证据达标(errCount≥2 或死循环)——若 D6 开将上 R4
  // (2026-11-09 夜审 S2-F3):proxy-usage 实际写 loopRepeat/loopFired(modelRouteProxy.mjs),
  // 旧读 u.loopStreak 字段不存在,死循环证据恒 false。
  const d6Candidates = usage.filter((u) => u && u.tier === 'R3' && (Number(u.errCount) >= 2 || Number(u.loopRepeat) >= 4 || Number(u.loopFired) >= 2 || (u.escalated === true && u.escalationFrom === 'R3')));

  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const lines = [
    '# R-ref 影子对账报告(D5/D6 验收通道;只读,不改路由)',
    '',
    `> 生成:${now.toISOString()}|影子行:${shadow.length}(臂 ${rref.length}/D4 ${d4.length})|账本轮:${usage.length}|tier-evidence:${evidence.length}`,
    '> 口径:救回轮同 pkey 后续 P2 再上梯 = 该轮被低估(方向对但幅度不足或救错);干净完成 = 救对。',
    '> D6 影子 = R3 服务轮中报错≥2/死循环证据计数(若 D6 开将上 R4),**不真上梯**;解锁门槛见 decision-upgrade-plan-2.md §3 D5/D6。',
    '',
    '## 1. 臂级对账',
    '',
    '| 臂 | 影子行 | 救回(applied) | 缓存命中 | 救回后仍上梯(低估) | 低估占比 |',
    '|---|---|---|---|---|---|',
    ...Object.entries(byArm).map(([arm, a]) => `| ${arm} | ${a.rows} | ${a.applied} | ${a.cached} | ${a.appliedEscalatedLater} | ${pct(a.appliedEscalatedLater, a.applied)}% |`),
    ...(Object.keys(byArm).length ? [] : ['| (无臂级行) | — | — | — | — | — |']),
    '',
    '## 2. D4 临界影子(三类 flags 的决策票 vs 词法)',
    '',
    '| flag | 行数 | 决策票=高档(rTier>l1Tier) | 决策票=同档 | 决策票=低档 | 命中率(缓存) |',
    '|---|---|---|---|---|---|',
    ...(Object.entries(d4.reduce((m, r) => {
      for (const f of Object.keys(r.flags || {})) {
        const s = m[f] || (m[f] = { n: 0, up: 0, same: 0, down: 0, cached: 0 });
        s.n += 1;
        const rank = { R1: 1, R2: 2, R3: 3, R4: 4 };
        const d = (rank[r.rTier] || 0) - (rank[r.l1Tier] || 0);
        if (d > 0) s.up += 1; else if (d === 0) s.same += 1; else s.down += 1;
        if (r.cached) s.cached += 1;
      }
      return m;
    }, {}))).map(([f, s]) => `| ${f} | ${s.n} | ${s.up} | ${s.same} | ${s.down} | ${pct(s.cached, s.n)}% |`),
    ...(d4.length ? [] : ['| (暂无 d4-critical 影子行——临界轮尚未出现或判定不可用) | | | | | |']),
    '',
    '## 3. D6 影子(R3 服务轮证据达标计数)',
    '',
    `R3 轮中报错≥2/死循环/从 R3 上梯事件:**${d6Candidates.length} 次**${d6Candidates.length ? `(pkey:${[...new Set(d6Candidates.map((u) => u.pkey).filter(Boolean))].slice(0, 8).join(', ')})` : ''}`,
    '',
    `## 4. 健康面`,
    '',
    `- 判定延迟 p95:${p95(lat) ?? '—'} ms(样本 ${lat.length});`,
    `- 臂级缓存命中率:${pct(rref.filter((r) => r.cached).length, rref.length)}%;`,
    `- tier-evidence 覆盖 pkey:${evByPkey.size}。`,
    '',
  ].join('\n');
  const out = path.join(dataDir, 'routing', 'rref-audit-report.md');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, lines);
  } catch { /* 报告写不上不影响结论 */ }
  return { report: out, shadowRows: shadow.length, d4Rows: d4.length, arms: byArm, d6Candidates: d6Candidates.length, latencyP95: p95(lat) };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  const i = process.argv.indexOf('--data');
  const dir = i > 0 ? process.argv[i + 1] : DATA_DIR;
  const r = auditRRef({ dataDir: dir });
  console.log(JSON.stringify({ report: r.report, shadowRows: r.shadowRows, d4Rows: r.d4Rows, d6Candidates: r.d6Candidates, latencyP95: r.latencyP95 }, null, 1));
}
