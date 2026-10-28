#!/usr/bin/env node
/**
 * 输出端用量报表:读 ZCode 的 model-io rollout(每个模型请求一行)，
 * 按会话汇总 input/output/cache tokens，并支持 A/B 两组对比。
 * 只读:不联网，不写 data/session-savings.json，不改任何索引状态。
 *
 * 用法:
 *   node usageReport.mjs --dir <rollout 目录或单个 jsonl> [--since ISO] [--until ISO] [--all-sources] [--json] [--out 文件]
 *   node usageReport.mjs --a <A 目录> --b <B 目录> [同上] [--label-a A] [--label-b B]
 *
 * 默认只统计 querySource=main_turn(排除会话标题生成等辅助请求);--all-sources 全算。
 * error 非空或 usage 为空的记录不计数;同一 requestId 只算一次。
 * outputTokens 按客户端/厂商口径，通常已含 think;本脚本不做拆分，也不把 input+output 当成本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function timeOf(v) {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function median(arr) {
  const a = arr.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function sum(arr) {
  return arr.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
}

/** 解析一个 rollout 文件的文本;坏行、非 model_io、失败/空 usage 跳过。 */
export function parseRolloutLines(text, file = '') {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j?.type !== 'model_io' || j.error) continue;
    const u = j.response?.usage;
    if (!u) continue;
    const output = num(u.outputTokens);
    const input = num(u.inputTokens);
    if (!output && !input) continue;
    out.push({
      sessionId: String(j.sessionId || file || 'unknown'),
      requestId: String(j.requestId || `${file}:${out.length}`),
      turnId: String(j.turnId || ''),
      querySource: String(j.querySource || ''),
      model: typeof j.model === 'string' ? j.model : String(j.model?.modelId || ''),
      provider: typeof j.model === 'string' ? '' : String(j.model?.providerId || ''),
      startedAt: timeOf(j.startedAt),
      completedAt: timeOf(j.completedAt),
      durationMs: num(j.durationMs),
      input,
      output,
      total: num(u.totalTokens) || input + output,
      cacheRead: num(u.cacheReadTokens),
      cacheWrite: num(u.cacheWriteTokens),
    });
  }
  return out;
}

function filesUnder(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  return fs.readdirSync(p)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .map(f => path.join(p, f));
}

/** 读目录(或单个文件)，按时间窗和来源过滤。 */
export function loadRollout(dir, { since = null, until = null, allSources = false } = {}) {
  const records = [];
  for (const f of filesUnder(dir)) {
    records.push(...parseRolloutLines(fs.readFileSync(f, 'utf8'), f));
  }
  return filterRecords(records, { since, until, allSources });
}

/** 来源过滤 + 时间窗 + requestId 去重(先到先得)。 */
export function filterRecords(records, { since = null, until = null, allSources = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    if (!allSources && r.querySource !== 'main_turn') continue;
    if (since != null && !(r.startedAt != null && r.startedAt >= since)) continue;
    if (until != null && !(r.startedAt != null && r.startedAt <= until)) continue;
    if (seen.has(r.requestId)) continue;
    seen.add(r.requestId);
    out.push(r);
  }
  return out;
}

