/**
 * Qoder 本地锚点诊断(只读,不改节约主口径):transcript 里的 compact_boundary 是唯一真实 token 记录。
 * 三项用途:①preTokens/context_usage_ratio 反推上下文窗口;②首压缩点校验本地 tokenizer 计数偏差;
 * ③按压缩边界封顶重算"会话累计",给出与账本(watermarks)的偏差与上限检查。
 * CLI:node code-index/qoder-insight.mjs [--json] [--out data/ab/qoder-ab.json] [--home <dir>] [--data-dir <dir>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { readWatermarks, countInputTokensPair } from './modelStatus.mjs';
import { listTranscriptFiles, qoderUserDirLike } from './agent-usage.mjs';

/** 读一个项目 transcript(一行一 JSON,坏行跳过)。 */
export function readTranscript(fp) {
  let lines;
  try { lines = fs.readFileSync(fp, 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && typeof j === 'object') out.push(j); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 上下文窗口 ≈ preTokens / 最后一次请求的 context_usage_ratio。
 * 两个压缩点各给一个样本;ratio 取自压缩前最近的请求(preTokens 在其后量,窗口略偏大)。
 */
export function estimateContextWindow(records) {
  const samples = [];
  let lastRatio = null;
  for (const r of records) {
    const ratio = Number(r?.message?.usage?.context_usage_ratio);
    if (r?.message?.usage && Number.isFinite(ratio) && ratio > 0) lastRatio = ratio;
    if (r?.type !== 'system' || r?.subtype !== 'compact_boundary') continue;
    const pre = Number(r?.compactMetadata?.preTokens);
    if (!(pre > 0) || !(lastRatio > 0)) continue;
    samples.push({
      ts: r.timestamp,
      preTokens: pre,
      postTokens: Number(r?.compactMetadata?.postTokens) || 0,
      ratio: lastRatio,
      window: Math.round(pre / lastRatio),
    });
  }
  const sorted = samples.map((s) => s.window).sort((a, b) => a - b);
  const window = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  return { samples, window };
}

/**
 * 本地 tokenizer 校准:只取第一个压缩点(其前 transcript 是完整上下文样本)。
 * counter 可注入以便测试;默认用本地 qwen 分词。
 */
export async function calibrateTokenizer(records, { boundaryIndex = 0, counter = null } = {}) {
  const boundaries = records.filter(
    (r) => r?.type === 'system' && r?.subtype === 'compact_boundary' && Number(r?.compactMetadata?.preTokens) > 0,
  );
  const b = boundaries[boundaryIndex];
  if (!b) return null;
  const cut = Date.parse(typeof b.timestamp === 'string' ? b.timestamp : '');
  if (!Number.isFinite(cut)) return null;
  const parts = [];
  for (const r of records) {
    const ts = Date.parse(typeof r?.timestamp === 'string' ? r.timestamp : '');
    if (Number.isFinite(ts) && ts >= cut) break;
    const c = r?.message?.content;
    if (c != null) parts.push(typeof c === 'string' ? c : JSON.stringify(c));
  }
  const text = parts.join('\n');
  if (!text) return null;
  const count = counter || (async (t) => (await countInputTokensPair(t, '')).original);
  const localTokens = Math.round(Number(await count(text)) || 0);
  const hostPreTokens = Number(b.compactMetadata.preTokens);
  return {
    ts: b.timestamp,
    hostPreTokens,
    postTokens: Number(b.compactMetadata.postTokens) || 0,
    messages: parts.length,
    localTokens,
    factor: localTokens > 0 ? hostPreTokens / localTokens : null,
  };
}

/** 事件之后、且在该事件后第一次压缩之前的请求数(压缩会把已省下的上下文一并清掉)。 */
export function cappedIterationsAfter(requestTimes, eventAt, boundaries) {
  const at = Number(eventAt);
  if (!Number.isFinite(at)) return 0;
  const list = Array.isArray(boundaries) ? boundaries : [];
  const next = list.filter((t) => Number.isFinite(t) && t > at).sort((a, b) => a - b)[0] ?? Infinity;
  let n = 0;
  for (const t of requestTimes) if (Number(t) > at && Number(t) < next) n += 1;
  return n;
}

/**
 * 单会话对账:账本(watermarks)累计 vs 压缩封顶应为、未入账投影、上限检查。
 * 只读,不写账本。tokens 口径与 computeAccumulation 一致(来自水位里的单次节约)。
 */
export function analyzeSession({ session, records, watermarks = {}, window = null }) {
  const requests = [];
  for (const r of records) {
    const u = r?.message?.usage;
    if (!u || !(Number(u.credits) > 0)) continue;
    const ts = Date.parse(typeof r.timestamp === 'string' ? r.timestamp : '');
    if (!Number.isFinite(ts)) continue;
    requests.push({ ts, ratio: Number(u.context_usage_ratio) || 0, credits: Number(u.credits) || 0 });
  }
  requests.sort((a, b) => a.ts - b.ts);
  const requestTimes = requests.map((r) => r.ts);
  const boundaries = records
    .filter((r) => r?.type === 'system' && r?.subtype === 'compact_boundary')
    .map((r) => Date.parse(typeof r.timestamp === 'string' ? r.timestamp : ''))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const rows = [];
  let entryOnce = 0;
  let ledgerAccumulated = 0;
  let cappedAccumulated = 0;
  let overcounted = 0;
  let pendingUncapped = 0;
  let pendingCapped = 0;
  for (const [key, v] of Object.entries(watermarks || {})) {
    if (!v || v.session !== session || v.voided) continue;
    const at = Number(v.at);
    if (!Number.isFinite(at)) continue;
    const tokens = Math.max(0, Math.round(Number(v.tokens) || 0));
    const ledgerCounted = Number(v.counted) || 0;
    const allCount = requestTimes.filter((t) => t > at).length;
    const cappedCount = cappedIterationsAfter(requestTimes, at, boundaries);
    const ledgerRow = tokens * ledgerCounted;
    const cappedRow = tokens * cappedCount;
    rows.push({
      key,
      kind: v.kind || null,
      at,
      tokens,
      ledgerCounted,
      cappedCount,
      allCount,
      ledgerAccumulated: ledgerRow,
      cappedAccumulated: cappedRow,
    });
    entryOnce += tokens;
    ledgerAccumulated += ledgerRow;
    cappedAccumulated += cappedRow;
    overcounted += Math.max(0, ledgerRow - cappedRow);
    pendingUncapped += Math.max(0, (allCount - ledgerCounted) * tokens);
    pendingCapped += Math.max(0, (cappedCount - ledgerCounted) * tokens);
  }

  const upper = window ? Math.round(requests.reduce((s, r) => s + Math.max(0, r.ratio) * window, 0)) : null;
  const ledgerTotal = entryOnce + ledgerAccumulated;
  return {
    session,
    requests: requests.length,
    credits: Number(requests.reduce((s, r) => s + r.credits, 0).toFixed(6)),
    boundaries,
    window,
    entryOnce,
    ledgerAccumulated,
    cappedAccumulated,
    ledgerTotal,
    cappedTotal: entryOnce + cappedAccumulated,
    overcounted,
    pendingUncapped,
    pendingCapped,
    potentialOvercount: Math.max(0, pendingUncapped - pendingCapped),
    upper,
    withinUpperBound: upper == null ? null : ledgerTotal <= upper,
    rows,
  };
}

/** 组合入口:扫描全部 transcript,合并窗口样本,逐会话对账(只读)。 */
export async function inspectQoder({ home = os.homedir(), dataDir = DATA_DIR } = {}) {
  const qdir = qoderUserDirLike(home);
  const transcripts = listTranscriptFiles(path.join(qdir, 'projects'));
  const watermarks = readWatermarks(path.join(dataDir, 'read-guard', 'watermarks.json'));
  const loaded = transcripts.map((fp) => ({ fp, session: path.basename(fp, '.jsonl'), records: readTranscript(fp) }));
  const windowSamples = loaded.flatMap((x) => estimateContextWindow(x.records).samples);
  const windows = windowSamples.map((s) => s.window).sort((a, b) => a - b);
  const window = windows.length ? windows[Math.floor(windows.length / 2)] : null;
  const sessions = [];
  for (const x of loaded) {
    sessions.push({
      file: x.fp,
      calibration: await calibrateTokenizer(x.records),
      analysis: analyzeSession({ session: x.session, records: x.records, watermarks, window }),
    });
  }
  return { window: { samples: windowSamples, value: window }, sessions };
}

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function render(report) {
  const out = ['# Qoder 本地锚点诊断(只读;不改节约主口径)', ''];
  const w = report.window;
  if (w.value) {
    const samples = w.samples.map((s) => fmt(s.window)).join(' / ');
    out.push(`窗口(preTokens / ratio):${fmt(w.value)}(样本 ${w.samples.length}:${samples})`);
  } else out.push('窗口:无压缩边界样本');
  for (const s of report.sessions) {
    const a = s.analysis;
    if (!a.rows.length && !a.requests) continue;
    const cal = s.calibration;
    out.push('', `会话 ${a.session}:请求 ${a.requests} · credits ${a.credits.toFixed(3)}`);
    if (cal) {
      const pct = cal.factor ? ((cal.factor - 1) * 100).toFixed(1) : '—';
      out.push(`  tokenizer 校准:host ${fmt(cal.hostPreTokens)} / local ${fmt(cal.localTokens)} = ${cal.factor ? cal.factor.toFixed(3) : '—'}(本地偏差 ${pct}%,含系统提示与工具定义)`);
    }
    out.push(`  入口一次 ${fmt(a.entryOnce)} · 账本累计 ${fmt(a.ledgerAccumulated)} · 账本合计 ${fmt(a.ledgerTotal)}`);
    out.push(`  压缩封顶应为 ${fmt(a.cappedAccumulated)}(合计 ${fmt(a.cappedTotal)});已多计 ${fmt(a.overcounted)}`);
    out.push(`  未入账投影:不封顶 +${fmt(a.pendingUncapped)} / 封顶 +${fmt(a.pendingCapped)}(潜在多计 ${fmt(a.potentialOvercount)})`);
    if (a.upper != null) {
      const pct = a.upper ? ((a.ledgerTotal / a.upper) * 100).toFixed(1) : '—';
      out.push(`  上限校验:实时上下文总量 ${fmt(a.upper)},账本占 ${pct}% ${a.withinUpperBound ? '✓' : '✗ 超上限'}`);
    }
  }
  return out.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
  };
  const home = opt('--home', os.homedir());
  const dataDir = opt('--data-dir', DATA_DIR);
  const report = await inspectQoder({ home, dataDir });
  const dest = opt('--out', null);
  if (dest) {
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(report, null, 2));
  }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(render(report));
    if (dest) console.log(`\n[ok] ${dest}`);
  }
}

const self = fileURLToPath(import.meta.url);
const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self);
if (directRun) main().catch((e) => { console.error('[err]', e.message); process.exit(1); });
