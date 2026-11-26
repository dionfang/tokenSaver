#!/usr/bin/env node
/**
 * memorix-cursor-hook.mjs —— Cursor 专用 Memorix 钩子(2026-11-26)。
 *
 * 与 ZCode/Qoder 的 memorix-hook.mjs(--agent claude)分开:本文件只认 --agent cursor,
 * 输出只写 Cursor 认的顶层 additionalContext。不改共享转发器的捕获名单和后台策略。
 *
 * 挂载(init rewriteCursorUserHooks,单文件 memorix-hook-cursor.mjs 按 --event= 分发):
 *   注入:sessionStart / beforeSubmitPrompt(15s)
 *   捕获:afterFileEdit / beforeShellExecution / afterMCPExecution / afterAgentResponse(8s)
 * 编辑正文、MCP 字段、助手回复文本、回复不走 always 入库,由 memorixCursorPatch 打在 CLI 的 cursor 分支上。
 *
 * 捕获保持同步。Cursor 钩子不经 hook-relay,Windows 上脱离进程是否会被宿主收掉尚未验证;
 * 同步虽要等 CLI 起来(约 2s,预算 8s),但不会静默丢记忆。
 *
 * 不挂 stop / preCompact(2026-11-26 审查实弹坐实必空转,各白等一次 CLI 启动):Cursor 的 stop 载荷
 * 只有 status/loop_count,上游 session_end 分支要 ≥50 字内容;preCompact 载荷只有计数没有摘要,
 * Cursor 也没有压缩后事件,上游只写一行永不 complete、永不注入的 pre 标记。
 *
 * fail-open:未装/超时/过滤丢弃/无注入 → {}(beforeSubmitPrompt 回 {continue:true})。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMemorixInjection, memorixHookTimeoutMs, resolveMemorixHookCli, shouldCaptureEvent } from './memorix-hook.mjs';

/** hooks.json 事件名。顺序即追加顺序;超时由 memorixHookTimeoutMs 单源换算成秒。 */
export const CURSOR_MEMORIX_EVENTS = [
  'sessionStart', 'beforeSubmitPrompt', 'afterFileEdit', 'beforeShellExecution',
  'afterMCPExecution', 'afterAgentResponse',
];

export function cursorMemorixTimeoutSec(event) {
  return memorixHookTimeoutMs(event) / 1000;
}

/** 工作区根/cwd 归一(2026-11-26 Cursor 实弹坐实):Cursor 3.27.22 发来的 workspace_roots 是
 *  「/d:/HbuilderX-Project/TokenSaver」(盘符前多一个斜杠),上游 detectProject 原样 existsSync
 *  判 path_not_found → 开场简报只剩标题行、续接只剩兜底提示(整份 Autopilot Brief 丢失)。
 *  只剥这一层「/盘符:」前缀;POSIX 绝对路径(/home/…)与 UNC(//server/share)不动;非字符串不动。 */
export function normalizeCursorPath(p) {
  if (typeof p !== 'string') return p;
  const m = /^\/(?=[A-Za-z]:[\\/])/.exec(p);
  return m ? p.slice(m[0].length) : p;
}

/** 把载荷里的路径字段归一成上游 existsSync 认的形态。仅当确有需要才改写(规整载荷逐字节透传,
 *  保持宿主载荷原样);只动 workspace_roots/cwd 两个上游真正消费的键,session_start 等其余键不动。 */
export function normalizeCursorPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const need =
    (Array.isArray(payload.workspace_roots) && payload.workspace_roots.some((r) => /^\/(?=[A-Za-z]:[\\/])/.test(String(r))))
    || /^\/(?=[A-Za-z]:[\\/])/.test(String(payload.cwd ?? ''));
  if (!need) return payload;
  const out = { ...payload };
  if (Array.isArray(out.workspace_roots)) out.workspace_roots = out.workspace_roots.map(normalizeCursorPath);
  if (out.cwd !== undefined) out.cwd = normalizeCursorPath(out.cwd);
  return out;
}

const ALWAYS_FORWARD = new Set(['sessionStart', 'beforeSubmitPrompt']);

/** 是否把这条 Cursor 事件转发给 memorix。注入恒转发;
 *  afterAgentResponse 短于上游 MIN_PROMPT_LENGTH(20) 不启动 CLI;
 *  Memorix 自己的 MCP 调用不回灌;其余交给 shouldCaptureEvent(琐碎命令)。 */
export function shouldForwardCursorEvent(event, payload) {
  if (!CURSOR_MEMORIX_EVENTS.includes(event)) return false; // 未挂载(含旧 hooks.json 残留的 stop/preCompact)不启动 CLI
  if (ALWAYS_FORWARD.has(event)) return true;
  if (event === 'afterAgentResponse') {
    const text = String(payload?.text ?? payload?.ai_response ?? payload?.last_assistant_message ?? '').trim();
    return text.length >= 20;
  }
  if (!payload || typeof payload !== 'object') return true;
  if (event === 'afterMCPExecution') {
    const server = String(payload.mcp_server_name ?? payload.server_name ?? '');
    const tool = String(payload.tool_name ?? payload.mcp_tool_name ?? payload.tool ?? '');
    if (/memorix/i.test(server) || /^memorix_/i.test(tool) || /^mcp__memorix__/i.test(tool)) return false;
  }
  return shouldCaptureEvent(event, payload);
}

/** stdin → memorix hook --agent cursor → 顶层 additionalContext。捕获类无注入时回 {};
 *  beforeSubmitPrompt 恒带 continue:true(与同事件的 prompt-guard 同形状,不依赖宿主把缺省当放行)。 */
export function runCursorMemorixHook({ event = '', stdinJson = '', cli = null, timeoutMs = memorixHookTimeoutMs(event) } = {}) {
  const resolved = cli || resolveMemorixHookCli({});
  if (!resolved || !event) return {};
  let payload = null;
  try { payload = JSON.parse(stdinJson); } catch { /* 非法 JSON 交给上游 */ }
  if (!shouldForwardCursorEvent(event, payload)) return {};
  // 工作区根/cwd 归一(见 normalizeCursorPath):必要才改写,规整载荷透传
  const fwd = stdinJson && normalizeCursorPayload(payload) !== payload ? JSON.stringify(normalizeCursorPayload(payload)) : stdinJson;
  const hookArgs = ['hook', '--agent', 'cursor', '--event', event];
  let out;
  try {
    const r = spawnSync(resolved.command, [...resolved.args, ...hookArgs], {
      input: fwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      env: { ...process.env, __MEMORIX_HEAP: '1' },
    });
    if (r.status !== 0) return {};
    out = r.stdout;
  } catch { return {}; }
  const ctx = extractMemorixInjection(out);
  const base = event === 'beforeSubmitPrompt' ? { continue: true } : {};
  return ctx ? { ...base, additionalContext: ctx } : base;
}

function eventFromArgv(argv) {
  const eq = argv.find((a) => a.startsWith('--event='));
  if (eq) return eq.slice('--event='.length);
  const i = argv.indexOf('--event');
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  let stdinJson = '';
  try { stdinJson = fs.readFileSync(0, 'utf8'); } catch { /* 无 stdin */ }
  const result = runCursorMemorixHook({ event: eventFromArgv(process.argv.slice(2)), stdinJson });
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
