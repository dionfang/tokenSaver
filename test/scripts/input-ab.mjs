#!/usr/bin/env node
/**
 * 输入端反事实 A/B:A=无拦截反事实(回执处本应是文件全文,且随历史在后续每个请求重复计费),
 * B=实际记录(回执进入历史)。从 ZCode model-io rollout 重放,量化 read-guard 拦截在
 * "会话累计"口径下的节约,与账本的"入口一次"记账( bytes/4,记一次)对照,给出口径偏差。
 * 只读磁盘与 rollout,不写 data/session-savings.json。
 *
 * 用法:
 *   node test/scripts/input-ab.mjs --selftest
 *   node test/scripts/input-ab.mjs --rollout <jsonl> [--rollout <jsonl>...] [--approx] [--json] [--out 文件]
 *   node test/scripts/input-ab.mjs --dir <rollout 目录> [...同上]
 *
 * 口径:输入 = usage.inputTokens(与 usageReport 一致,含 cacheRead 的提示词总量)。
 * 默认只统计 querySource=main_turn;--approx 用 bytes/4 估算,不加载 tokenizer。
 * 反事实只做一阶机械对照:回执 → 文件全文,历史未压缩期间逐请求累加;不模拟行为改变。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readReadEvents, attributeSearchEvents, accumulateReadEvents, readWatermarks, computeAccumulation } from '../../code-index/modelStatus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);
const APPROX = flag('--approx');

const READ_MARK = '超过全量 Read 上限';
const BASH_MARK = 'Bash 整读';

/** 每行一个 JSON;坏行跳过。 */
export function parseRows(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j?.type === 'model_io' && !j.error && j.response?.usage) out.push(j);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 从消息数组里抠出回执(tool_result 的嵌套 content 也要下钻;截取 code-index: ... 即放行。 的有界段)。 */
export function receiptsOf(msgs) {
  const out = [];
  const texts = [];
  const walk = (v) => {
    if (typeof v === 'string') { texts.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    if (typeof v.text === 'string') texts.push(v.text);
    if (v.content != null) walk(v.content);
  };
  for (const m of Array.isArray(msgs) ? msgs : []) {
    // 拦截回执只会作为工具结果进入历史;assistant 消息(如编写夹具的 tool_use 入参)里的引用不算
    if (m?.role === 'assistant') continue;
    walk(m?.content);
  }
  for (const text of texts) {
    if (!text.includes(READ_MARK) && !text.includes(BASH_MARK)) continue;
    for (const cand of text.match(/code-index: [\s\S]{0,2000}?即放行。/g) || []) {
      const rec = parseReceipt(cand);
      if (rec) out.push({ rec, text: cand });
    }
  }
  return out;
}

/** 回执头一行带 文件路径/行数/KB;解析失败返回 null。行与 ( 之间无空格,逗号为全角。 */
export function parseReceipt(text) {
  const read = text.match(/code-index: (.+?) 共 (\d+) 行\(~(\d+) KB\),超过全量 Read 上限/);
  const bash = text.match(/code-index: Bash 整读 (.+?) 共 (\d+) 行\(~(\d+) KB\),超过全量读上限/);
  const m = read || bash;
  if (!m) return null;
  return { kind: read ? 'Read' : 'Bash', file: m[1], lines: Number(m[2]), kb: Number(m[3]) };
}

async function makeCounter() {
  if (APPROX) return { count: (s) => Math.ceil(Buffer.byteLength(String(s), 'utf8') / 4), exact: false };
  try {
    const { loadTokenizer } = createRequire(new URL('../../code-index/package.json', import.meta.url))('tokenizer-core');
    const cache = path.join(root, 'data', 'tokenizers');
    const tok = await loadTokenizer('qwen', cache);
    if (!tok) throw new Error('no tokenizer');
    return { count: (s) => (s ? tok.encode(String(s)).ids.length : 0), exact: true };
  } catch {
    return { count: (s) => Math.ceil(Buffer.byteLength(String(s), 'utf8') / 4), exact: false };
  }
}

function fileTokensOf(rec, count) {
  let content = null;
  let src = 'missing';
  try {
    content = fs.readFileSync(rec.file, 'utf8');
    src = 'disk';
  } catch { /* 文件已删或路径变 */
  }
  if (content != null) return { tokens: count(content), src };
  return { tokens: Math.ceil((rec.kb || 0) * 1024 / 4), src: 'receipt-estimate' };
}

/**
 * 重放一个 rollout:按 messageOffset 拼回历史,逐请求登记在场的回执实例。
 * 返回 { sessions: [{sessionId, rows:[{input,output,cacheRead,cfDelta}], events:[{sig,file,kind,fileTokens,receiptTokens,firstRow,affectedRows}]}] }
 */
export function replay(rows, count, { allSources = false } = {}) {
  const counted = rows.filter((j) => (allSources ? true : j.querySource === 'main_turn'));
  const history = [];
  // sig → {rec,text,instances:[{entryRow}]} ;同一回执每多出现一次算一个实例
  const known = new Map();
  const seqRows = [];

  // 与 extractive-ab 同约定:历史拼接用全部 model_io 行,统计口径只留 main_turn
  for (const j of rows) {
    const msgs = j.request?.messages;
    if (Array.isArray(msgs) && msgs.length) {
      const off = Number(j.request?.messageOffset ?? 0);
      history.length = Math.min(history.length, Math.max(0, off));
      history.push(...msgs);
    }
    if (!counted.includes(j)) continue;
    // 全历史扫描:每类回执文本出现几次(只认完整回执格式,源码里出现标记不算)
    const texts = receiptsOf(history);
    const counts = new Map();
    for (const { rec, text } of texts) {
      const sig = `${rec.kind}|${rec.file}`;
      if (!counts.has(sig)) counts.set(sig, { rec, text, n: 0 });
      counts.get(sig).n += 1;
    }
    for (const [sig, { rec, text, n }] of counts) {
      if (!known.has(sig)) known.set(sig, { rec, text, instances: [] });
      const k = known.get(sig);
      while (k.instances.length < n) k.instances.push({ entryRow: seqRows.length });
    }
    seqRows.push({
      input: Number(j.response?.usage?.inputTokens) || 0,
      output: Number(j.response?.usage?.outputTokens) || 0,
      cacheRead: Number(j.response?.usage?.cacheReadTokens) || 0,
      counts,
    });
  }

  // 每实例:受影响行 = entryRow 起仍在场的行;先算每实例的 file/receipt tokens
  const events = [];
  for (const [sig, k] of known) {
    for (let idx = 0; idx < k.instances.length; idx++) {
      const rec = k.rec || parseReceipt(k.text);
      const ft = rec ? fileTokensOf(rec, count) : { tokens: 0, src: 'unknown' };
      const receiptTokens = count(k.text);
      let affected = 0;
      for (let r = k.instances[idx].entryRow; r < seqRows.length; r++) {
        if ((seqRows[r].counts.get(sig)?.n || 0) > idx) affected += 1;
      }
      events.push({
        sig,
        kind: rec?.kind || '?',
        file: rec?.file || '(未解析)',
        lines: rec?.lines || 0,
        fileTokens: ft.tokens,
        fileSrc: ft.src,
        entryRow: k.instances[idx].entryRow,
        affectedRows: affected,
        receiptTokens,
      });
    }
  }

  // 每行反事实增量 = Σ 在场实例 (fileTokens − receiptTokens)
  const perRow = seqRows.map((row) => {
    let d = 0;
    for (const [sig, { n }] of row.counts) {
      const evs = events.filter((e) => e.sig === sig);
      for (let idx = 0; idx < n; idx++) d += (evs[idx]?.fileTokens || 0) - (evs[idx]?.receiptTokens || 0);
    }
    return { ...row, cfDelta: d };
  });

  return { rows: perRow, events };
}

function sumOf(arr, k) {
  return arr.reduce((s, r) => s + (r[k] || 0), 0);
}

function nfmt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

function renderSession(name, { rows, events }, exact) {
  const actual = sumOf(rows, 'input');
  const cf = actual + sumOf(rows, 'cfDelta');
  const entryOnce = sumOf(events, 'fileTokens');
  const lines = [
    `## ${name}`,
    '',
    `- 请求 ${rows.length} 个;拦截实例 ${events.length} 个(tokenizer: ${exact ? 'qwen 精确' : 'bytes/4 估算'})`,
    `- B=实际 输入合计 ${nfmt(actual)}`,
    `- A=反事实 输入合计 ${nfmt(cf)}`,
    `- 会话累计节约 ${nfmt(cf - actual)}(入口一次口径只记 ${nfmt(entryOnce)},放大 ${entryOnce ? ((cf - actual) / entryOnce).toFixed(1) : '—'} 倍)`,
    '',
    '| # | 类型 | 文件 | 行数 | 文件 tokens | 回执 tokens | 受影响请求 | 累计节约 | 文件来源 |',
    '|---|---|---|---:|---:|---:|---:|---:|---|',
  ];
  events.forEach((e, i) => {
    lines.push(`| ${i + 1} | ${e.kind} | ${e.file} | ${e.lines} | ${nfmt(e.fileTokens)} | ${nfmt(e.receiptTokens)} | ${e.affectedRows} | ${nfmt((e.fileTokens - e.receiptTokens) * e.affectedRows)} | ${e.fileSrc} |`);
  });
  return lines;
}

/** 会话累计口径报表:读当日事件(拦截+检索),按水位与 rollout 回放呈现入口一次 / 已入账 / 本次增量。 */
async function eventsReport() {
  const raw = readReadEvents();
  const events = attributeSearchEvents(raw);
  const watermarks = readWatermarks();
  const replay = accumulateReadEvents(events);
  const acc = computeAccumulation(events, watermarks);
  const replayByKey = new Map(replay.detail.map((d) => [`${d.kind}|${d.session}|${d.file}|${d.at}`, d]));
  const nfmt2 = (n) => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
  const label = { Read: '拦截', Bash: 'Bash拦截', Search: '检索', Rewrite: '改写' };
  const statusOf = (d) => d.voided ? 'voided(重发放行)' : d.unclaimed ? '无主(未认领)' : d.rolloutMissing ? 'rollout 已清(已入账保留)' : '已入账';
  const md = [
    '# 会话累计口径报表(水位化持久累计)',
    '',
    `> 当日事件 ${raw.length} 条。水位已持久化:已入账部分永久留在账本里,rollout 轮换后不回落;本次只补新增 iteration 的差额。`,
    '',
    '| # | 类型 | 对象 | 单次节约 | 已入账 iteration | 已入账累计 | 本次增量 | 状态 |',
    '|---|---|---|---:|---:|---:|---:|---|',
  ];
  const byKind = new Map();
  acc.detail.forEach((d, i) => {
    const kind = d.kind || '?';
    const k = byKind.get(kind) || { events: 0, entry: 0, accumulated: 0, pending: 0 };
    k.events += 1;
    k.entry += d.tokens;
    k.accumulated += d.accumulated || 0;
    k.pending += d.delta || 0;
    byKind.set(kind, k);
    const obj = String(d.file || '').split(/[\\\\/]/).pop();
    md.push(`| ${i + 1} | ${label[kind] || kind} | ${obj}${kind === 'Search' ? '(查询)' : ''} | ${nfmt2(d.tokens)} | ${d.newIterations ?? 0} | ${nfmt2(d.accumulated || 0)} | ${nfmt2(d.delta || 0)} | ${statusOf(d)} |`);
  });
  md.push('', '## 合计(按类型)', '', '| 类型 | 事件 | 入口一次 | 已入账累计 | 待入账增量 | 合计口径 |', '|---|---:|---:|---:|---:|---:|');
  const all = { events: 0, entry: 0, accumulated: 0, pending: 0 };
  for (const [kind, k] of byKind) {
    all.events += k.events;
    all.entry += k.entry;
    all.accumulated += k.accumulated;
    all.pending += k.pending;
    md.push(`| ${label[kind] || kind} | ${k.events} | ${nfmt2(k.entry)} | ${nfmt2(k.accumulated)} | ${nfmt2(k.pending)} | ${nfmt2(k.accumulated + k.pending)} |`);
  }
  md.push(`| 全部 | ${all.events} | ${nfmt2(all.entry)} | ${nfmt2(all.accumulated)} | ${nfmt2(all.pending)} | ${nfmt2(all.accumulated + all.pending)} |`, '');
  const dest = opt('--out', path.join(root, 'data', 'ab', 'input-ab-events.json'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ events: acc.detail, watermarks, totals: Object.fromEntries(byKind), generatedAt: new Date().toISOString() }, null, 2));
  console.log(md.join('\n'));
  console.log(`[ok] ${dest}`);
}

