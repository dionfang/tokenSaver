/**
 * extractTierEvidence.mjs — 自进化 v2 历史证据回填(难度档位区间证据抽取器)。
 *
 * 从真实流量账本 proxy-usage.jsonl + db.sqlite 回放,产出每轮任务的"难度档位区间证据",
 * 供 tierOptimize.mjs 的 v2 区间目标函数(loadEvalRows → tierIntervalOf)消费:
 *   每行 { prompt, pkey, interval:{min,max,src} } 三字段非空,prompt 为 db 回放的完整人类 prompt。
 *
 * 行级语义:一个"任务" = 一次人类轮 + 其后直至下一个人类轮的所有工具轮(proxy 按 conv+ts 切分,
 * reason 区分人类轮/工具轮:含 'sticky 基准'/'难度 R'/'阶段粘住延续'/'阶段结束'/'R1 宽限'/'人工改档'/
 * '证据升级' 等是人类轮,'工具续接'/'tool-continuation' 是工具轮)。每个任务输出一行。
 *
 * interval 推导优先级从高到低:
 *   1. p2-exact   段内发生 P2 上梯(reason 以 '证据升级' 开头;escalationTo 字段或 reason 内
 *                 'R2→R3' 形态取目标档)⇒ {目标档,目标档}
 *   2. troubleshoot errTotal≥2 且 writes≤2 ⇒ {R2,R2}
 *   3. heavy-shape   writes≥3 或 calls≥15 ⇒ {R2,R2}
 *   4. answer-only   calls≤2 且 writes==0 ⇒ {R1,R1}
 *   5. light-shape   calls≤8 且 writes≤2 ⇒ {R1,R1}
 *   6. clean-upper   其余 ⇒ {R1, servedTier}(v2 拓宽:干净完成只给可解性上界)
 *
 * 数据对齐:
 *   - db 人类消息 ts ↔ proxy 行 ts 时间窗 ±20s(取窗口内最近,人类轮/模型名一致弱校验优先);
 *   - proxy 行带 pkey/promptHead 时可用 promptKey 精确 join;本账本暂无这些字段,join 恒为 'db'。
 *   - conv↔session 映射落 data/routing/conv-session-map.jsonl 供后续复用。
 *
 * 用法:node extractTierEvidence.mjs [--usage proxy-usage.jsonl] [--db db.sqlite]
 *                                     [--out tier-evidence.jsonl] [--map conv-session-map.jsonl]
 *                                     [--window 20000]
 * 默认输出 data/routing/tier-evidence.jsonl,并打印汇总 + 抽样 + 落盘自检。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DATA_DIR } from './config.mjs';
import { atomicWriteFileSync } from './proc.mjs';
import { promptKey } from './buildExemplars.mjs';
import { WRITE_TOOLS } from './calibrateSignals.mjs';
import { tierOfModel, tierClassifyOptions } from './modelRoute.mjs';

const require = createRequire(import.meta.url);
const HOME = process.env.USERPROFILE || require('node:os').homedir();

const DEFAULT_USAGE = path.join(DATA_DIR, 'usage', 'proxy-usage.jsonl');
const DEFAULT_DB = path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite');
const DEFAULT_OUT = path.join(DATA_DIR, 'routing', 'tier-evidence.jsonl');
const DEFAULT_MAP = path.join(DATA_DIR, 'routing', 'conv-session-map.jsonl');
const TIERS = ['R1', 'R2', 'R3', 'R4'];

// 人类轮 reason 特征(新行 lastKind 字段出现前按 reason 区分;工具续接特征优先判定)
const TOOL_RE = /工具续接|tool-continuation/;
const HUMAN_RE = /sticky 基准|难度 R|阶段粘住延续|阶段结束|R1 宽限|人工改档|证据升级|阶段轮数到顶|切换税门控|auto-unresolved|R1 档无可用模型/;
const ESCALATION_RE = /^证据升级/;
const TAG_RE = /(R[1-4])\s*→\s*(R[1-4])/;

const isTool = (r) => TOOL_RE.test(String(r.reason || ''));
const isHuman = (r) => !isTool(r) && HUMAN_RE.test(String(r.reason || ''));

function readJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---------- ① proxy 账本:探针过滤 + 按 conv 切分任务段 ----------
export function loadUsageRows(file = DEFAULT_USAGE) {
  const rows = readJsonl(file);
  const kept = [];
  for (const r of rows) {
    if (r.conv === 17151) continue;                       // test-model 探针会话整段剔除
    if (String(r.requested || '').startsWith('test-') || String(r.served || '').startsWith('test-')) continue;
    if (!Number.isFinite(num(r.ts, null))) continue;
    kept.push(r);
  }
  return kept;
}

/** 按 (conv, ts) 切分:人类轮开段,工具轮挂入当前段;段首行之前/无人类轮的行丢弃。 */
export function buildSegments(rows) {
  const byConv = new Map();
  rows.forEach((r, i) => {
    if (!byConv.has(r.conv)) byConv.set(r.conv, []);
    byConv.get(r.conv).push({ ...r, __idx: i });
  });
  const segs = [];
  for (const list of byConv.values()) {
    list.sort((a, b) => a.ts - b.ts || a.__idx - b.__idx);
    let cur = null;
    for (const r of list) {
      if (isHuman(r)) {
        if (cur) segs.push(cur);
        cur = { conv: r.conv, human: r, rows: [r] };
      } else if (cur) {
        cur.rows.push(r);
      }
    }
    if (cur) segs.push(cur);
  }
  segs.sort((a, b) => a.human.ts - b.human.ts);
  return segs;
}

