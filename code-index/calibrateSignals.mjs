/**
 * 规则自校准(routing-log/词表不自学,但"规则命中率"可以从真实 turn 形态学到)。
 *
 * 动机(2026-11-01,用户要求"不希望规则靠人工判定"):每个人的提问习惯不同,手工调词表无法泛化。
 * 做法:用 ZCode 本机会话库里的**行为形态**当标签——不看模型说了什么,只看这一轮实际做了什么:
 *   写文件/派发子代理 = 真的在执行;工具调用多/写得多 = 重活;零工具 = 只是问答。
 * 然后用它统计每条 L1 规则"判对的比例",把置信度按比例缩放(只降不升、样本不足不生效)。
 * 缩放后低于调用方阈值(代理是 0.7)的规则就自动停止触发改写——这就是内驱优化的落点。
 *
 * 边界(2026-11-01 审计后收紧):
 *   - 标签只来自行为形态,绝不回灌 L1/L2 自己的预测(防自我确认偏差);
 *   - **样本只取 task_type='interactive'**(实测本机 679 个 subagent_child 会话 vs 27 个交互会话:
 *     不过滤时 R-T3 有 690 条"人类轮次"、其中 619 条其实是子代理指令,统计全是噪声;
 *     过滤后 T3=71、T4=1)。老库无 session/task_type ⇒ 退回全量并在档案里标 population;
 *   - 平滑向**基线**收缩(旧实现向 0.5 收缩:恰好达到基线的规则也会被扣分,T4 基线 0.7 永远拿不到 1.0);
 *   - 只降不升、下限 0.4、每条规则至少 minN 个样本才动;
 *   - **默认关闭**:档案首建 `enabled:false`,重建只继承旧值、绝不自动打开;启用要么 `--enable`,
 *     要么人工把档案改成 true(两道都默认关,符合 #11 门控哲学)。消费端 classify.mjs 只认 `enabled===true`;
 *   - 档案缺失/损坏/数据库不可读 ⇒ 完全退回原规则(零影响);
 *   - 与黄金集互不干扰:黄金集是四票代签量尺,本档案是"用户自己的使用习惯画像"。
 *
 * 生效面(诚实口径):代理改写早已不按 T 型门控,而是按难度四档定档(tierClassify 驱动,档位标定另走
 * tierOptimize/calibrate 的 tier 档案)。本档案的倍数只影响 T 型判定与 [model-routing] 注入行的显示置信度,
 * 不改变选模。⇒ 现状下本机制对路由零直接影响,先当"待审清单"用(--misfire-report)。
 *
 * 用法:node calibrateSignals.mjs --build [--db <db.sqlite>] [--out <calibration.json>] [--min-n 20]
 *      node calibrateSignals.mjs --report | --misfire-report [--examples 5] | --enable | --disable
 * 自动:prompt-guard 的 --check 后台分支会按"DB 比档案新且距上次 ≥6h"条件自动重建(见 maybeRecalibrate)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DATA_DIR } from './config.mjs';
import { classifyPromptRaw } from './classify.mjs';

const require = createRequire(import.meta.url);

const self = fileURLToPath(import.meta.url);
const HOME = os.homedir();
const DEFAULT_DB = path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite');
const DEFAULT_OUT = path.join(DATA_DIR, 'routing', 'calibration.json');
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 代理改写阈值(modelRouteProxy decideTarget 用 0.7):低于它规则等于自动停用。 */
const REWRITE_THRESHOLD = 0.7;

/** 工具名 → 行为类别(按 Python/Node 工具集并集)。导出供 importRoutingLog 等复用同一口径。 */
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'NotebookEdit', 'write', 'edit']);
export const DISPATCH_TOOLS = new Set(['Agent', 'Task', 'agent', 'task']);
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Search', 'read', 'grep', 'glob', 'search']);

