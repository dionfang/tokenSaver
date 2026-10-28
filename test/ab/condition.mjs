#!/usr/bin/env node
/**
 * A/B 条件切换:只改 AGENTS.md 末尾的 ponytail 段。
 *   A = 去掉 ponytail;B = 保留。
 * A 之前把完整原文备份到 data/ab/AGENTS.backup.md;B 从备份恢复。
 * 不用 git restore,避免丢掉 AGENTS.md 里未提交的其他改动。
 *
 * 用法:
 *   node condition.mjs A|B
 *   node condition.mjs --status
 *   node condition.mjs --restore
 *   [--agents 路径] [--backup 路径]  (测试用)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const MARK = '<!-- ponytail -->';
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const agentsPath = path.resolve(opt('--agents', path.join(root, 'AGENTS.md')));
const backupPath = path.resolve(opt('--backup', path.join(root, 'data/ab/AGENTS.backup.md')));
let cmd = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--agents' || a === '--backup') { i++; continue; }
  if (!cmd && !a.startsWith('--')) cmd = a;
}

function readAgents() {
  try { return fs.readFileSync(agentsPath, 'utf8'); } catch { return null; }
}
function state(content) {
  return content && content.includes(MARK) ? 'B' : 'A';
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
  console.error('用法: node condition.mjs A|B|--status|--restore [--agents 路径] [--backup 路径]');
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
  const idx = content.indexOf(MARK);
  // ponytail 段由 init.mjs 写在文件末尾；实验期间不要在其后追加内容
  if (!fs.existsSync(backupPath)) {
    writeBackup(content);
    console.log(`[ok] 已备份原文到 ${backupPath}`);
  } else {
    console.log(`[warn] 备份已存在，未覆盖:${backupPath}`);
  }
  const next = content.slice(0, idx).replace(/\s+$/, '') + '\n';
  fs.writeFileSync(agentsPath, next);
  console.log('[ok] 已切到 A(无 ponytail)');
  status();
  process.exit(0);
}

// cmd === 'B'
if (!fs.existsSync(backupPath)) {
  console.error('[err] 没有备份，无法恢复 B。请从版本控制恢复 AGENTS.md，或重新运行 init 生成 ponytail 段。');
  process.exit(1);
}
fs.copyFileSync(backupPath, agentsPath);
fs.rmSync(backupPath, { force: true });
console.log('[ok] 已从备份恢复 B(有 ponytail)');
status();