// ---------- ② db 回放:人类消息全文 + 其后工具轮行为统计 ----------
/** db 路径:与 importRoutingLog 同解析逻辑(~/.zcode/cli/db/db.sqlite),缺则 v2Dir 派生兜底。 */
function dbCandidates() {
  return [DEFAULT_DB, path.join(HOME, '.zcode', 'v2', '..', 'cli', 'db', 'db.sqlite')];
}

export function openDb(dbPath = DEFAULT_DB) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return { error: 'node:sqlite 不可用' }; }
  const cands = [dbPath, ...dbCandidates()];
  for (const c of cands) {
    if (!c || !fs.existsSync(c)) continue;
    try { return { db: new DatabaseSync(c, { readOnly: true }), path: c }; } catch { /* 下一个候选 */ }
  }
  return { error: `db 打不开(尝试:${cands.join(' , ')})` };
}

/** 人类消息过滤:role=user 且非注入。S4-F1(2026-11-20 夜):判别键主要在 message 级 metadata.source
 *  (todo_reminder 等,实弹 46% 人类消息为 TodoWrite 提醒、108 对齐行混入 10 行注入)——先按 source 剔除
 *  非人类来源,再按 message data 字面兜底(source 缺席但 data 带 kind/agent_listing 形态)。 */
const INJECTED_MSG_SOURCES = new Set(['todo_reminder', 'system_reminder', 'agent_listing']);
const isInjectedMsg = (dataStr, meta) => {
  const src = meta && meta.metadata ? meta.metadata.source : null;
  if (typeof src === 'string' && INJECTED_MSG_SOURCES.has(src)) return true;
  return dataStr.includes('"kind":"system_reminder"') || dataStr.includes('agent_listing_delta');
};

/** part 级文本兜底:source 与 kind 都缺席、提醒文本本体直接落在 parts 的注入形态(实弹 10 行注入行全为此形态)。 */
const isInjectedPromptText = (t) => String(t).includes("TodoWrite tool hasn't been used");

function textOfPart(data) {
  try {
    const d = JSON.parse(String(data || ''));
    if (d && typeof d.text === 'string') return d.text;
  } catch { /* 非 JSON 忽略 */ }
  return '';
}

