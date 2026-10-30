/**
 * PostToolUse / PostToolUseFailure 钩子(^Read$|^Bash$):连续读导航 + 工具结果记账。
 * ZCode 用户级直呼本脚本;Qoder 用户级经 ~/.qoder-cn/hooks/read-nudge.mjs 转发(additionalContext 包成 hookSpecificOutput);
 * Cursor 用户级经 ~/.cursor/hooks/read-nudge.mjs 同进程转发器调 runReadNudge。
 * 不拦截任何调用,只在必要时输出 additionalContext(实测 ZCode/Cursor 都注入到对话):
 *   Read 区间读同一文件 ≥2 段 → 提示合并为一次读完,或先 search 拿大纲
 *   Bash 输出超过 bashDumpBytes → 提示改用 Read offset/limit 或先检索
 *   PostToolUseFailure(Read/Bash 失败) → 指回 search 找正确文件
 * 记账:Read 实际进入上下文的字节数按 bytes/4 折 token,记入 session-savings.json
 *   当日桶的 readInputTokens(独立字段,不进 savedTokens,不影响现有口径)。
 *   read-guard 改写注入的区间读(history.hookRewrites 标记)只记账、不进连续读计数。
 * 状态:data/read-guard/<会话>.reads.json;所有失败 fail-open(输出空对象)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, MODULE_DIR, PACKED_INSTALL } from './config.mjs';
import { addReadInputTokens, appendReadEvent, findSearchEventRef, readReadEvents } from './modelStatus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const HUGE_BYTES = 8 * 1024 * 1024;
const READ_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const HOOK_REWRITE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_DUMP_BYTES = 24 * 1024;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function nudgeConfig() {
  const cfg = readJson(path.join(DATA_DIR, 'code-index.config.json')) || {};
  const n = cfg.nudge && typeof cfg.nudge === 'object' ? cfg.nudge : {};
  return {
    enabled: n.enabled !== false,
    bashDumpBytes: Number.isFinite(Number(n.bashDumpBytes)) && Number(n.bashDumpBytes) > 0 ? Number(n.bashDumpBytes) : DEFAULT_DUMP_BYTES,
    windowMs: Number.isFinite(Number(n.windowMs)) && Number(n.windowMs) > 0 ? Number(n.windowMs) : READ_WINDOW_MS,
  };
}

function countLines(file, size) {
  if (size > HUGE_BYTES) return Math.ceil(size / 40);
  try { return fs.readFileSync(file, 'utf8').length ? fs.readFileSync(file, 'utf8').split('\n').length : 0; } catch { return 0; }
}

function searchCmd() {
  return PACKED_INSTALL ? 'npx tokensaver search' : `node "${MODULE_DIR.split(path.sep).join('/')}/search.mjs"`;
}

/** 纯函数:依据历史与本次工具调用,决定是否注入。返回 {history, context?, accountTokens}。 */
export function evaluateNudge({ hookEventName, toolName, toolInput, toolResponse, history, now, config, statFile }) {
  const h = history && typeof history === 'object' ? history : {};
  if (!config.enabled) return { history: h };
  if (toolName !== 'Read' && toolName !== 'Bash') return { history: h };
  const ti = toolInput || {};
  const resp = toolResponse || {};

  if (hookEventName === 'PostToolUseFailure' || hookEventName === 'postToolUseFailure') {
    if (Number.isFinite(h.lastFailureNudgeAt) && now - h.lastFailureNudgeAt < FAILURE_WINDOW_MS) return { history: h };
    h.lastFailureNudgeAt = now;
    return {
      history: h,
      context: `[code-index] 该次 Read/Bash 失败。用 \`${searchCmd()} <关键词> --k 5\` 定位正确文件/命令后再试。`,
    };
  }

  if (toolName === 'Read') {
    const rawPath = ti.file_path || ti.path || ti.target_file;
    if (!rawPath || typeof rawPath !== 'string') return { history: h };
    const ranged = ti.offset != null || ti.limit != null;
    const bytes = Number(resp.stdoutBytes) || Number(resp.contentBytes)
      || (typeof resp.stdout === 'string' ? Buffer.byteLength(resp.stdout) : 0)
      || (typeof resp.content === 'string' ? Buffer.byteLength(resp.content) : 0)
      || (typeof resp.file?.content === 'string' ? Buffer.byteLength(resp.file.content) : 0); // Qoder:tool_response.file.content
    const key = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
    const st = h.reads && typeof h.reads[key] === 'object' ? { ...h.reads[key] } : { ranges: 0, bytes: 0, lastAt: 0, nudgedAt: 0 };
    let context;
    if (ranged) {
      const markedAt = h.hookRewrites && Number.isFinite(h.hookRewrites[key]) ? h.hookRewrites[key] : null;
      if (markedAt != null) {
        delete h.hookRewrites[key]; // 一次性消费(过期的也顺手清掉)
        if (now - markedAt < HOOK_REWRITE_WINDOW_MS) {
          // read-guard 改写注入的区间读:不进"连续区间读"启发式(那会把钩子行为算成 agent 意图),
          // 字节照常记账(内容实际进入了上下文)。
          st.lastAt = now;
          h.reads = { ...(h.reads || {}), [key]: st };
          return { history: h, accountTokens: Math.ceil(bytes / 4) };
        }
      }
      st.ranges += 1;
      st.bytes += bytes;
      st.lastAt = now;
      if (st.ranges >= 2 && now - st.nudgedAt > config.windowMs) {
        st.nudgedAt = now;
        let total = '';
        if (typeof statFile === 'function') {
          const info = statFile(key);
          if (info && info.lines) total = `,全文 ${info.lines} 行`;
        }
        // Cursor 载荷不带字节量,bytes=0 时省略 KB 段;不足 1KB 也不显示
        const kb = st.bytes >= 1024 ? `(约 ${Math.round(st.bytes / 1024)} KB)` : '';
        context = `[code-index] 已对 ${key} 连续区间读 ${st.ranges} 段${kb}${total}。若在通读,合并为一次 Read(offset=起点,limit=剩余行数);若在找实现,先 \`${searchCmd()} <符号> --k 5\` 拿大纲再精准跳。`;
      }
    } else {
      // 全量读:序列结束,清零(提示抑制也一并重置,新序列是新交互)
      st.ranges = 0;
      st.bytes = 0;
      st.lastAt = now;
      st.nudgedAt = 0;
    }
    h.reads = { ...(h.reads || {}), [key]: st };
    return { history: h, context, accountTokens: Math.ceil(bytes / 4) };
  }

  // Bash:大输出提示
  const bytes = Number(resp.stdoutBytes) || (typeof resp.stdout === 'string' ? Buffer.byteLength(resp.stdout) : 0);
  if (bytes > config.bashDumpBytes && now - (h.lastBashNudgeAt || 0) > config.windowMs) {
    h.lastBashNudgeAt = now;
    return { history: h, context: `[code-index] 上条命令输出约 ${Math.round(bytes / 1024)} KB。若在翻找文件内容,改用 Read 的 offset/limit,或先 \`${searchCmd()} <关键词> --k 5\` 定位再精准读取。` };
  }
  return { history: h };
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj ?? {}));
}

