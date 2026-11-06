/**
 * routing-log → db 对齐器(上轮建议 A3:弱标签回填,不依赖人工判定)。
 *
 * routing-log.jsonl 只有 ts/promptHead/L1 预测,没有真实标签——直接当标签源=自我确认偏差。
 * 本工具做四件事:
 *   ① 过滤探针(测试脚本自己产生的 prompt)与空 promptHead;
 *   ② 按 promptKey 唯一化(重复提问只留一条);
 *   ③ 按 ts±10s 窗口对齐 db.sqlite 的 part 表,取回**完整 prompt + session_id**(实测命中率 12/12);
 *   ④ 用该轮 tool_usage 的行为形态打弱标签(与 calibrateSignals 同一口径):
 *        零工具 → light;写≥3 或 调用≥15 → multi;写 1-2 → routine;其余 → null(uncertain,不硬猜)。
 * 标签只来自行为形态,绝不回灌 L1 预测。输出 data/routing/routinglog-labels.jsonl,
 * 供 buildExemplars/黄金集流程消费(格式:{promptKey,prompt,label,source,sessionId,shape,l1})。
 *
 * 用法:node importRoutingLog.mjs --build [--log <routing-log.jsonl>] [--db <db.sqlite>] [--out <jsonl>]
 *      node importRoutingLog.mjs --report
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DATA_DIR } from './config.mjs';
import { WRITE_TOOLS, DISPATCH_TOOLS, READ_TOOLS } from './calibrateSignals.mjs';
import { promptKey } from './buildExemplars.mjs';

const require = createRequire(import.meta.url);
const HOME = process.env.USERPROFILE || require('node:os').homedir();
const DEFAULT_LOG = path.join(DATA_DIR, 'usage', 'routing-log.jsonl');
const DEFAULT_DB = path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite');
const DEFAULT_OUT = path.join(DATA_DIR, 'routing', 'routinglog-labels.jsonl');

/** 探针/自测产生的 prompt(测试脚本与钩子自检),不进样本库。 */
export const PROBE_RE = /拦截阈值测试|补扫验证|livecheck|hostscheck|probe-|hosts-gate/;

export function isProbeRow(row) {
  return PROBE_RE.test(String(row && row.promptHead) || '');
}

/** 行为形态 → 弱标签(2026-11-06 三档定稿)。只标行为上确定的:写≥3 或调用≥15=multi;写1-2=routine;零工具=light;其余不猜。 */
export function labelFromShape({ calls = 0, writes = 0, dispatches = 0 } = {}) {
  const c = Number(calls) || 0;
  const w = Number(writes) || 0;
  const d = Number(dispatches) || 0;
  if (w === 0 && d === 0 && c === 0) return 'light';
  if (w >= 3 || c >= 15) return 'multi';
  if (w >= 1) return 'routine';
  return null;
}

/** ①+②:过滤、唯一化,保序。返回 [{ts,promptHead,type}]。 */
export function pickCandidates(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const head = String((r && r.promptHead) || '');
    if (!head.trim() || head.trim().length < 6) continue;
    if (isProbeRow(r)) continue;
    const k = promptKey(head);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ts: Number(r.ts) || 0, promptHead: head, l1: r.type || null });
  }
  return out;
}

function normHead(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 30);
}

/**
 * ③+④:对齐 db 并打标签。db 不可用返回 {rows:[], error}。
 * 对齐判据:part.time_created ∈ [ts-窗口, ts+窗口] 且 data 文本包含 promptHead 归一化前缀。
 */
export async function alignAndLabel(candidates, { dbPath = DEFAULT_DB, windowMs = 10000 } = {}) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return { rows: [], error: 'node:sqlite 不可用' }; }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { return { rows: [], error: `db 打不开:${e.message}` }; }
  try {
    const near = db.prepare('SELECT session_id, message_id, time_created, data FROM part WHERE time_created BETWEEN ? AND ?');
    const turnOf = db.prepare('SELECT turn_id FROM turn_usage WHERE user_message_id = ? ORDER BY started_at DESC LIMIT 1');
    const toolsOf = db.prepare('SELECT tool_name, COUNT(*) n FROM tool_usage WHERE turn_id = ? GROUP BY tool_name');
    const rows = [];
    let missed = 0;
    for (const c of candidates) {
      const head = normHead(c.promptHead);
      const probe = head.slice(0, 12);
      const hitsAll = near.all(c.ts - windowMs, c.ts + windowMs);
      let hit = null;
      for (const h of hitsAll) {
        const t = textOf(h.data);
        if (!t) continue;
        const nt = t.replace(/\s+/g, ' ');
        if (nt.includes(head) || nt.includes(probe)) { hit = h; break; }
      }
      if (!hit) { missed += 1; continue; }
      const shape = { calls: 0, writes: 0, dispatches: 0, reads: 0 };
      const tur = turnOf.get(hit.message_id);
      if (tur && tur.turn_id) {
        for (const tr of toolsOf.all(tur.turn_id)) {
          const name = String(tr.tool_name || '');
          const n = Number(tr.n) || 0;
          if (WRITE_TOOLS.has(name)) shape.writes += n;
          else if (DISPATCH_TOOLS.has(name)) shape.dispatches += n;
          else if (READ_TOOLS.has(name)) shape.reads += n;
          shape.calls += n;
        }
      }
      rows.push({
        promptKey: promptKey(c.promptHead),
        prompt: textOf(hit.data) || c.promptHead,
        label: labelFromShape(shape),
        source: 'routing-log',
        sessionId: hit.session_id || null,
        ts: c.ts,
        shape,
        l1: c.l1,
      });
    }
    return { rows, missed };
  } finally { try { db.close(); } catch { /* 已关 */ } }
}

function textOf(data) {
  try {
    const d = JSON.parse(String(data || ''));
    if (d && typeof d.text === 'string') return d.text;
  } catch { /* 非 JSON 忽略 */ }
  return '';
}

export async function buildCandidates({ logFile = DEFAULT_LOG, dbPath = DEFAULT_DB, out = DEFAULT_OUT } = {}) {
  const raw = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const candidates = pickCandidates(raw);
  const { rows, missed } = await alignAndLabel(candidates, { dbPath });
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  }
  return { total: raw.length, candidates: candidates.length, aligned: rows.length, missed, labeled: rows.filter((r) => r.label).length, out };
}

function report(file = DEFAULT_OUT) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const cnt = {};
  for (const r of rows) cnt[r.label || 'uncertain'] = (cnt[r.label || 'uncertain'] || 0) + 1;
  console.log(`候选 ${rows.length} 条(${file})`);
  console.log('弱标签分布:', JSON.stringify(cnt));
  const agree = rows.filter((r) => r.l1 && r.l1 === r.label).length;
  const both = rows.filter((r) => r.l1 && r.label).length;
  console.log(`L1 预测与行为标签一致:${agree}/${both}${both ? ` (${(agree / both * 100).toFixed(0)}%)` : ''}`);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  const argv = process.argv;
  const has = (f) => argv.includes(f);
  const val = (f, def) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : def);
  if (has('--report')) {
    try { report(val('--out', DEFAULT_OUT)); } catch (e) { console.error('[err]', e.message); process.exit(1); }
  } else {
    buildCandidates({ logFile: val('--log', DEFAULT_LOG), dbPath: val('--db', DEFAULT_DB), out: val('--out', DEFAULT_OUT) })
      .then((r) => console.log(JSON.stringify(r)))
      .catch((e) => { console.error('[err]', e.message); process.exit(1); });
  }
}