/**
 * 回放每条人类消息:{session_id, ts, 全文, 对话内次序} + 其后工具轮统计。
 * 统计:tool_usage 中 status='error' 或 Bash 非零退出 = 错误(errTotal);tool call 数(calls);
 * 写文件语义调用数(writes,WRITE_TOOLS 且 status='completed',口径同 autoExemplars shape)。
 * 优先 turn_usage(user_message_id) 关联,缺关联时按 [ts-10s, 下一条人类消息 ts) 会话内时间窗兜底。
 */
export function loadDbMessages({ db, turnMs = 15 * 60 * 1000 } = {}) {
  const msgs = [];
  const inj = db.prepare("SELECT id, session_id, time_created, data FROM message WHERE json_extract(data, '$.role') = 'user' ORDER BY time_created").all();
  for (const m of inj) {
    let data = null;
    try { data = JSON.parse(String(m.data || '')); } catch { /* 损坏行按字面兜底判注入 */ }
    if (isInjectedMsg(String(m.data || ''), data)) continue;
    const parts = db.prepare("SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY sequence").all(m.id);
    const text = parts.map((p) => textOfPart(p.data)).filter(Boolean);
    if (!text.length) continue;
    if (text.some((t) => isInjectedPromptText(t))) continue;
    let model = null;
    try { model = data?.modelSelection?.modelId || null; } catch { /* 无模型字段可空 */ }
    msgs.push({ id: m.id, session: m.session_id, ts: num(m.time_created), prompt: text.join('\n'), model });
  }
  // 会话内按序回放:下一条人类消息 ts 决定统计窗右界
  const sess = new Map();
  for (const m of msgs) {
    if (!sess.has(m.session)) sess.set(m.session, []);
    sess.get(m.session).push(m);
  }
  for (const list of sess.values()) list.sort((a, b) => a.ts - b.ts);

  const turnOf = db.prepare('SELECT turn_id, tool_call_count, tool_error_count FROM turn_usage WHERE user_message_id = ?');
  const toolsOfTurn = db.prepare('SELECT id, tool_name, status, exit_code FROM tool_usage WHERE turn_id = ?');
  const toolsInWin = db.prepare('SELECT id, tool_name, status, exit_code FROM tool_usage WHERE session_id = ? AND started_at >= ? AND started_at < ?');

  for (const list of sess.values()) {
    list.forEach((m, i) => {
      const end = i + 1 < list.length ? list[i + 1].ts : m.ts + turnMs;
      const toolRows = [];
      const seen = new Set();
      let tCalls = 0; let tErrs = 0;
      for (const t of turnOf.all(m.id)) {
        tCalls += num(t.tool_call_count); tErrs += num(t.tool_error_count);
        for (const tr of toolsOfTurn.all(t.turn_id)) {
          if (!seen.has(tr.id)) { seen.add(tr.id); toolRows.push(tr); }
        }
      }
      for (const tr of toolsInWin.all(m.session, m.ts - 10000, end)) {
        if (!seen.has(tr.id)) { seen.add(tr.id); toolRows.push(tr); }
      }
      let errTotal = 0; let writes = 0;
      for (const tr of toolRows) {
        const isErr = tr.status === 'error'
          || (tr.status === 'completed' && tr.tool_name === 'Bash' && tr.exit_code !== null && Number(tr.exit_code) !== 0);
        if (isErr) errTotal += 1;
        if (WRITE_TOOLS.has(tr.tool_name) && tr.status === 'completed') writes += 1;
      }
      m.errTotal = Math.max(errTotal, tErrs);
      m.calls = Math.max(toolRows.length, tCalls);
      m.writes = writes;
    });
  }
  return msgs;
}

// ---------- ③ 两表对齐(ts ±20s + 弱校验);④ 区间推导 ----------
/** reason 里解析 'R1→R2' 形态的上梯目标档。 */
export function parseEscalation(reason) {
  const m = TAG_RE.exec(String(reason || ''));
  if (m && TIERS.includes(m[1]) && TIERS.includes(m[2])) return { from: m[1], to: m[2] };
  return null;
}