/** 每条规则"声称会发生什么"→ 用哪个形态指标校验,以及期望基线(低于基线就降权)。 */
const RULE_CLAIM = {
  'R-multi范围+重构': { metric: 'heavyRate', baseline: 0.7 },   // 声称:大改动
  'R-routine测试信号': { metric: 'actionRate', baseline: 0.6 }, // 声称:会动手写/跑
  'R-routine编辑动词': { metric: 'actionRate', baseline: 0.6 },
  'R-routine报错信号': { metric: 'actionRate', baseline: 0.5 }, // 初诊可能只读不改
  'R-light杂务信号': { metric: 'actionRate', baseline: 0.5 },
  'R-routine审查信号': { metric: 'answerRate', baseline: 0.5 }, // 声称:审查=读+说,不写
  'R-multi方案信号': { metric: 'answerRate', baseline: 0.5 },
  'R-light提问信号': { metric: 'answerRate', baseline: 0.6 },
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** 从 part.data(JSON) 里取用户文本。 */
export function textOfPart(data) {
  try {
    const d = JSON.parse(String(data || ''));
    if (d && typeof d.text === 'string') return d.text;
  } catch { /* 非 JSON 忽略 */ }
  return '';
}

/** 剥掉钩子注入前缀(与 exportWeakLabels.py 同口径):注入文本不是用户说的话,却带路由信号词。 */
export function stripInjected(text) {
  let t = String(text || '');
  const markers = ['[code-index]', '[model-routing]', '[Hook additional context]', '[code-index] 状态'];
  let changed = true;
  while (changed) {
    changed = false;
    const head = t.replace(/^\s+/, '');
    for (const m of markers) {
      if (head.startsWith(m)) { t = head.slice(m.length); changed = true; break; }
    }
  }
  return t.trim();
}

/**
 * 读本机真实 turn 形态:每轮 prompt + 工具调用数/错误数 + 写/派发次数。
 * 只取人类交互会话(task_type='interactive')、已完成、未取消的轮次;库不可用时返回 []。
 * 返回 {turns, population};population='interactive' 或 'all'(退回口径,档案里可见)。
 */
export function readOutcomeTurns({ dbPath = DEFAULT_DB, limit = 20000 } = {}) {
  const empty = { turns: [], population: 'none' };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return empty; }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return empty; }
  try {
    const toolMix = new Map();
    try {
      const rows = db.prepare('SELECT turn_id, tool_name, COUNT(*) n FROM tool_usage WHERE turn_id IS NOT NULL GROUP BY turn_id, tool_name').all();
      for (const r of rows) {
        const m = toolMix.get(r.turn_id) || { writes: 0, dispatches: 0, reads: 0 };
        const name = String(r.tool_name || '');
        if (WRITE_TOOLS.has(name)) m.writes += Number(r.n) || 0;
        else if (DISPATCH_TOOLS.has(name)) m.dispatches += Number(r.n) || 0;
        else if (READ_TOOLS.has(name)) m.reads += Number(r.n) || 0;
        toolMix.set(r.turn_id, m);
      }
    } catch { /* 老库无 tool_usage 时按 turn_usage 聚合 */ }
    const sql = (withSession) => `
      SELECT t.turn_id, t.tool_call_count, t.tool_error_count, t.model_request_count, p.data
      FROM turn_usage t
      ${withSession ? "JOIN session s ON s.id = t.session_id AND s.task_type = 'interactive'" : ''}
      JOIN part p ON p.message_id = t.user_message_id
      WHERE (t.status IS NULL OR t.status = 'completed')
        AND COALESCE(t.cancelled_by_user, 0) = 0
      ORDER BY t.started_at DESC LIMIT ?`;
    let rows = [];
    let population = 'interactive';
    try { rows = db.prepare(sql(true)).all(limit); } catch { rows = []; }
    if (!rows.length) { // 无 session 表/无 task_type 列/纯老库 ⇒ 退回全量口径,并在档案里标出来
      try { rows = db.prepare(sql(false)).all(limit); population = 'all'; } catch { return { turns: [], population: 'none' }; }
    }
    // 一条用户消息可能有多个 part:按 turn 归并再分类,不能只取第一条
    const byTurn = new Map();
    for (const r of rows) {
      const g = byTurn.get(r.turn_id) || { prompt: '', toolCalls: 0, errors: 0, modelRequests: 0 };
      g.prompt += textOfPart(r.data);
      g.toolCalls = Number(r.tool_call_count) || 0;
      g.errors = Number(r.tool_error_count) || 0;
      g.modelRequests = Number(r.model_request_count) || 0;
      byTurn.set(r.turn_id, g);
    }
    const turns = [];
    for (const [turnId, g] of byTurn) {
      const prompt = stripInjected(g.prompt);
      if (!prompt || prompt.length < 6) continue;
      const mix = toolMix.get(turnId) || { writes: 0, dispatches: 0, reads: 0 };
      turns.push({ prompt, toolCalls: g.toolCalls, errors: g.errors, modelRequests: g.modelRequests, writes: mix.writes, dispatches: mix.dispatches });
    }
    return { turns, population };
  } catch { return { turns: [], population: 'none' }; }
  finally { try { db.close(); } catch { /* 已关 */ } }
}

