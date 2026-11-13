/**
 * 弱监督标签导出(#9 Step②,2026-11-03 由 exportWeakLabels.py 1:1 移植为 Node,随部署单元发布):
 * 从 ZCode 本地 db.sqlite 导出(主会话 turn 的用户 prompt + 工具形态)→ data/routing/raw-labels.jsonl。
 * 标签规则(优先级,2026-11-06 三档定稿):显式 review → 测试写入 → 重实现(we>=3,total>=8)=multi
 * → 轻实现=routine → 方案(plan 信号,零写入)=multi → 报错文本=routine → 零/只读=light
 * → None(uncertain,不入样本库)。
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
import { atomicWriteFileSync } from './proc.mjs';

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

/** 弱标签规则链(2026-11-06 三档定稿;heavy 门槛与投票口径合一——w≥3||total≥15,同 importRoutingLog.labelFromShape:
 *  三套阈值并存时投票/建库/档位真值互相打架,可比样本一致率仅 87.5%,任何"多票合议"的精度提升都被口径噪声吃掉);返回 [label, confidence, rule]。 */
export function labelTurn(prompt, total, we, rd, agent) {
  const p = prompt || '';
  if (REVIEW_RE.test(p)) return ['routine', 0.85, 'review-signal'];
  if (TEST_RE.test(p) && we > 0) return ['routine', 0.8, 'test-prompt+writes'];
  if (we >= 3 || total >= 15) return ['multi', 0.85, 'heavy-writes'];
  // routine 支加 total≥3 护栏是有意差异(2026-11-10 二次审计 P1-10.4):we 是从 prompt 文本
  // 估的写数(有噪),无护栏会把噪声轮错标 routine;与行为计数域(tierTruth.labelFromCounts)
  // 勿盲目合并,口径对照关系见 tierTruth 头注。
  if (we >= 1 && total >= 3) return ['routine', 0.8, 'light-writes'];
  if (we === 0 && PLAN_RE.test(p)) return ['multi', 0.7, 'plan-signal'];
  if (we === 0 && ERROR_RE.test(p)) return ['routine', 0.7, 'error-text'];
  if (total === 0) return ['light', 0.9, 'zero-tools'];
  if (we === 0 && rd > 0) return ['light', 0.6, 'read-only'];
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
  const best = new Map(); // 同 prompt 哈希 → 保留置信最高的一条(仅用于摘要与并集补写判定)
  const oldPool = []; // 旧文件条目按原序暂存(E3 保护:db 清理后旧池条目要能原样回写)
  // 并集保护(2026-11-08):ZCode 会话库会被清理(旧 turn 从 db 消失),全量替换导出会让样本池缩水,
  // 连带 exemplars 重建截断(实弹:769→32 触发 332→26)。写前与既有 out 文件按同款 prompt 哈希并集:
  // 旧条目保留,db 重导仅在置信更高时在摘要面覆盖;文件面保持 py 原语义(按序全量,含同话重复行)。
  try {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.prompt) {
          const k = crypto.createHash('sha1').update(String(o.prompt).replace(/\s+/g, ' ').trim().toLowerCase(), 'utf8').digest('hex');
          if (!best.has(k)) best.set(k, o);
          oldPool.push(o);
        }
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 首装无旧文件 */ }
  let n = 0;
  const linesOut = [];
  const dbKeys = new Set();
  try {
    const q = `
      SELECT tu.turn_id tid, tu.session_id sid, tu.tool_call_count tc,
             s.directory dir, s.task_type ttype
      FROM turn_usage tu JOIN session s ON s.id=tu.session_id
      WHERE s.task_type='interactive' AND tu.status='completed' AND tu.tool_call_count IS NOT NULL` +
      (limit > 0 ? ' LIMIT ?' : '');
    const stmt = db.prepare(q);
    const rows = limit > 0 ? stmt.all(limit) : stmt.all();
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
        const prev = best.get(key);
        const rec = {
          id: 'w-' + key.slice(0, 12), turnId: r.tid, project: proj,
          prompt: prompt.slice(0, 600), toolCalls: total, writeEdits: we, reads: rd,
          spawnedAgents: agent, label, confidence: conf,
          labelRule: rule, pool: 'weak-v1',
        };
        // 文件面:每行都落(py 原语义,同话重复行保留,去重由消费方 buildExemplars 负责);
        // 摘要面:同 key 只留置信最高的一条。
        if (!prev || conf > (Number(prev.confidence) || 0)) best.set(key, rec);
        dbKeys.add(key);
        linesOut.push(JSON.stringify(rec));
        n += 1;
      }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // 并集池一次原子落盘(2026-11-10 审计修复 + 夜审 S5-F1 修复):本轮 db 行全文 + 旧文件里
    // db 已不存在的条目原样追回——文件保持"按序全量"契约,同时 E3(db 清理后重导)池不缩。
    for (const o of oldPool) {
      const k = crypto.createHash('sha1').update(String(o.prompt).replace(/\s+/g, ' ').trim().toLowerCase(), 'utf8').digest('hex');
      if (!dbKeys.has(k)) linesOut.push(JSON.stringify(o));
    }
    atomicWriteFileSync(out, linesOut.join('\n') + '\n');
  } finally { db.close(); }
  const labels = {};
  const projects = {};
  for (const rec of best.values()) {
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