const normModel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const modelAgree = (a, b) => {
  if (!a || !b) return false;
  const na = normModel(a); const nb = normModel(b);
  return na && nb && (na === nb || na.includes(nb) || nb.includes(na));
};

/** 段内统计合成(servedTier 推断 + 上梯解析 + token 聚合)。 */
export function segmentStats(seg, tierOpts) {
  const h = seg.human;
  const served = String(h.served || '');
  let servedTier = TIERS.includes(h.servedTier) ? h.servedTier : null;
  const tierInferred = !servedTier;
  if (!servedTier) {
    try { servedTier = tierOfModel(served, tierOpts); } catch { servedTier = null; }
    if (!TIERS.includes(servedTier)) servedTier = null;
  }
  let escalationFrom = null; let escalationTo = null;
  let escRow = null;
  for (const r of seg.rows) if (ESCALATION_RE.test(String(r.reason || ''))) escRow = r; // 取最后一次上梯
  if (escRow) {
    const p = parseEscalation(escRow.reason);
    if (p) { escalationFrom = p.from; escalationTo = p.to; }
    else {
      // 老格式('解锁 reasoner 档')无箭头:按该行 served 模型推目标档
      try {
        const t = tierOfModel(String(escRow.served || ''), tierOpts);
        escalationTo = TIERS.includes(t) ? t : null;
      } catch { escalationTo = null; }
    }
  }
  let tokens = 0; let estTokens = 0;
  for (const r of seg.rows) {
    if (r.inTok !== null && r.inTok !== undefined || r.outTok !== null && r.outTok !== undefined) {
      tokens += num(r.inTok) + num(r.outTok);
      estTokens += num(r.estTokens);
    } else {
      estTokens += num(r.estTokens);
      tokens += num(r.estTokens);
    }
  }
  return { servedTier, tierInferred, escalationFrom, escalationTo, tokens, estTokens };
}

/** 区间推导优先级: p2-exact > troubleshoot > heavy-shape > answer-only > light-shape > clean-upper。 */
export function intervalOf(t) {
  if (TIERS.includes(t.escalationTo)) return { min: t.escalationTo, max: t.escalationTo, src: 'p2-exact' };
  if (num(t.errTotal) >= 2 && num(t.writes) <= 2) return { min: 'R2', max: 'R2', src: 'troubleshoot' };
  if (num(t.writes) >= 3 || num(t.calls) >= 15) return { min: 'R2', max: 'R2', src: 'heavy-shape' };
  if (num(t.calls) <= 2 && num(t.writes) === 0) return { min: 'R1', max: 'R1', src: 'answer-only' };
  if (num(t.calls) <= 8 && num(t.writes) <= 2) return { min: 'R1', max: 'R1', src: 'light-shape' };
  const max = TIERS.includes(String(t.servedTier)) ? t.servedTier : 'R1';
  return { min: 'R1', max, src: 'clean-upper' };
}