/** 单轮形态 → 三个比率口径。 */
export function shapeOf(turn) {
  const calls = Number(turn.toolCalls) || 0;
  const writes = Number(turn.writes) || 0;
  const dispatches = Number(turn.dispatches) || 0;
  return {
    action: writes > 0 || dispatches > 0,
    heavy: calls >= 10 || writes >= 3,
    answer: calls === 0,
  };
}

/**
 * 统计每条规则的精确率并生成校准档案(纯函数,readFn/classifyFn 可注入)。
 * multiplier = clamp(smoothed / baseline, 0.4, 1):达到基线不惩罚,低于基线等比降权。
 * smoothed 向 **baseline** 收缩(不是向 0.5):判得准的规则不会因为样本少被打折。
 */
export function buildCalibration(turns, { classifyFn = classifyPromptRaw, minN = 20, priorN = 20, population = 'interactive', enabled = false } = {}) {
  const stats = {};
  const unclaimed = {};
  let used = 0;
  for (const t of turns || []) {
    const c = classifyFn(t.prompt);
    if (!c || !c.rule) continue;
    used += 1;
    const shape = shapeOf(t);
    const s = stats[c.rule] || { n: 0, action: 0, heavy: 0, answer: 0, errors: 0, type: c.type, baseConfidence: c.confidence };
    s.n += 1;
    if (shape.action) s.action += 1;
    if (shape.heavy) s.heavy += 1;
    if (shape.answer) s.answer += 1;
    s.errors += Number(t.errors) || 0;
    stats[c.rule] = s;
    if (!RULE_CLAIM[c.rule]) unclaimed[c.rule] = (unclaimed[c.rule] || 0) + 1; // 规则改名/新增 ⇒ 词表和这里要同步
  }
  const rules = {};
  for (const [rule, s] of Object.entries(stats)) {
    const claim = RULE_CLAIM[rule];
    if (!claim) continue;
    // metric 形如 actionRate/heavyRate/answerRate,计数键是去掉 Rate 后缀的 action/heavy/answer
    const countKey = claim.metric.replace(/Rate$/, '');
    const count = s[countKey] || 0;
    // 向基线收缩:样本不足时倍数趋近 1(不动),样本够时趋近实测/基线
    const rate = count / s.n;
    const smoothed = claim.baseline + (rate - claim.baseline) * (s.n / (s.n + priorN));
    const multiplier = s.n < minN ? 1 : Math.round(clamp(smoothed / claim.baseline, 0.4, 1) * 100) / 100;
    rules[rule] = {
      type: s.type,
      n: s.n,
      metric: claim.metric,
      baseline: claim.baseline,
      baseConfidence: s.baseConfidence,
      actionRate: r2(s.action / s.n),
      heavyRate: r2(s.heavy / s.n),
      answerRate: r2(s.answer / s.n),
      errorAvg: r2(s.errors / s.n),
      multiplier,
      active: s.n >= minN,
      gapToMinN: Math.max(0, minN - s.n), // 还要多少条样本才可能开始生效
    };
  }
  return {
    version: 2,
    enabled: enabled === true, // 自动重建绝不自动开闸:只继承人工决定(v2 档案的 enabled)
    builtAt: new Date().toISOString(),
    minN,
    priorN,
    population, // interactive=已过滤子代理轮次;all=退回口径(子代理指令混入,统计偏乐观)
    turns: used,
    unclaimed,
    rules,
  };
}

function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

/** 原子写(tmp + rename):钩子按 mtime 缓存,半个文件会读成损坏 JSON ⇒ 直接退回不校准。 */
export function writeCalibration(calib, { out = DEFAULT_OUT } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(calib, null, 2) + '\n');
  try { fs.renameSync(tmp, out); } catch { fs.copyFileSync(tmp, out); fs.unlinkSync(tmp); }
  return out;
}

function readProfile(out = DEFAULT_OUT) {
  try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return null; }
}

