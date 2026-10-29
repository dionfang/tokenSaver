#!/usr/bin/env node
/**
 * A/B 记账。用法:
 *   node record.mjs --task t1 --cond A --pass pass --agent agent_xxx --since ISO
 *     [--rollout 目录] [--runs 目录] [--out results.jsonl] [--agents AGENTS.md]
 *     [--replace] [--dry]
 *
 * 归属规则(硬约束):
 *   只接受 sessionId === 'sess_subagent_' + agentId 的记录。
 *   不能按“整行包含 agentId”匹配:主会话的历史里也会出现这个 id，
 *   会把主会话的 input/output tokens 混进来(第一轮实验就是这样被污染的)。
 *   子代理 rollout 会被客户端清理(只留最近两个)，所以必须在 Agent 返回后
 *   立刻执行本命令，并把源文件复制到 data/ab/runs/ 作为持久证据。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(name);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const die = (m) => { console.error(`[err] ${m}`); process.exit(1); };

const taskId = opt('--task');
const cond = opt('--cond');
const pass = opt('--pass');
const agentId = opt('--agent');
const sinceRaw = opt('--since');
if (!taskId || !cond || !pass || !agentId || !sinceRaw) {
  die('参数不全: --task --cond --pass --agent --since');
}
if (cond !== 'A' && cond !== 'B') die('--cond 只能是 A 或 B');
if (pass !== 'pass' && pass !== 'fail') die('--pass 只能是 pass 或 fail');
const since = Date.parse(sinceRaw);
if (!Number.isFinite(since)) die(`--since 不是合法时间: ${sinceRaw}`);

const tasksPath = path.resolve(opt('--tasks', path.join(here, 'tasks.json')));
const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')).tasks;
const task = tasks.find(t => t.id === taskId);
if (!task) die(`tasks.json 里没有任务 ${taskId}`);

const agentsPath = path.resolve(opt('--agents', path.join(root, 'AGENTS.md')));
const agents = fs.readFileSync(agentsPath, 'utf8');
const hasPonytail = agents.includes('<!-- ponytail -->');
if (hasPonytail !== (cond === 'B')) {
  die(`AGENTS.md 当前是 ${hasPonytail ? 'B(有 ponytail)' : 'A(无 ponytail)'}，与 --cond ${cond} 不一致`);
}

const promptPath = path.resolve(here, task.prompt);
if (!fs.existsSync(promptPath)) die(`找不到提示词 ${promptPath}`);
const promptSha = crypto.createHash('sha256').update(fs.readFileSync(promptPath)).digest('hex');

const sid = `sess_subagent_${agentId}`;
const rolloutDir = path.resolve(opt('--rollout', path.join(os.homedir(), '.zcode', 'cli', 'rollout')));
const src = path.join(rolloutDir, `model-io-${sid}.jsonl`);
if (!fs.existsSync(src)) {
  die(`找不到子代理 rollout: ${src}\n      子代理文件只保留最近两个，必须在 Agent 返回后立刻 record；缺失只能重跑该次任务。`);
}

const seen = new Set();
const records = [];
const models = new Set();
let totalInFile = 0;
const sources = {};
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  if (j?.type !== 'model_io' || j.error) continue;
  const u = j.response?.usage;
  if (!u) continue;
  totalInFile++;
  if (String(j.sessionId) !== sid) continue;
  const t = Date.parse(j.startedAt);
  if (!(t >= since)) continue;
  const input = num(u.inputTokens);
  const output = num(u.outputTokens);
  if (!input && !output) continue;
  const rid = String(j.requestId || `${sid}:${records.length}`);
  if (seen.has(rid)) continue;
  seen.add(rid);
  if (j.model?.modelId) models.add(String(j.model.modelId));
  sources[j.querySource || ''] = (sources[j.querySource || ''] || 0) + 1;
  records.push({
    input,
    output,
    cacheRead: num(u.cacheReadTokens),
    cacheWrite: num(u.cacheWriteTokens),
  });
}
if (!records.length) {
  die(`归属失败: ${src} 里没有 ${sid} 且 startedAt >= ${new Date(since).toISOString()} 的有效 usage`);
}

const usage = records.reduce((s, r) => ({
  input: s.input + r.input,
  output: s.output + r.output,
  cacheRead: s.cacheRead + r.cacheRead,
  cacheWrite: s.cacheWrite + r.cacheWrite,
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const runsDir = path.resolve(opt('--runs', path.join(root, 'data/ab/runs')));
const dest = path.join(runsDir, `${taskId}-${cond}.jsonl`);
const out = path.resolve(opt('--out', path.join(root, 'data/ab/results.jsonl')));
const replace = flag('--replace');
const dry = flag('--dry');

if (!dry) {
  fs.mkdirSync(runsDir, { recursive: true });
  if (fs.existsSync(dest) && !replace) {
    die(`${dest} 已存在。确认重跑请加 --replace`);
  }
  fs.copyFileSync(src, dest);

  if (fs.existsSync(out)) {
    const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
    const keep = [];
    let dup = false;
    for (const l of lines) {
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      if (r.task === taskId && r.cond === cond) { dup = true; continue; }
      keep.push(l);
    }
    if (dup && !replace) die(`${out} 已有 ${taskId} ${cond} 的记录。确认重跑请加 --replace`);
    fs.writeFileSync(out, keep.length ? keep.join('\n') + '\n' : '');
  }
}

const rec = {
  ts: new Date().toISOString(),
  task: taskId,
  cond,
  pass: pass === 'pass',
  ponytail: hasPonytail,
  agentId,
  sessionId: sid,
  since: new Date(since).toISOString(),
  promptSha,
  rollout: path.relative(root, dest).split(path.sep).join('/'),
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  requests: records.length,
  totalInFile,
  sources,
  models: [...models],
  ...(num(opt('--tool-tokens')) ? { toolTokens: num(opt('--tool-tokens')) } : {}),
};

if (!dry) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, JSON.stringify(rec) + '\n');
}
console.log(JSON.stringify(rec, null, 1));
