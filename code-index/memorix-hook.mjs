#!/usr/bin/env node
/**
 * memorix-hook.mjs —— 路A(2026-11-25):Memorix 记忆钩子转发器,通过 TokenSaver 钩子链接入三端。
 *
 * 上游 hook 的两条职责(dist/cli/index.js: handleHookEventCore / handleSessionStart / buildClaudeContinuationPromptContext):
 *   注入:session_start 回一句「需要前情先用 memorix_search」的提示(注入模式非 silent 时恒有);
 *         user_prompt 仅在续接任务(isContinuationTask)/压缩后恢复/onboarding 时回前情摘要,其余无注入。
 *   捕获:post_tool / post_edit / post_command / session_end 把工具调用、命令、改动落成 observation,无注入。
 * 本转发器:捕获类经新版中继时转后台(宿主不等,见 CAPTURE_ONLY_EVENTS / detachSafe),否则同步;
 *   注入类一律同步,把注入内容按 host 分形状输出。
 *
 * 协议(活体实测):stdin 收宿主原始钩子 JSON → spawn `memorix hook --agent <claude|cursor> --event <原始事件名>`
 *   (stdin 透传)→ memorix 回 {continue, systemMessage?, hookSpecificOutput?.additionalContext?}。
 *   本转发器把注入内容(systemMessage 或 additionalContext)按 host 分形状输出:
 *   Cursor=顶层 additionalContext(原生只认这个);ZCode/Qoder=hookSpecificOutput.additionalContext。
 *
 * fail-open:memorix 未装/超时/出错/无注入 → 输出 {}(不阻断宿主钩子链,与现有转发器同口径)。
 * 用法(钩子配置调):node memorix-hook.mjs --agent claude --event UserPromptSubmit [--host zcode|qoder|cursor]
 *   --agent 传给 memorix(ZCode/Qoder 用 claude 通道,Cursor 用 cursor,不改写成 claude);
 *   cursor 的 user_prompt 续接简报由 memorixCursorPatch 打在 CLI 上(stage/init 重装会重打);--event 原始宿主事件名;
 *   --host 决定输出包装(Cursor 顶层 additionalContext;ZCode/Qoder hookSpecificOutput 包)。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 钩子预算(2026-11-26 单源,init.mjs 三端挂载与本常量同步):
 *  SessionStart 在 inject=full 时同步构建整份简报(冷启动 ~2s + 简报数秒),8s 不够 → 15s;
 *  UserPromptSubmit 续接(isContinuationTask)同样走 brief 检索路径,实测 6.5-7.6s 逼近 8s 预算,
 *  机器有负载即踩线被静默丢弃 → 同抬 15s(2026-11-26);其余事件(捕获)维持 8s。 */
export const MEMORIX_SESSION_START_TIMEOUT_MS = 15_000;
export const MEMORIX_DEFAULT_TIMEOUT_MS = 8_000;
export const memorixHookTimeoutMs = (event) => (['sessionstart', 'userpromptsubmit', 'beforesubmitprompt'].includes(String(event).toLowerCase()) ? MEMORIX_SESSION_START_TIMEOUT_MS : MEMORIX_DEFAULT_TIMEOUT_MS);

/** 解析 memorix CLI(与 memorixStatus 同口径:packed→staged→本地 vendor→PATH 兜底)。
 *  packed 自推(2026-11-25 审查修复):装机态本文件恒在 resources/node_modules/code-index/,
 *  据模块目录后缀自推 resources 根(与 memorixStatus.resolveMemorixCli 同单源逻辑)——
 *  此前只认显式 resourcesPath,而钩子转发器由宿主 spawn 时无人传参 → 装机态找不到包内 memorix,
 *  只能回落到开发机 staged(装机目录不存在)→ 恒 fail-open {}。
 *  返回 {command,args} 或 null。 */
export function resolveMemorixHookCli({ resourcesPath = null, moduleDir = here } = {}) {
  if (!resourcesPath) {
    const parent = path.dirname(moduleDir);
    if (path.basename(moduleDir) === 'code-index' && path.basename(parent) === 'node_modules') resourcesPath = path.dirname(parent);
  }
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'node_modules', 'memorix', 'dist', 'cli', 'index.js'));
  candidates.push(path.join(here, '..', 'tray', 'build', 'memorix-staged', 'node_modules', 'memorix', 'dist', 'cli', 'index.js'));
  candidates.push(path.join(moduleDir, 'vendor', 'memorix', 'node_modules', 'memorix', 'dist', 'cli', 'index.js'));
  for (const c of candidates) if (fs.existsSync(c)) return { command: process.execPath, args: [c] };
  return resolveMemorixPathCli({});
}

