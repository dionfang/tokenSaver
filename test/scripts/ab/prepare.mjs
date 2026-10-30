#!/usr/bin/env node
/**
 * A/B 运行前置检查。用法:
 *   node prepare.mjs <task> <A|B> [--force] [--mark 标记]
 *   [--agents 路径] [--tasks 文件] [--work-root 目录] [--results 文件]
 *
 * 做的事:
 *   1. 清空任务工作目录(防止上一次条件留下的文件让 agent 只核对不重写)
 *   2. 复制输入文件
 *   3. 校验 AGENTS.md 当前状态与条件一致(A=无规则段,B=有;默认查 <!-- ponytail -->)
 *   4. 同一 task+cond 已有记录时拒绝,除非 --force
 * 输出 JSON,其中 start 是本次运行的记账起点,dispatch 后原样传给 record.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);

const taskId = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--agents' && argv[argv.indexOf(a) - 1] !== '--tasks' && argv[argv.indexOf(a) - 1] !== '--work-root' && argv[argv.indexOf(a) - 1] !== '--results' && argv[argv.indexOf(a) - 1] !== '--mark');
const cond = argv.find(a => a === 'A' || a === 'B') || argv[2];
if (!taskId || (cond !== 'A' && cond !== 'B')) {
  console.error('用法: node prepare.mjs <task> <A|B> [--force] [--mark 标记]');
  process.exit(1);
}

const mark = opt('--mark', '<!-- ponytail -->');

const tasksPath = path.resolve(opt('--tasks', path.join(here, 'tasks.json')));
const agentsPath = path.resolve(opt('--agents', path.join(root, 'AGENTS.md')));
const resultsPath = path.resolve(opt('--results', path.join(root, 'data/ab/results.jsonl')));
const workRoot = opt('--work-root');

const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')).tasks;
const task = tasks.find(t => t.id === taskId);
if (!task) {
  console.error(`[err] tasks.json 里没有任务 ${taskId}`);
  process.exit(1);
}

if (!flag('--force') && fs.existsSync(resultsPath)) {
  const done = fs.readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .find(r => r.task === taskId && r.cond === cond);
  if (done) {
    console.error(`[err] ${taskId} ${cond} 已有记录。重跑请加 --force，并在 record 时加 --replace。`);
    process.exit(1);
  }
}

const work = workRoot
  ? path.resolve(workRoot, path.basename(task.work))
  : path.resolve(root, task.work);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
for (const rel of task.inputs || []) {
  const src = path.resolve(here, rel);
  fs.copyFileSync(src, path.join(work, path.basename(src)));
}

const content = fs.readFileSync(agentsPath, 'utf8');
const hasRules = content.includes(mark);
const expected = cond === 'B';
if (hasRules !== expected) {
  console.error(`[err] AGENTS.md 状态是 ${hasRules ? 'B(有规则段)' : 'A(无规则段)'}(${mark}),与 ${cond} 不一致。`);
  console.error(`      先运行: node test/scripts/ab/condition.mjs ${cond} --mark "${mark}" [--rules 规则文件]`);
  process.exit(1);
}

const prompt = path.resolve(here, task.prompt);
if (!fs.existsSync(prompt)) {
  console.error(`[err] 找不到提示词 ${prompt}`);
  process.exit(1);
}

console.log(JSON.stringify({
  task: task.id,
  name: task.name,
  cond,
  work,
  prompt,
  start: new Date().toISOString(),
  force: flag('--force'),
}, null, 1));