/** 按会话汇总,并给出组的合计与中位数。 */
export function aggregate(records) {
  const bySession = new Map();
  const sources = {};
  for (const r of records) {
    sources[r.querySource] = (sources[r.querySource] || 0) + 1;
    const s = bySession.get(r.sessionId) || {
      sessionId: r.sessionId,
      models: new Set(),
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      durationMs: 0,
      firstAt: null,
      lastAt: null,
    };
    s.requests++;
    s.input += r.input;
    s.output += r.output;
    s.cacheRead += r.cacheRead;
    s.cacheWrite += r.cacheWrite;
    s.durationMs += r.durationMs;
    if (r.model) s.models.add(r.model);
    if (r.startedAt != null) s.firstAt = s.firstAt == null ? r.startedAt : Math.min(s.firstAt, r.startedAt);
    const end = r.completedAt ?? r.startedAt;
    if (end != null) s.lastAt = s.lastAt == null ? end : Math.max(s.lastAt, end);
    bySession.set(r.sessionId, s);
  }

  const sessions = [...bySession.values()]
    .map(s => ({ ...s, models: [...s.models], model: [...s.models].join(',') }))
    .sort((a, b) => b.output - a.output);

  const outputs = records.map(r => r.output);
  const inputs = records.map(r => r.input);
  const inputTotal = sum(inputs);
  const cacheReadTotal = sum(records.map(r => r.cacheRead));

  return {
    sessions,
    totals: {
      sessions: sessions.length,
      requests: records.length,
      inputTotal,
      outputTotal: sum(outputs),
      cacheReadTotal,
      cacheWriteTotal: sum(records.map(r => r.cacheWrite)),
      durationMs: sum(records.map(r => r.durationMs)),
      outputPerRequestMedian: median(outputs),
      outputPerRequestMax: outputs.length ? Math.max(...outputs) : 0,
      outputPerSessionMedian: median(sessions.map(s => s.output)),
      inputPerRequestMedian: median(inputs),
      cacheReadRatio: inputTotal > 0 ? cacheReadTotal / inputTotal : 0,
      models: [...new Set(records.map(r => r.model).filter(Boolean))],
      sources,
    },
  };
}

function delta(b, a) {
  return a > 0 ? (b - a) / a : null;
}

/** A/B 对比:只算差值,不推断因果。 */
export function compare(a, b) {
  const metrics = [
    'outputPerRequestMedian',
    'outputTotal',
    'outputPerSessionMedian',
    'inputPerRequestMedian',
    'requests',
    'sessions',
    'cacheReadRatio',
  ];
  const rows = metrics.map(k => ({
    metric: k,
    a: a.totals[k],
    b: b.totals[k],
    delta: delta(b.totals[k], a.totals[k]),
  }));
  const warnings = [];
  const am = a.totals.models.join(',');
  const bm = b.totals.models.join(',');
  if (am && bm && am !== bm) warnings.push(`两组模型不一致: A=${am} B=${bm}`);
  if (a.totals.requests < 20 || b.totals.requests < 20) {
    warnings.push(`每组请求数 ${a.totals.requests}/${b.totals.requests} <20，样本偏小，结论仅供参考`);
  }
  return { rows, warnings };
}

function nfmt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

function pfmt(v) {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function dfmt(v) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
}

function sessionTable(title, summary) {
  const lines = [
    `## ${title}`,
    '',
    '| 会话 | 模型 | 请求 | 输入 | 输出 | 缓存读 | 输出/请求 |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const s of summary.sessions) {
    lines.push(`| ${s.sessionId} | ${s.model || '—'} | ${s.requests} | ${nfmt(s.input)} | ${nfmt(s.output)} | ${nfmt(s.cacheRead)} | ${nfmt(s.requests ? s.output / s.requests : 0)} |`);
  }
  return lines;
}

function summaryTable(title, summary) {
  const t = summary.totals;
  return [
    `## ${title}`,
    '',
    '| 指标 | 值 |',
    '|---|---:|',
    `| 会话数 | ${nfmt(t.sessions)} |`,
    `| 请求数 | ${nfmt(t.requests)} |`,
    `| 输出 tokens 合计 | ${nfmt(t.outputTotal)} |`,
    `| 输出 tokens / 请求(中位) | ${nfmt(t.outputPerRequestMedian)} |`,
    `| 输出 tokens / 请求(最大) | ${nfmt(t.outputPerRequestMax)} |`,
    `| 输出 tokens / 会话(中位) | ${nfmt(t.outputPerSessionMedian)} |`,
    `| 输入 tokens 合计 | ${nfmt(t.inputTotal)} |`,
    `| 输入 tokens / 请求(中位) | ${nfmt(t.inputPerRequestMedian)} |`,
    `| 缓存读 tokens | ${nfmt(t.cacheReadTotal)}（占输入 ${pfmt(t.cacheReadRatio)}） |`,
    `| 模型 | ${t.models.join(', ') || '—'} |`,
    `| 来源 | ${Object.entries(t.sources).map(([k, v]) => `${k || '—'}:${v}`).join(' ') || '—'} |`,
  ];
}