/** PATH 上的 memorix(存量全局安装兼容,最后一跳)。Windows 上不能直接 spawn .cmd(不带 shell 报
 *  EINVAL,2026-11-26 实测):改起 shim 旁的 JS 入口(npm 全局布局 <prefix>/memorix.cmd +
 *  <prefix>/node_modules/memorix);入口不在就返回 null(fail-open {}),不再给一个起不来的 shim。
 *  probe/platform 可注入供单测;默认 where/which。返回 {command,args} 或 null。 */
export function resolveMemorixPathCli({ platform = process.platform, probe = null } = {}) {
  const shim = platform === 'win32' ? 'memorix.cmd' : 'memorix';
  const r = probe ? probe(shim) : spawnSync(platform === 'win32' ? 'where' : 'which', [shim], { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
  const shimPath = String(r?.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  if (r?.status !== 0 || !shimPath) return null;
  if (platform !== 'win32') return { command: shim, args: [] };
  const entry = path.join(path.dirname(shimPath), 'node_modules', 'memorix', 'dist', 'cli', 'index.js');
  return fs.existsSync(entry) ? { command: process.execPath, args: [entry] } : null;
}

/** 从 memorix hook 输出提取注入文本(纯函数,单测):systemMessage 或 hookSpecificOutput.additionalContext。
 *  捕获类(无注入)返回 null。 */
export function extractMemorixInjection(stdout) {
  let j;
  try { j = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const ctx = j?.hookSpecificOutput?.additionalContext;
  if (typeof ctx === 'string' && ctx.trim()) return ctx;
  if (typeof j.systemMessage === 'string' && j.systemMessage.trim()) return j.systemMessage;
  return null;
}

/** 捕获类事件(2026-11-26 用户裁定):上游这些分支只落 observation、output 无 systemMessage,
 *  宿主拿到的必然是 {}——等它纯属白等,而 memorix CLI 每次启动约 2-3s(13MB bundle + 128 模块,与内容无关)。
 *  只列 ZCode 实际挂载的捕获事件;未列入的事件一律同步,新增挂载默认走慢而正确的路径。 */
export const CAPTURE_ONLY_EVENTS = new Set(['PostToolUse', 'Stop']);

/** 捕获前置过滤(2026-11-26 收紧口径):上游 STORAGE_POLICY/isTrivialCommand 硬编码、无按工具关捕获的配置,
 *  噪声流水("Ran: grep…"/"Changed package.json")只能在我们这侧挡。命中即回 {} 不 spawn,省 ~2s CLI 启动。
 *  原则:宁多捕不漏捕——只丢「确定无记忆价值」的只读/检索/状态类;Edit/Write/git commit/测试/未知工具一律放行;
 *  JSON 解析失败/形状不认也放行(fail-open 同口径)。注入类事件恒放行(它们走注入不走捕获)。 */
const CAPTURE_FILTER_EVENTS = new Set([
  'PostToolUse', 'PreToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd', // ZCode/Qoder(Claude 事件名;上游 PreToolUse 也当捕获)
  'afterFileEdit', 'beforeShellExecution', 'stop', 'sessionEnd', // Cursor 字面名
]);
/** 确定无记忆价值的工具:只读/检索/待办/状态查询/记忆自身 MCP(上游对 Read/memorix 本就 store:never,前置挡掉省启动)。 */
const CAPTURE_DROP_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite', 'AskUserQuestion',
  'TaskOutput', 'TaskStop', 'ListModels', 'ListProjects', 'ListSessions', 'ReadSession', 'ReadTopicResource',
  'WaitSessions', 'InterruptSession', 'RenameSession', 'SetSessionArchived', 'SetSessionPinned',
  'OpenSession', 'OffPeakList', 'CronList', 'CronDelete', 'CronUpdate', 'CronCreate',
]);
/** 只读/琐碎命令(与上游 isTrivialCommand 同口径扩 grep/find/检索脚本):命中丢弃。 */
const TRIVIAL_CMD_RE = /^(ls|dir|cd|pwd|echo|cat|type|head|tail|wc|which|where|whoami|grep|rg|find|sort|uniq|diff|stat|file|tree)(\s|$)/i;
const TRIVIAL_GIT_RE = /^git\s+(status|log|diff|show|branch|remote|stash\s+list|rev-parse|ls-files|config\s+--get)(\s|$)/i;
const TRIVIAL_PKG_RE = /^(npm\s+(list|ls|view|info|outdated)|pip\s+(list|show|freeze)|node\s+--?version|python\s+--?version)(\s|$)/i;
const TRIVIAL_ENV_RE = /^(env|printenv|set|export|clear|cls|exit|quit)(\s|$)/i;
/** 本仓检索/体检脚本(node search.mjs/annotationCheck.mjs/status.mjs 等):高频只读,丢弃。 */
const CODEINDEX_READONLY_RE = /^node\s+(?:"[^"]*"|'[^']*'|\S*[/\\])?(search|annotationCheck|status|details|hooksStatus|memorixStatus)\.mjs["']?(\s|$)/i;
/** 判一条捕获事件是否值得转发给 memorix(纯函数,单测)。payload=宿主钩子 JSON 对象;
 *  返回 true=放行(转后台或同步),false=丢弃(回 {})。 */
export function shouldCaptureEvent(event, payload) {
  if (!CAPTURE_FILTER_EVENTS.has(event)) return true; // 注入类/未知事件恒放行
  if (!payload || typeof payload !== 'object') return true; // 形状不认 → fail-open 放行
  const tool = String(payload.tool_name ?? payload.toolName ?? '').trim();
  if (tool) {
    if (CAPTURE_DROP_TOOLS.has(tool)) return false;
    if (/^mcp__memorix__/i.test(tool)) return false; // 记忆自身 MCP 调用不回灌
    if (/^(Bash|Shell|Terminal|Command|Run)$/i.test(tool) || /^(mcp__node_repl__js|mcp__.*__(shell|exec|run))$/i.test(tool)) {
      const cmd = String(payload.tool_input?.command ?? payload.toolInput?.command ?? payload.command ?? '').replace(/^cd\s+\S+\s*&&\s*/i, '').trim();
      if (!cmd) return true; // 取不到命令 → 放行
      if (TRIVIAL_CMD_RE.test(cmd) || TRIVIAL_GIT_RE.test(cmd) || TRIVIAL_PKG_RE.test(cmd) || TRIVIAL_ENV_RE.test(cmd) || CODEINDEX_READONLY_RE.test(cmd)) return false;
      return true;
    }
    return true; // Edit/Write/其他工具:放行
  }
  // 无 tool_name(Cursor beforeShellExecution/stop 等):有命令按命令判,否则放行
  const cmd = String(payload.command ?? payload.tool_input?.command ?? '').replace(/^cd\s+\S+\s*&&\s*/i, '').trim();
  if (cmd && (TRIVIAL_CMD_RE.test(cmd) || TRIVIAL_GIT_RE.test(cmd) || TRIVIAL_PKG_RE.test(cmd) || TRIVIAL_ENV_RE.test(cmd) || CODEINDEX_READONLY_RE.test(cmd))) return false;
  return true;
}

/** 能否转后台(2026-11-26):detached 后台进程须活过本钩子。
 *  非 Windows:无 Job Object/taskkill 树杀,detached 天然安全。
 *  Windows:ZCode executionPort 在根进程退出后调 terminateProcessTree(taskkill /T /F),
 *  可能连带杀 detached 子进程(待动态验证);经 relay r2 时它解除级联+传标记,确定安全。
 *  无标记的 Windows 直启保守走同步(慢而正确),防记忆静默丢失。 */
const detachSafe = () => process.platform !== 'win32' || process.env.TOKENSAVER_RELAY_DETACH_SAFE === '1';

/** 捕获类:后台跑,不占宿主预算。返回是否已成功转后台(false=调用方回落同步路径)。
 *  载荷经临时文件传给 memorix-capture-bg.mjs(它用 Node 管道喂 stdin,退出时删文件)——
 *  不直接 detached+stdio:'ignore':memorix 只读 stdin(readHookStdin),那样会丢载荷;
 *  也不用 cmd.exe `< file` 重定向:Windows 下含空格路径 + 嵌套引号解析不可靠(实测报
 *  `'li' 不是内部或外部命令`)。 */
function spawnCaptureDetached(resolved, hookArgs, stdinJson) {
  // 后台脚本用 process.execPath 跑 JS 入口;PATH shim 形态(command=memorix.cmd、args 空)没有 JS 入口,不转后台。
  const cliEntry = resolved.command === process.execPath ? resolved.args[0] : null;
  if (!cliEntry) return false;
  const tmp = path.join(os.tmpdir(), `tokensaver-mx-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  try { fs.writeFileSync(tmp, stdinJson || '{}'); } catch { return false; }
  const child = spawn(process.execPath, [path.join(here, 'memorix-capture-bg.mjs'), cliEntry, ...resolved.args.slice(1), ...hookArgs, '--payload', tmp], {
    stdio: 'ignore', windowsHide: true, detached: true,
  });
  // spawn 的失败是异步事件:起不来时把载荷文件收掉,否则每次钩子泄漏一个临时文件。
  child.on('error', () => { try { fs.unlinkSync(tmp); } catch { /* 已删 */ } });
  child.unref?.();
  return true;
}

/** 主流程:读 stdin → spawn memorix hook → 提取注入 → 宿主格式输出。fail-open {}。
 *  捕获类事件:经新版中继时转后台(detachSafe),宿主立即返回 {},记忆异步照常落库;否则同步等它。 */
export function runMemorixHook({ agent = 'claude', event = '', host = 'zcode', stdinJson = '', cli = null, timeoutMs = memorixHookTimeoutMs(event), asyncCapture = true } = {}) {
  const resolved = cli || resolveMemorixHookCli({});
  if (!resolved || !event) return {};
  // 捕获前置过滤(2026-11-26):只读/检索/状态类噪声不转发,省 CLI 启动;解析失败放行(fail-open)
  let payload = null;
  try { payload = JSON.parse(stdinJson); } catch { /* 非法 JSON → 放行,交上游处理 */ }
  if (!shouldCaptureEvent(event, payload)) return {};
  const hookArgs = ['hook', '--agent', agent, '--event', event];
  let detached = false;
  if (asyncCapture && detachSafe() && CAPTURE_ONLY_EVENTS.has(event)) {
    try { detached = spawnCaptureDetached(resolved, hookArgs, stdinJson); } catch { /* 转不了后台就走同步 */ }
  }
  if (detached) return {};
  let out;
  try {
    const r = spawnSync(resolved.command, [...resolved.args, ...hookArgs], {
      input: stdinJson, encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      // 2026-11-26:跳过 memorix CLI 开头的自重启 wrapper。dist/cli/index.js 首 16 行检测
      // __MEMORIX_HEAP 未设就 spawnSync 起第二个自己(为 hook 设 512MB heap),每次钩子双进程
      // 启动 4.0s(实测 --version 3.8s、wrapper 全链路 3.97s)。预设该变量后单进程 2.0s,砍半,
      // 直接把三个 memorix 钩子(8-10s 预算)从超时线拉回。hook 只做一次检索/捕获,默认 heap 够用。
      env: { ...process.env, __MEMORIX_HEAP: '1' },
    });
    if (r.status !== 0) return {};
    out = r.stdout;
  } catch { return {}; }
  const ctx = extractMemorixInjection(out);
  if (!ctx) return {}; // 捕获类静默 / 无注入
  // 按 host 分形状(2026-11-25 审查修复):Cursor 原生钩子只认顶层 additionalContext(prompt-guard 同款);
  // ZCode/Qoder 认 hookSpecificOutput 包(Qoder qoderWrapSource 两种形状都认,ZCode 直挂无包装层)。
  if (host === 'cursor') return { additionalContext: ctx };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: ctx } };
}

// ---------- CLI 入口 ----------
const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  let stdinJson = '';
  try { stdinJson = fs.readFileSync(0, 'utf8'); } catch { /* 无 stdin */ }
  const ev = opt('--event', '');
  const result = runMemorixHook({ agent: opt('--agent', 'claude'), event: ev, host: opt('--host', 'zcode'), stdinJson, timeoutMs: memorixHookTimeoutMs(ev) });
  process.stdout.write(JSON.stringify(result));
  process.exit(0); // 恒 0(fail-open,不阻断宿主)
}