/**
 * 同进程入口(Cursor 转发器用):解析载荷 → 判定 → 落状态/记账 → 输出 additionalContext。
 * 兼容两种载荷:ZCode(toolResponse.stdoutBytes/stdout)与 Cursor(tool_output 为字符串或 {output})。
 * opts: stateDir 覆盖状态目录(测试密闭);account=false 跳过记账(测试)。
 */
export async function runReadNudge({ stdinText, stateDir = path.join(DATA_DIR, 'read-guard'), account = true } = {}) {
  let payload = {};
  try {
    payload = JSON.parse(String(stdinText != null ? stdinText : await new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', () => resolve(data));
    }) || '{}'));
  } catch { return respond({}); }

  try {
    const config = nudgeConfig();
    // 会话标识各宿主不同:ZCode=sessionId/session_id;Cursor=conversation_id;取不到才用 unknown
    const sessionId = payload.sessionId || payload.session_id || payload.conversation_id || payload.conversationId || 'unknown';
    const stateFile = path.join(stateDir, `${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}.reads.json`);
    const history = readJson(stateFile) || {};
    const now = Date.now();
    // Cursor:tool_output(字符串或 {output})归一为 stdout 口径
    let toolResponse = payload.toolResponse || payload.tool_response;
    if (!toolResponse && payload.tool_output != null) {
      const to = payload.tool_output;
      toolResponse = typeof to === 'string' ? { stdout: to }
        : (typeof to.output === 'string' ? { stdout: to.output, stdoutBytes: Number(to.outputBytes) || undefined } : to);
    }
    const r = evaluateNudge({
      hookEventName: payload.hookEventName || payload.hook_event_name,
      toolName: payload.toolName || payload.tool_name,
      toolInput: payload.toolInput || payload.tool_input,
      toolResponse,
      history,
      now,
      config,
      statFile: (f) => {
        try {
          const st = fs.statSync(f);
          return st.isFile() ? { file: f, size: st.size, lines: countLines(f, st.size) } : null;
        } catch { return null; }
      },
    });
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(r.history));
    } catch { /* 状态记不上不影响注入 */ }
    if (account && r.accountTokens > 0) {
      try { addReadInputTokens(r.accountTokens); } catch { /* 记账失败不影响注入 */ }
    }
    // 检索事件归属:Bash 里跑的 search.mjs 先落了无主 Search 事件;主会话的 PostToolUse 按命令原文认领,
    // 之后 modelStatus 才能对该事件做会话累计修正。子代理无钩子,检索事件保持无主(只记入口一次)。
    try {
      const toolName = payload.toolName || payload.tool_name;
      const cmd = (payload.toolInput || payload.tool_input)?.command;
      if (toolName === 'Bash' && typeof cmd === 'string' && cmd.includes('search.mjs')) {
        const ref = findSearchEventRef(readReadEvents(), cmd, Date.now());
        if (ref != null) appendReadEvent({ at: Date.now(), session: sessionId, kind: 'SearchClaim', refAt: ref });
      }
    } catch { /* 认领失败不影响注入 */ }
    const result = r.context ? { additionalContext: r.context } : {};
    respond(result);
    return result;
  } catch { respond({}); return {}; }
}

async function main() {
  await runReadNudge({});
  process.exit(0);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) main();