/** 人工开关只继承 v2 及以后的档案:v1 的 enabled 是旧自动流程写的,不算人工批准。 */
function inheritedEnabled(prev) { return !!(prev && prev.version >= 2 && prev.enabled === true); }

export function setEnabled({ out = DEFAULT_OUT, enabled = true } = {}) {
  const calib = readProfile(out);
  if (!calib) throw new Error(`档案不存在或损坏: ${out}`);
  calib.enabled = enabled === true;
  writeCalibration(calib, { out });
  return calib.enabled;
}

/**
 * 自动重建(供 prompt-guard --check 后台分支调用):DB 比档案新、且距上次 ≥6h 才做。
 * 重建保留原档案的 enabled(人工开关不被自动流程改掉)。全程 fail-open;返回 {state, reason}。
 */
export function maybeRecalibrate({ dbPath = DEFAULT_DB, out = DEFAULT_OUT, minIntervalMs = MIN_INTERVAL_MS, now = Date.now() } = {}) {
  try {
    let calibMtime = 0;
    try { calibMtime = fs.statSync(out).mtimeMs; } catch { /* 无档案 */ }
    if (calibMtime && now - calibMtime < minIntervalMs) return { state: 'skipped', reason: '档案比阈值新' };
    let dbMtime = 0;
    try { dbMtime = fs.statSync(dbPath).mtimeMs; } catch { return { state: 'skipped', reason: '无本机会话库' }; }
    if (calibMtime && dbMtime <= calibMtime) return { state: 'skipped', reason: 'DB 无新数据' };
    const { turns, population } = readOutcomeTurns({ dbPath });
    if (turns.length < 50) return { state: 'skipped', reason: `样本不足(${turns.length})` };
    const calib = buildCalibration(turns, { population, enabled: inheritedEnabled(readProfile(out)) });
    writeCalibration(calib, { out });
    return { state: 'built', reason: `${turns.length} 轮(${population}) → ${Object.keys(calib.rules).length} 条规则`, calib };
  } catch (e) {
    return { state: 'failed', reason: String(e && e.message ? e.message : e) };
  }
}

// ---------- CLI ----------

/** 档案摘要(--report):含"离生效还差多少样本"和规则名漂移。 */
function report(file = DEFAULT_OUT) {
  const c = readProfile(file);
  if (!c) throw new Error(`档案不存在或损坏: ${file}`);
  console.log(`校准档案 ${file}  构建于 ${c.builtAt}  口径 ${c.population}  样本 ${c.turns} 轮  minN=${c.minN}  启用=${c.enabled === true ? '是(置信度已缩放)' : '否(仅审阅,分类器不消费)'}`);
  console.log('规则'.padEnd(20), '样本'.padStart(6), '动作率'.padStart(7), '重活率'.padStart(7), '零工具'.padStart(7), '错/轮'.padStart(6), '倍数'.padStart(6), '状态');
  for (const [rule, r] of Object.entries(c.rules)) {
    console.log(rule.padEnd(20), String(r.n).padStart(6), String(r.actionRate).padStart(7), String(r.heavyRate).padStart(7), String(r.answerRate).padStart(7), String(r.errorAvg ?? '-').padStart(6), String(r.multiplier).padStart(6), r.active ? '生效' : `样本不足(还差 ${r.gapToMinN})`);
  }
  const unclaimed = Object.entries(c.unclaimed || {}).filter(([, n]) => n > 0);
  if (unclaimed.length) console.log(`[漂移] 规则名不在校验表内(统计被丢弃,需补 RULE_CLAIM): ${unclaimed.map(([k, n]) => `${k}×${n}`).join(', ')}`);
  const missing = Object.keys(RULE_CLAIM).filter((k) => !c.rules[k]);
  if (missing.length) console.log(`[未覆盖] 本轮次里一条都没命中过的规则: ${missing.join(', ')}`);
}

/**
 * 待审清单(--misfire-report,只读不写):按当前倍数列出哪些规则已跌破改写阈值、
 * 以及这些规则的真实样本 prompt,供人工判"是真误判还是形态标签不准"。自动流程不改词表、不改权重。
 */
