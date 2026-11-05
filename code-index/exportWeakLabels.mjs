/**
 * 弱监督标签导出(#9 Step②,2026-11-03 由 exportWeakLabels.py 1:1 移植为 Node,随部署单元发布):
 * 从 ZCode 本地 db.sqlite 导出(主会话 turn 的用户 prompt + 工具形态)→ data/routing/raw-labels.jsonl。
 * 标签规则(优先级):显式 review → 测试写入 → 重实现(we>=3,total>=8)=T4 → 轻实现=T3
 * → 方案(plan 信号,零写入)=T5 → 报错文本=T2 → 零/只读=T1 → None(uncertain,不入样本库)。
 * 产出由 buildExemplars.mjs 消费(schema 与 py 版逐字段一致,label=null 行被消费方排除)。
 * db 用 node:sqlite 只读打开(Node>=22.5;不可用时显式报错,与 importRoutingLog 同口径)。
 * 用法:node exportWeakLabels.mjs [--db 路径] [--out 路径] [--limit N]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';

const HOME = os.homedir();
export const DEFAULT_DB = path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite');
export const DEFAULT_OUT = path.join(DATA_DIR, 'routing', 'raw-labels.jsonl');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch']);
const REVIEW_RE = /\/review|审查|评审|检查.{0,6}代码|代码审查|找问题|有没有问题|隐患/i;
const TEST_RE = /写测试|单测|单元测试|测试用例|覆盖率|回归测试|跑测试|测试不过|test case|unit test/i;
const PLAN_RE = /方案|选型|可行性|排期|规划|架构设计|技术设计|设计方案/i;
const ERROR_RE = /报错|不生效|没反应|异常|崩了|崩溃|白屏|TypeError|Exception|Traceback|调用失败|请求失败|接口报错/i;

/** 还原该轮真实用户话:剥掉常见系统注入前缀([code-index]/[model-routing]/[Hook additional context])。 */
export function stripInjectionMarkers(txt) {
  for (const marker of ['[code-index]', '[model-routing]', '[Hook additional context]']) {
    if (txt.includes(marker)) txt = txt.split(marker)[0].trim();
  }
  return txt;
}

/** 弱标签规则链(与 py 版逐条一致);返回 [label, confidence, rule]。 */
export function labelTurn(prompt, total, we, rd, agent) {
  const p = prompt || '';
  if (REVIEW_RE.test(p)) return ['T6', 0.85, 'review-signal'];
  if (TEST_RE.test(p) && we > 0) return ['T7', 0.8, 'test-prompt+writes'];
  if (we >= 3 && total >= 8) return ['T4', 0.85, 'heavy-writes'];
  if (we >= 1 && total >= 3) return ['T3', 0.8, 'light-writes'];
  if (we === 0 && PLAN_RE.test(p)) return ['T5', 0.7, 'plan-signal'];
  if (we === 0 && ERROR_RE.test(p)) return ['T2', 0.7, 'error-text'];
  if (total === 0) return ['T1', 0.9, 'zero-tools'];
  if (we === 0 && rd > 0) return ['T1', 0.6, 'read-only'];
  return [null, 0.0, 'uncertain'];
}

/** 从 part 表拼回该轮 parent 用户消息全文(prompt_of_turn)。 */
export function promptOfTurn(db, turnId) {
  const pm = db.prepare(`
    SELECT mu.parent_user_message_id pmid FROM model_usage mu
    WHERE mu.turn_id=? AND mu.parent_user_message_id IS NOT NULL
    ORDER BY mu.started_at LIMIT 1`).get(turnId);
  if (!pm || !pm.pmid) return null;
  const parts = db.prepare('SELECT data FROM part WHERE message_id=? ORDER BY sequence').all(pm.pmid);
  const texts = [];
  for (const p of parts) {
    try {
      const d = JSON.parse(p.data);
      if (typeof d?.text === 'string' && d.text.trim()) texts.push(d.text);
    } catch { /* 非 text part 跳过 */ }
  }
  const txt = stripInjectionMarkers(texts.join('\n').trim());
  return txt || null;
}

