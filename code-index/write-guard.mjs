#!/usr/bin/env node
/**
 * PreToolUse Write 行数阈值守卫(硬约束实验,规则 10 管辖):
 *   enabled=false(默认)时纯透传;enabled=true 时对单次 Write 超过 maxWriteLines 的调用 deny,
 *   指引拆分写入;同一文件 5 分钟内重发放行(防死循环,沿 read-guard 惯例);Edit 永远放行。
 * 配置:data/write-guard/config.json = {"enabled":bool,"maxWriteLines":number}(独立文件,免疫 init 配置重写)。
 * 事件:data/write-guard/events.jsonl = {at,session,file,lines,kind:'WriteDeny'|'Allow2nd'}。
 * 本钩子是实验性硬约束:已知机制局限——PreToolUse 在内容生成之后触发,拒绝会使 F+D>F,
 *   它的价值是实测"拆分写入的输出代价与质量风险",为阈值选址提供数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(DATA_DIR, 'write-guard', 'config.json');
const EVENTS_PATH = path.join(DATA_DIR, 'write-guard', 'events.jsonl');
const OVERRIDE_WINDOW_MS = 5 * 60_000;

function readCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    return { enabled: c.enabled === true, maxWriteLines: Math.max(1, Math.round(Number(c.maxWriteLines) || 0)) };
  } catch { return { enabled: false, maxWriteLines: 0 }; }
}

function readDenials() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'write-guard', 'denials.json'), 'utf8')); } catch { return {}; }
}

function saveDenials(d) {
  try { fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, 'write-guard', 'denials.json'), JSON.stringify(d)); } catch { /* 留痕失败不影响决策 */ }
}

async function trackEvent(entry) {
  try {
    fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
    fs.appendFileSync(EVENTS_PATH, JSON.stringify(entry) + '\n');
  } catch { /* 留痕失败不影响决策 */ }
}

/** 纯决策函数(供测试):返回 'deny' | 'allow' | 'allow-override'。 */
export function writeGuardDecision({ enabled, maxWriteLines, fileExists, lines, deniedAt, now, overrideWindowMs = OVERRIDE_WINDOW_MS }) {
  if (!enabled) return 'allow';
  if (!Number.isFinite(maxWriteLines) || maxWriteLines <= 0) return 'allow';
  if (!Number.isFinite(lines) || lines <= 0) return 'allow';
  if (lines <= maxWriteLines) return 'allow';
  if (Number.isFinite(deniedAt) && now - deniedAt < overrideWindowMs) return 'allow-override';
  return 'deny';
}

function denyBody({ file, lines, maxWriteLines }) {
  return (
    `code-index: ${file} 本次 Write 共 ${lines} 行,超过单次 Write 上限 ${maxWriteLines} 行。` +
    `拆分写入:先 Write 前半,再用 Edit 追加其余;若确需全量写,5 分钟内对同一文件重发同样的 Write 即放行。`
  );
}

function respond(body) { process.stdout.write(JSON.stringify(body)); }

function emitDialect(dialect, body) {
  // ZCode 实测采纳 hookSpecificOutput;其余宿主退化为 {permission}
  if (dialect === 'zcode' || dialect === 'qoder') respond(body);
  else respond(body.hookSpecificOutput
    ? { permission: body.hookSpecificOutput.permissionDecision, agent_message: body.hookSpecificOutput.permissionDecisionReason }
    : body);
}

async function run() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw); } catch { respond({}); return; }
  const cfg = readCfg();
  const now = Date.now();
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const file = ti.file_path ? path.resolve(input.cwd || process.cwd(), ti.file_path) : '';
  const dialect = /zcode/i.test(String(input.agent || '')) || input.hook_event_name === 'PreToolUse' ? 'zcode' : 'claude';

  if (tool !== 'Write' || !file) { respond({}); return; }
  const fileExists = fs.existsSync(file);
  const content = String(ti.content || '');
  const lines = content ? content.split('\n').length : 0;
  const session = String(input.session_id || 'unknown');

  const decision = writeGuardDecision({
    enabled: cfg.enabled,
    maxWriteLines: cfg.maxWriteLines,
    fileExists,
    lines,
    deniedAt: readDenials()[session + '|' + file]?.at,
    now,
  });

  if (decision === 'allow') { respond({}); return; }

  if (decision === 'allow-override') {
    await trackEvent({ at: now, session, file, lines, kind: 'Allow2nd' });
    const d = readDenials();
    delete d[session + '|' + file];
    saveDenials(d);
    respond({});
    return;
  }

  const body = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denyBody({ file, lines, maxWriteLines: cfg.maxWriteLines }),
    },
  };
  const d = readDenials();
  d[session + '|' + file] = { at: now };
  saveDenials(d);
  await trackEvent({ at: now, session, file, lines, kind: 'WriteDeny' });
  emitDialect(dialect, body);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  try { await run(); } catch { respond({}); }
  process.exit(0);
}