function header(a, b) {
  return [
    '# 输出端用量报表',
    '',
    '> 数据源:ZCode `model-io` rollout。只统计成功请求；`outputTokens` 按客户端口径，通常含 think。',
    '',
  ];
}

function renderSingle(summary, dir) {
  return [
    ...header(),
    `- 目录:${dir}`,
    '',
    ...summaryTable('汇总', summary),
    '',
    ...sessionTable('会话明细', summary),
  ].join('\n');
}

function renderAB(labelA, labelB, a, b, dirA, dirB) {
  const cmp = compare(a, b);
  const name = {
    outputPerRequestMedian: '输出 tokens / 请求(中位)',
    outputTotal: '输出 tokens 合计',
    outputPerSessionMedian: '输出 tokens / 会话(中位)',
    inputPerRequestMedian: '输入 tokens / 请求(中位)',
    requests: '请求数',
    sessions: '会话数',
    cacheReadRatio: '缓存读占输入',
  };
  const rows = cmp.rows.map(r => {
    const isRatio = r.metric === 'cacheReadRatio';
    const fmt = isRatio ? pfmt : nfmt;
    return `| ${name[r.metric]} | ${fmt(r.a)} | ${fmt(r.b)} | ${dfmt(r.delta)} |`;
  });
  return [
    ...header(),
    `- ${labelA}:${dirA}`,
    `- ${labelB}:${dirB}`,
    '',
    '## A/B 对比',
    '',
    `| 指标 | ${labelA} | ${labelB} | 变化(B vs A) |`,
    '|---|---:|---:|---:|',
    ...rows,
    '',
    ...(cmp.warnings.length ? ['> 注意:' + cmp.warnings.join('；'), ''] : []),
    ...summaryTable(`${labelA} 汇总`, a),
    '',
    ...summaryTable(`${labelB} 汇总`, b),
    '',
    ...sessionTable(`${labelA} 会话明细`, a),
    '',
    ...sessionTable(`${labelB} 会话明细`, b),
  ].join('\n');
}

function usage() {
  console.error(`用法:
  node usageReport.mjs --dir <rollout 目录或 jsonl> [--since ISO] [--until ISO] [--all-sources] [--json] [--out 文件]
  node usageReport.mjs --a <A 目录> --b <B 目录> [--label-a A] [--label-b B] [同上]

默认只统计 querySource=main_turn;--all-sources 连标题生成等辅助请求一起算。
A/B 目录里放本次实验的 model-io-session_*.jsonl 副本，不要混入其他会话。`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) main();

function main() {
const has = f => argv.includes(f);
function opt(name, def = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
function timeArg(name) {
  const v = opt(name);
  if (!v) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) {
    console.error(`[err] ${name} 不是合法时间: ${v}`);
    process.exit(1);
  }
  return t;
}
if (has('--help') || has('-h')) usage();

const since = timeArg('--since');
const until = timeArg('--until');
const allSources = has('--all-sources');
const asJson = has('--json');
const out = opt('--out');
const dir = opt('--dir');
const dirA = opt('--a');
const dirB = opt('--b');

if (!dir && !(dirA && dirB)) usage();
for (const p of [dir, dirA, dirB].filter(Boolean)) {
  if (!fs.existsSync(p)) {
    console.error(`[err] 路径不存在: ${p}`);
    process.exit(1);
  }
}

const opts = { since, until, allSources };
let text;
if (dirA && dirB) {
  const labelA = opt('--label-a', 'A');
  const labelB = opt('--label-b', 'B');
  const a = aggregate(loadRollout(dirA, opts));
  const b = aggregate(loadRollout(dirB, opts));
  if (asJson) text = JSON.stringify({ groups: { [labelA]: a, [labelB]: b }, compare: compare(a, b) }, null, 2);
  else text = renderAB(labelA, labelB, a, b, dirA, dirB);
} else {
  const summary = aggregate(loadRollout(dir, opts));
  if (asJson) text = JSON.stringify(summary, null, 2);
  else text = renderSingle(summary, dir);
}

if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, text.endsWith('\n') ? text : text + '\n');
  console.log(`[ok] 已写入 ${out}`);
} else {
  process.stdout.write(text + '\n');
}
}