// ---------- 主流程 ----------
export function buildEvidence({ usageFile = DEFAULT_USAGE, dbPath = DEFAULT_DB, windowMs = 20000, out = DEFAULT_OUT, mapFile = DEFAULT_MAP } = {}) {
  const rows = loadUsageRows(usageFile);
  const segs = buildSegments(rows);
  // 行 → 段索引(对齐时 O(1) 取段)
  const segOf = new Array(rows.length).fill(null);
  // 按 ts 升序的时间轴(二分取 ±window 候选)
  const axis = rows.map((r, i) => ({ ts: r.ts, i })).sort((a, b) => a.ts - b.ts || a.i - b.i);
  segs.forEach((seg) => { for (const r of seg.rows) segOf[r.__idx] = seg; });

  const opened = openDb(dbPath);
  if (opened.error) return { error: opened.error, segs: segs.length, rows: [] };
  let dbMsgs = [];
  try {
    dbMsgs = loadDbMessages({ db: opened.db });
  } catch (e) {
    return { error: `db 回放失败:${e.message}`, segs: segs.length, rows: [] };
  } finally {
    try { opened.db.close(); } catch { /* 已关 */ }
  }

  const tierOpts = (() => { try { return tierClassifyOptions(); } catch { return {}; } })();
  const outRows = [];
  const seenTask = new Set();
  const mapRows = new Map();
  let aligned = 0; let dup = 0; let pkeyJoined = 0; let missed = 0;

  for (const d of dbMsgs) {
    const lo = lowerBound(axis, d.ts - windowMs);
    const hi = upperBound(axis, d.ts + windowMs);
    if (lo >= hi) { missed += 1; continue; }
    let best = null;
    for (let k = lo; k < hi; k += 1) {
      const r = rows[axis[k].i];
      const seg = segOf[axis[k].i];
      if (!seg) continue;
      const isStart = seg.human.__idx === axis[k].i;
      // 20261119-2-S4-F2:proxy promptHead 是 200 字口径(400 侧归一后对 >200 字 prompt 恒不等),join 统一按 200 字比对
      const pkeyHit = r.promptHead ? promptKey(r.promptHead) === promptKey(d.prompt, 200) : false;
      const delta = Math.abs(r.ts - d.ts);
      const cand = { r, seg, isStart, pkeyHit, delta, modelHit: modelAgree(r.served, d.model) };
      if (!best
        || (cand.pkeyHit ? 0 : 1) < (best.pkeyHit ? 0 : 1)
        || ((cand.pkeyHit ? 0 : 1) === (best.pkeyHit ? 0 : 1) && (cand.isStart ? 0 : 1) < (best.isStart ? 0 : 1))
        || ((cand.pkeyHit ? 0 : 1) === (best.pkeyHit ? 0 : 1) && (cand.isStart ? 0 : 1) === (best.isStart ? 0 : 1)
          && (cand.modelHit ? 0 : 1) < (best.modelHit ? 0 : 1))
        || ((cand.pkeyHit ? 0 : 1) === (best.pkeyHit ? 0 : 1) && (cand.isStart ? 0 : 1) === (best.isStart ? 0 : 1)
          && (cand.modelHit ? 0 : 1) === (best.modelHit ? 0 : 1) && cand.delta < best.delta)) {
        best = cand;
      }
    }
    // 窗内行全部落在任务段外时 best 为空;跳过计 missed,不能解构 null 中断整次回放。
    if (!best) { missed += 1; continue; }
    const { seg, pkeyHit } = best;
    if (pkeyHit) pkeyJoined += 1;
    const key = `${seg.conv}|${seg.human.ts}`;
    if (seenTask.has(key)) { dup += 1; continue; }
    seenTask.add(key);
    const st = segmentStats(seg, tierOpts);
    const interval = intervalOf({ ...st, errTotal: d.errTotal, calls: d.calls, writes: d.writes });
    aligned += 1;
    const promptHead = String(d.prompt || '').split('\n').find((l) => l.trim())?.trim().slice(0, 160) || '';
    const row = {
      conv: seg.conv,
      ts: seg.human.ts,
      session: d.session,
      prompt: d.prompt,
      promptHead,
      pkey: promptKey(d.prompt),
      servedTier: st.servedTier,
      servedModel: String(seg.human.served || '') || null,
      tierInferred: st.tierInferred,
      escalated: seg.human.escalated === true,
      escalationFrom: st.escalationFrom,
      escalationTo: st.escalationTo,
      errTotal: d.errTotal,
      calls: d.calls,
      writes: d.writes,
      tokens: st.tokens,
      estTokens: st.estTokens,
      interval,
      join: pkeyHit ? 'pkey' : 'db',
    };
    outRows.push(row);
    mapRows.set(`${seg.conv}|${d.session}`, { conv: seg.conv, session: d.session, ts: seg.human.ts, via: row.join });
  }
  outRows.sort((a, b) => a.ts - b.ts);
  // S5-F1(2026-11-17 夜审):0 对齐拒绝写空守卫——有候选段却零对齐时不覆盖既有证据(防 db 瞬断/口径漂移清空),与 importRoutingLog 同族
  const zeroAlign = segs.length > 0 && aligned === 0;
  if (out && !zeroAlign) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    atomicWriteFileSync(out, outRows.map((r) => JSON.stringify(r)).join('\n') + (outRows.length ? '\n' : ''));
  }
  if (mapFile && !zeroAlign) {
    fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    atomicWriteFileSync(mapFile, [...mapRows.values()].map((r) => JSON.stringify(r)).join('\n') + (mapRows.size ? '\n' : ''));
  }
  return { segs: segs.length, dbMsgs: dbMsgs.length, aligned, dup, pkeyJoined, missed, map: mapRows.size, rows: outRows, out, zeroAlign };
}

