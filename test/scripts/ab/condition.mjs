#!/usr/bin/env node
/**
 * A/B 条件切换:只改 AGENTS.md 末尾的规则段。
 *   A = 去掉规则段;B = 保留/追加。
 * A 之前把完整原文备份到 data/ab/AGENTS.backup.md;B 从备份恢复。
 * 不用 git restore,避免丢掉 AGENTS.md 里未提交的其他改动。
 *
 * 两种模式:
 *   默认(ponytail 模式):段标记 <!-- ponytail -->,B = 原样恢复备份(init.mjs 维护)。
 *   --rules <文件>:B = 备份原文 + 在末尾追加「标记 + 规则文件内容」;标记由 --mark 指定。
 *   备份里已含标记时 B 只恢复备份,不会二次追加。
 *
 * 用法:
 *   node condition.mjs A|B [--mark 标记] [--rules 规则文件]
 *   node condition.mjs --status
 *   node condition.mjs --restore
 *   [--agents 路径] [--backup 路径]  (测试用)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const DEFAULT_MARK = '<!-- ponytail -->';
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const mark = opt('--mark', DEFAULT_MARK);
const rulesPath = opt('--rules') ? path.resolve(opt('--rules')) : null;
const agentsPath = path.resolve(opt('--agents', path.join(root, 'AGENTS.md')));
const backupPath = path.resolve(opt('--backup', path.join(root, 'data/ab/AGENTS.backup.md')));
let cmd = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--agents' || a === '--backup' || a === '--mark' || a === '--rules') { i++; continue; }
  if (!cmd && !a.startsWith('--')) cmd = a;
}

function readAgents() {
  try { return fs.readFileSync(agentsPath, 'utf8'); } catch { return null; }
}
function state(content) {
  return content && content.includes(mark) ? 'B' : 'A';
}
function writeBackup(content) {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, content);
}
function status() {
  const c = readAgents();
  const s = state(c);
  console.log(JSON.stringify({ agents: agentsPath, state: s, backup: fs.existsSync(backupPath) }));
}

if (cmd === '--status' || cmd === 'status' || argv.includes('--status')) {
  status();
  process.exit(0);
}

if (cmd === '--restore' || cmd === 'restore' || argv.includes('--restore')) {
  if (!fs.existsSync(backupPath)) {
    console.log('[ok] 没有备份，无需恢复');
    process.exit(0);
  }
  fs.copyFileSync(backupPath, agentsPath);
  fs.rmSync(backupPath, { force: true });
  console.log('[ok] 已从备份恢复 AGENTS.md');
  status();
  process.exit(0);
}

if (cmd !== 'A' && cmd !== 'B') {
  console.error('用法: node condition.mjs A|B|--status|--restore [--mark 标记] [--rules 规则文件] [--agents 路径] [--backup 路径]');
  process.exit(1);
}

const content = readAgents();
if (content == null) {
  console.error(`[err] 读不到 ${agentsPath}`);
  process.exit(1);
}
const now = state(content);
if (now === cmd) {
  console.log(`[ok] 已是 ${cmd}`);
  status();
  process.exit(0);
}

if (cmd === 'A') {
  const idx = content.indexOf(mark);
  // 规则段只会在文件末尾;实验期间不要在其后追加内容
  if (!fs.existsSync(backupPath)) {
    writeBackup(content);
    console.log(`[ok] 已备份原文到 ${backupPath}`);
  } else {
    console.log(`[warn] 备份已存在，未覆盖:${backupPath}`);
  }
  const next = (idx === -1 ? content : content.slice(0, idx)).replace(/\s+$/, '') + '\n';
  fs.writeFileSync(agentsPath, next);
  console.log(`[ok] 已切到 A(无 ${mark} 段)`);
  status();
  process.exit(0);
}

// cmd === 'B'
if (!fs.existsSync(backupPath)) {
  if (!rulesPath) {
    console.error('[err] 没有备份，无法恢复 B。请从版本控制恢复 AGENTS.md，或提供 --rules 从当前原文重建。');
    process.exit(1);
  }
  writeBackup(content);
  console.log(`[ok] 已备份当前原文到 ${backupPath}`);
}
const base = fs.readFileSync(backupPath, 'utf8');
let next;
if (base.includes(mark)) {
  next = base;
} else {
  if (!rulesPath || !fs.existsSync(rulesPath)) {
    console.error(`[err] 备份里没有 ${mark} 段，且未提供 --rules 文件，无法重建 B。`);
    process.exit(1);
  }
  const rules = fs.readFileSync(rulesPath, 'utf8').trimEnd();
  next = base.replace(/\s+$/, '') + '\n\n' + mark + '\n' + rules + '\n';
}
fs.writeFileSync(agentsPath, next);
fs.rmSync(backupPath, { force: true });
console.log(`[ok] 已切到 B(有 ${mark} 段)`);
status();