/**
 * 主入口:导出弱标签样本。返回 {count, labels, projects, out, db} 或 {error}。
 * 文件按序全量落盘(含 label=null 与同话重复行,消费方 buildExemplars 负责 null 排除与合并);
 * labels/projects 摘要按"同话保留置信更高的一条"去重;prompt<4 字符丢弃;prompt 截 600 字符。
 */
export function exportWeakLabels({ db: dbPath = DEFAULT_DB, out = DEFAULT_OUT, limit = 0 } = {}) {
  let DatabaseSync;
  try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); }
  catch { return { error: 'node:sqlite 不可用(需要 Node>=22.5)' }; }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); }
  catch (e) { return { error: `db 打不开:${e.message}` }; }
  const seenPrompt = new Map();
  let n = 0;
  try {
    const q = `
      SELECT tu.turn_id tid, tu.session_id sid, tu.tool_call_count tc,
             s.directory dir, s.task_type ttype
      FROM turn_usage tu JOIN session s ON s.id=tu.session_id
      WHERE s.task_type='interactive' AND tu.status='completed' AND tu.tool_call_count IS NOT NULL` +
      (limit > 0 ? ' LIMIT ?' : '');
    const stmt = db.prepare(q);
    const rows = limit > 0 ? stmt.all(limit) : stmt.all();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const f = fs.openSync(out, 'w');
    try {
      for (const r of rows) {
        const prompt = promptOfTurn(db, r.tid);
        if (!prompt || prompt.length < 4) continue;
        const tools = db.prepare('SELECT tool_name tn, status FROM tool_usage WHERE turn_id=?').all(r.tid);
        const we = tools.filter((t) => WRITE_TOOLS.has(t.tn)).length;
        const rd = tools.filter((t) => READ_TOOLS.has(t.tn)).length;
        const agent = tools.filter((t) => t.tn === 'Agent').length;
        const total = r.tc;
        const [label, conf, rule] = labelTurn(prompt, total, we, rd, agent);
        const proj = path.basename(String(r.dir || '').replace(/[\\/]+$/, '')) || 'unknown';
        const key = crypto.createHash('sha1').update(prompt.replace(/\s+/g, ' ').trim().toLowerCase(), 'utf8').digest('hex');
        const prev = seenPrompt.get(key);
        if (prev && conf <= prev.confidence) continue; // 同话重复 turn:保留标签置信更高的一条
        const rec = {
          id: 'w-' + key.slice(0, 12), turnId: r.tid, project: proj,
          prompt: prompt.slice(0, 600), toolCalls: total, writeEdits: we, reads: rd,
          spawnedAgents: agent, label, confidence: conf,
          labelRule: rule, pool: 'weak-v1',
        };
        seenPrompt.set(key, rec);
        fs.writeSync(f, JSON.stringify(rec) + '\n');
        n += 1;
      }
    } finally { fs.closeSync(f); }
  } finally { db.close(); }
  const labels = {};
  const projects = {};
  for (const rec of seenPrompt.values()) {
    labels[rec.label] = (labels[rec.label] || 0) + 1;
    projects[rec.project] = (projects[rec.project] || 0) + 1;
  }
  return { count: n, labels, projects, out, db: dbPath };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  const argv = process.argv.slice(2);
  const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
  const r = exportWeakLabels({
    db: opt('--db', DEFAULT_DB),
    out: opt('--out', DEFAULT_OUT),
    limit: Number(opt('--limit', 0)) || 0,
  });
  if (r.error) { console.error('[err]', r.error); process.exit(1); }
  console.log(`导出完成: ${r.count} 条 → ${r.out}`);
  console.log('标签分布:', JSON.stringify(r.labels));
  console.log('项目分布:', JSON.stringify(r.projects));
}