function misfireReport({ dbPath = DEFAULT_DB, out = DEFAULT_OUT, examples = 5 } = {}) {
  const c = readProfile(out);
  if (!c) throw new Error(`档案不存在,先 --build: ${out}`);
  console.log(`口径 ${c.population}  样本 ${c.turns} 轮  改写阈值 ${REWRITE_THRESHOLD}(只有 T4 会真的改写模型)`);
  const hits = [];
  for (const [rule, r] of Object.entries(c.rules)) {
    const base = Number(r.baseConfidence) || 0.8;
    const scaled = Math.round(base * (Number(r.multiplier) || 1) * 100) / 100;
    const below = scaled < REWRITE_THRESHOLD;
    hits.push({ rule, type: r.type, n: r.n, base, multiplier: r.multiplier, scaled, below, gapToMinN: r.gapToMinN });
  }
  hits.sort((a, b) => a.scaled - b.scaled);
  for (const h of hits) console.log(`${h.below ? '✗ 跌破阈值' : '· 可用  '} ${h.rule}  档${h.type}  置信 ${h.base}×${h.multiplier}=${h.scaled}  样本 ${h.n}${h.gapToMinN ? ` (生效还差 ${h.gapToMinN})` : ''}`);
  const bad = hits.filter((h) => h.below && h.n >= (c.minN || 20));
  if (!bad.length) { console.log('无跌破且样本足够的规则(小样本规则只统计不动手)。'); return; }
  const { turns } = readOutcomeTurns({ dbPath });
  for (const h of bad) {
    const claim = RULE_CLAIM[h.rule] || {};
    const countKey = (claim.metric || 'actionRate').replace(/Rate$/, '');
    const yesLabel = { action: '声称动手:有写或有派发', heavy: '声称重活:调用≥10或写≥3', answer: '声称只问答:零工具调用' }[countKey] || countKey;
    console.log(`\n[${h.rule}] 待人工抽查 ${Math.min(examples, h.n)} 条(校验口径=${yesLabel},实测 ${(c.rules[h.rule][claim.metric] * 100).toFixed(0)}%,基线 ${(claim.baseline * 100).toFixed(0)}%):`);
    let shown = 0;
    for (const t of turns) {
      const cl = classifyPromptRaw(t.prompt);
      if (!cl || cl.rule !== h.rule) continue;
      const s = shapeOf(t);
      console.log(`  - ${s[countKey] ? '✓ 符合' : '✗ 不符'}(调用 ${t.toolCalls},写 ${t.writes},派发 ${t.dispatches}) ${t.prompt.replace(/\s+/g, ' ').slice(0, 80)}`);
      if (++shown >= examples) break;
    }
  }
  console.log('\n处置只有两种:改词表(classify.mjs)或调基线(RULE_CLAIM)——都要人工提交,自动流程不做。');
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self);
if (directRun) {
  const argv = process.argv;
  const has = (f) => argv.includes(f);
  const val = (f, def) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : def);
  try {
    if (has('--report')) {
      report(val('--out', DEFAULT_OUT));
    } else if (has('--misfire-report')) {
      misfireReport({ dbPath: val('--db', DEFAULT_DB), out: val('--out', DEFAULT_OUT), examples: Number(val('--examples', 5)) || 5 });
    } else if (has('--enable') || has('--disable')) {
      console.log(`enabled=${setEnabled({ out: val('--out', DEFAULT_OUT), enabled: has('--enable') })}(消费端 classify.mjs 需档案 enabled===true 才缩放置信度)`);
    } else if (has('--build') || argv.length === 2) {
      const dbPath = val('--db', DEFAULT_DB);
      const out = val('--out', DEFAULT_OUT);
      const minN = Number(val('--min-n', 20)) || 20;
      const { turns, population } = readOutcomeTurns({ dbPath });
      if (!turns.length) { console.error('[err] 未读到可用轮次(检查 db 路径:', dbPath, ')'); process.exit(1); }
      const calib = buildCalibration(turns, { minN, population, enabled: inheritedEnabled(readProfile(out)) });
      writeCalibration(calib, { out });
      console.log(JSON.stringify({ turns: calib.turns, population, rules: Object.keys(calib.rules).length, enabled: calib.enabled, out }));
      if (!calib.enabled) console.log('档案未启用(分类器不消费)。抽查用 --misfire-report;确认无误再 --enable。');
    } else {
      console.error('用法: node calibrateSignals.mjs --build [--db <db.sqlite>] [--out <json>] [--min-n 20] | --report | --misfire-report [--examples 5] | --enable | --disable');
      process.exit(1);
    }
  } catch (e) { console.error('[err]', e.message); process.exit(1); }
}
