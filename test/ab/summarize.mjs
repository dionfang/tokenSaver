#!/usr/bin/env node
/**
 * A/B 汇总。默认要求每个任务 A/B 各一条、提示词哈希一致、模型一致、任务全通过；
 * 任一不满足就标记“不可作为收益结论”，但仍打印表格方便排查。
 *
 * 用法: node summarize.mjs [--results data/ab/results.jsonl] [--partial] [--json] [--out 文件]
 * 退出码: 0 = 可比较;1 = 数据不完整/不可比较。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);
const resultsPath = path.resolve(opt('--results', path.join(root, 'data/ab/results.jsonl')));
if (!fs.existsSync(resultsPath)) {
  console.error(`[err] 找不到 ${resultsPath}`);
  process.exit(1);
}
const rows = fs.readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
const taskIds = JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf8')).tasks.map(t => t.id);

const issues = [];
const pairs = [];
for (const id of taskIds) {
  const hits = rows.filter(r => r.task === id);
  if (!hits.length) {
    if (!flag('--partial')) issues.push(`${id}: 没有任何记录`);
    continue;
  }
  const a = hits.filter(r => r.cond === 'A');
  const b = hits.filter(r => r.cond === 'B');
  if (a.length !== 1 || b.length !== 1) {
    issues.push(`${id}: A/B 记录数 ${a.length}/${b.length}，应各 1 条`);
    continue;
  }
  const A = a[0], B = b[0];
  if (A.promptSha !== B.promptSha) issues.push(`${id}: 提示词哈希不一致(${A.promptSha} vs ${B.promptSha})`);
  const am = (A.models || []).join(','), bm = (B.models || []).join(',');
  if (am && bm && am !== bm) issues.push(`${id}: 模型不一致(${am} vs ${bm})`);
  if (!A.pass || !B.pass) issues.push(`${id}: 未全通过(A=${A.pass ? 'pass' : 'fail'} B=${B.pass ? 'pass' : 'fail'})`);
  pairs.push({ id, A, B });
}

if (!pairs.length) {
  console.error('[err] 没有可比较的 A/B 配对');
  process.exit(1);
}

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const sum = (arr) => arr.reduce((s, n) => s + n, 0);
const perReq = (r) => (r.requests ? r.output / r.requests : 0);
const diffs = pairs.map(p => p.B.output - p.A.output);
const mean = sum(diffs) / diffs.length;
const sd = diffs.length > 1
  ? Math.sqrt(sum(diffs.map(d => (d - mean) ** 2)) / (diffs.length - 1))
  : 0;
const t = sd > 0 ? mean / (sd / Math.sqrt(diffs.length)) : null;
const allTool = pairs.every(p => Number.isFinite(p.A.toolTokens) && Number.isFinite(p.B.toolTokens));

const totals = {
  tasks: pairs.length,
  outputA: sum(pairs.map(p => p.A.output)),
  outputB: sum(pairs.map(p => p.B.output)),
  medianA: median(pairs.map(p => p.A.output)),
  medianB: median(pairs.map(p => p.B.output)),
  perReqA: median(pairs.map(p => perReq(p.A))),
  perReqB: median(pairs.map(p => perReq(p.B))),
  meanDiff: mean,
  sdDiff: sd,
  t,
  toolA: allTool ? sum(pairs.map(p => p.A.toolTokens)) : null,
  toolB: allTool ? sum(pairs.map(p => p.B.toolTokens)) : null,
  requestsA: sum(pairs.map(p => p.A.requests)),
  requestsB: sum(pairs.map(p => p.B.requests)),
  passA: pairs.filter(p => p.A.pass).length,
  passB: pairs.filter(p => p.B.pass).length,
};
const valid = issues.length === 0;

const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d).replace(/\.0$/, '') : '—');
const nf = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const mark = (b) => (b ? 'pass' : 'fail');

const lines = [
  '# Ponytail A/B 汇总',
  '',
  `- 数据:${resultsPath}`,
  `- 任务数:${pairs.length}/${taskIds.length}`,
  `- 判定:${valid ? '可比较' : '不可作为收益结论'}`,
  ...(issues.length ? ['', '## 问题', '', ...issues.map(x => `- ${x}`)] : []),
  '',
  '| 任务 | A output | B output | B−A | A out/req | B out/req | A | B |',
  '|---|---:|---:|---:|---:|---:|---|---|',
  ...pairs.map(p => `| ${p.id} | ${nf(p.A.output)} | ${nf(p.B.output)} | ${p.B.output - p.A.output > 0 ? '+' : ''}${nf(p.B.output - p.A.output)} | ${f(perReq(p.A))} | ${f(perReq(p.B))} | ${mark(p.A.pass)} | ${mark(p.B.pass)} |`),
  '',
  '## 合计',
  '',
  `- output 合计:A ${nf(totals.outputA)},B ${nf(totals.outputB)}(${totals.outputA ? ((totals.outputB - totals.outputA) / totals.outputA * 100).toFixed(1) : '—'}%)`,
  `- output 中位:A ${nf(totals.medianA)},B ${nf(totals.medianB)}`,
  `- output/请求中位:A ${f(totals.perReqA)},B ${f(totals.perReqB)}`,
  `- 每任务差均值 ${f(totals.meanDiff)},标准差 ${f(totals.sdDiff)},配对 t=${totals.t == null ? '—' : f(totals.t, 2)}`,
  `- 请求数:A ${nf(totals.requestsA)},B ${nf(totals.requestsB)};通过:A ${totals.passA}/${pairs.length},B ${totals.passB}/${pairs.length}`,
  ...(allTool ? [`- Agent 工具总 tokens(含输入):A ${nf(totals.toolA)},B ${nf(totals.toolB)}`] : []),
  '',
  '> 说明:total output 包含任务多走的工具轮次，是任务总成本;out/req 用于诊断。',
  '> 5 个任务只能排除大效应;要检测 <10% 差异，需每组 30+ 次并看区间。',
].join('\n');

const asJson = flag('--json');
const text = asJson ? JSON.stringify({ valid, issues, totals, tasks: pairs.map(p => ({ id: p.id, A: p.A, B: p.B })) }, null, 2) : lines;
const out = opt('--out');
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, text.endsWith('\n') ? text : text + '\n');
  console.log(`[ok] 已写入 ${out}`);
} else {
  process.stdout.write(text + '\n');
}
process.exitCode = valid ? 0 : 1;