async function main() {
  if (flag('--selftest')) return selftest();
  if (flag('--events')) return eventsReport();

  const targets = [];
  const dir = opt('--dir');
  if (dir) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
      targets.push(path.join(dir, f));
    }
  }
  for (const r of argv.flatMap((a, i) => (a === '--rollout' ? [argv[i + 1]] : []))) {
    if (r) targets.push(path.resolve(r));
  }
  if (!targets.length) {
    console.error('用法:node test/scripts/input-ab.mjs --rollout <jsonl> [...] 或 --dir <目录> 或 --selftest');
    process.exit(1);
  }

  const { count, exact } = await makeCounter();
  const sessions = [];
  for (const f of targets) {
    const rows = parseRows(fs.readFileSync(f, 'utf8'));
    const r = replay(rows, count);
    if (!r.rows.length) continue;
    sessions.push({ name: path.basename(f), ...r });
  }
  if (!sessions.length) {
    console.error('[err] 没有可重放的请求行');
    process.exit(1);
  }

  const out = { tokenizer: exact ? 'qwen' : 'bytes/4', sessions: [] };
  const md = ['# 输入端反事实 A/B(会话累计 vs 入口一次)', ''];
  for (const s of sessions) {
    const actual = sumOf(s.rows, 'input');
    const cf = actual + sumOf(s.rows, 'cfDelta');
    out.sessions.push({
      name: s.name,
      requests: s.rows.length,
      actualInput: actual,
      counterfactualInput: cf,
      sessionSaving: cf - actual,
      entryOnce: sumOf(s.events, 'fileTokens'),
      events: s.events,
    });
    md.push(...renderSession(s.name, s, exact), '');
  }
  const tActual = out.sessions.reduce((a, s) => a + s.actualInput, 0);
  const tCf = out.sessions.reduce((a, s) => a + s.counterfactualInput, 0);
  const tEntry = out.sessions.reduce((a, s) => a + s.entryOnce, 0);
  out.totals = { actualInput: tActual, counterfactualInput: tCf, sessionSaving: tCf - tActual, entryOnce: tEntry };
  md.push(`## 合计`, '', `- 实际 ${nfmt(tActual)} vs 反事实 ${nfmt(tCf)};会话累计节约 ${nfmt(tCf - tActual)},入口一次只记 ${nfmt(tEntry)},口径放大 ${tEntry ? ((tCf - tActual) / tEntry).toFixed(1) : '—'} 倍`, '');

  const dest = opt('--out', path.join(root, 'data', 'ab', 'input-ab.json'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(md.join('\n'));
  console.log(`[ok] ${dest}`);
}

/** 合成 rollout 自检:已知回执、已知文件大小、含压缩截断,断言受影响行与节约数。 */
export async function selftest() {
  const assert = (await import('node:assert/strict')).default;
  const { count } = await makeCounter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'input-ab-'));
  const probe = path.join(dir, 'probe.txt');
  fs.writeFileSync(probe, 'x'.repeat(4000)); // approx: 1000 tokens
  const R = (msg) => `code-index: ${probe} 共 100 行(~4 KB),超过全量 Read 上限 500 行(宽限至 625 行)。不要整文件 Read。先检索 \`node search.mjs\` <符号或关键词> --k 5(命中的 file:起-止即大纲),再按该区间用 Read 的 offset/limit 精读。若确实需要全文,5 分钟内对同一文件再发一次同样的全量 Read 即放行。`;
  const row = (input, msgs, offset) => JSON.stringify({
    type: 'model_io', querySource: 'main_turn', sessionId: 's',
    request: { messageOffset: offset, messages: msgs },
    response: { usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0 } },
  });
  const m = (text) => ({ role: 'user', content: text });
  const lines = [
    row(1000, [m('hi')], 0),
    row(1100, [m('task')], 1),
    row(1300, [m(R())], 2), // 回执进入
    row(1500, [m('next')], 3), // 历史仍带回执
    row(900, [m('compact')], 0), // 压缩:回执被裁掉
  ];
  const f = path.join(dir, 'r.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const { rows, events } = replay(parseRows(fs.readFileSync(f, 'utf8')), count);
  assert.equal(events.length, 1, '应识别 1 个拦截实例');
  assert.equal(events[0].affectedRows, 2, '回执只在第 3、4 行在场(第 5 行被压缩裁掉)');
  const saved = sumOf(rows, 'cfDelta');
  const expect = 2 * (count('x'.repeat(4000)) - count(R()));
  assert.equal(saved, expect, `反事实节约应为 ${expect},实际 ${saved}`);
  assert.ok(sumOf(rows.filter((r) => r.counts.size), 'input') > 0, '在场行已计实际输入');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[ok] selftest 通过:1 实例、受影响 2 行、节约 ${saved} tokens`);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) main().catch((e) => { console.error('[err]', e.message); process.exit(1); });