function lowerBound(axis, ts) {
  let lo = 0; let hi = axis.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (axis[m].ts < ts) lo = m + 1; else hi = m; }
  return lo;
}
function upperBound(axis, ts) {
  let lo = 0; let hi = axis.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (axis[m].ts <= ts) lo = m + 1; else hi = m; }
  return lo;
}

// ---------- 自检与汇总 ----------
export function selfcheck(file = DEFAULT_OUT) {
  const rows = readJsonl(file);
  let ok = 0; const errs = [];
  for (const r of rows) {
    const iv = r && r.interval;
    const bad = [];
    if (!r || !String(r.prompt || '').trim()) bad.push('prompt 空');
    if (!r || !String(r.pkey || '').trim()) bad.push('pkey 空');
    if (!iv || !TIERS.includes(iv.min) || !TIERS.includes(iv.max) || !String(iv.src || '').trim()) bad.push('interval 非法');
    else if (TIERS.indexOf(iv.min) > TIERS.indexOf(iv.max)) bad.push('interval 倒置');
    if (bad.length) errs.push({ line: rows.indexOf(r) + 1, bad, pkey: r && r.pkey });
    else ok += 1;
  }
  return { total: rows.length, ok, errs };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  const argv = process.argv;
  const val = (f, def) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : def);
  const usageFile = val('--usage', DEFAULT_USAGE);
  const dbPath = val('--db', DEFAULT_DB);
  const out = val('--out', DEFAULT_OUT);
  const mapFile = val('--map', DEFAULT_MAP);
  const windowMs = Number(val('--window', 20000));
  const res = buildEvidence({ usageFile, dbPath, windowMs, out, mapFile });
  if (res.error) { console.error(`[err] ${res.error}`); process.exit(1); }
  const bySrc = {};
  const byTier = {};
  let p2 = 0;
  for (const r of res.rows) {
    bySrc[r.interval.src] = (bySrc[r.interval.src] || 0) + 1;
    byTier[r.servedTier || 'null'] = (byTier[r.servedTier || 'null'] || 0) + 1;
    if (r.interval.src === 'p2-exact') p2 += 1;
  }
  console.log(`任务总数(proxy 段):${res.segs}`);
  console.log(`db 人类消息:${res.dbMsgs} | 对齐命中:${res.aligned} | 窗口内未对齐:${res.missed} | 重复段去重:${res.dup} | pkey 精确 join:${res.pkeyJoined}`);
  console.log(`src 分布:${JSON.stringify(bySrc)}`);
  console.log(`p2-exact 行数:${p2}`);
  console.log(`servedTier 分布:${JSON.stringify(byTier)}`);
  console.log(`conv↔session 映射:${res.map} 条 → ${mapFile}`);
  console.log(`输出 ${res.rows.length} 行 → ${out}`);
  const samples = res.rows.filter((_, i) => i % Math.max(1, Math.floor(res.rows.length / 3)) === 0).slice(0, 3);
  console.log('抽样行:');
  for (const s of samples) console.log(JSON.stringify(s));
  const chk = selfcheck(out);
  console.log(`[自检] ${chk.ok}/${chk.total} 行合法${chk.errs.length ? `,非法:${JSON.stringify(chk.errs)}` : ''}`);
  if (chk.errs.length) process.exit(1);
}