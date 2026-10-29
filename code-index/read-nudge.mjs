/**
 * PostToolUse / PostToolUseFailure 钩子(^Read$|^Bash$):连续读导航 + 工具结果记账。
 * 不拦截任何调用,只在必要时输出 additionalContext(实测 ZCode 会注入到对话):
 *   Read 区间读同一文件 ≥2 段 → 提示合并为一次读完,或先 search 拿大纲
 *   Bash 输出超过 bashDumpBytes → 提示改用 Read offset/limit 或先检索
 *   PostToolUseFailure(Read/Bash 失败) → 指回 search 找正确文件
 * 记账:Read 实际进入上下文的字节数按 bytes/4 折 token,记入 session-savings.json
 *   当日桶的 readInputTokens(独立字段,不进 savedTokens,不影响现有口径)。
 * 状态:data/read-guard/<会话>.reads.json;所有失败 fail-open(输出空对象)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, MODULE_DIR, PACKED_INSTALL } from './config.mjs';
import { addReadInputTokens } from './modelStatus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const HUGE_BYTES = 8 * 1024 * 1024;
const READ_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
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

function statePath(sessionId) {
  const id = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(DATA_DIR, 'read-guard', `${id}.reads.json`);
}

/** 纯函数:依据历史与本次工具调用,决定是否注入。返回 {history, context?, accountTokens}。 */
export function evaluateNudge({ hookEventName, toolName, toolInput, toolResponse, history, now, config, statFile }) {
  const h = history && typeof history === 'object' ? history : {};
  if (!config.enabled) return { history: h };
  if (toolName !== 'Read' && toolName !== 'Bash') return { history: h };
  const ti = toolInput || {};
  const resp = toolResponse || {};

  if (hookEventName === 'PostToolUseFailure') {
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
      || (typeof resp.content === 'string' ? Buffer.byteLength(resp.content) : 0);
    const key = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
    const st = h.reads && typeof h.reads[key] === 'object' ? { ...h.reads[key] } : { ranges: 0, bytes: 0, lastAt: 0, nudgedAt: 0 };
    let context;
    if (ranged) {
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
        context = `[code-index] 已对 ${key} 连续区间读 ${st.ranges} 段(约 ${Math.round(st.bytes / 1024)} KB)${total}。若在通读,合并为一次 Read(offset=起点,limit=剩余行数);若在找实现,先 \`${searchCmd()} <符号> --k 5\` 拿大纲再精准跳。`;
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

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(await new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', () => resolve(data));
    }) || '{}');
  } catch { return respond({}); }

  try {
    const config = nudgeConfig();
    const sessionId = payload.sessionId || payload.session_id || 'unknown';
    const stateFile = statePath(sessionId);
    const history = readJson(stateFile) || {};
    const now = Date.now();
    const r = evaluateNudge({
      hookEventName: payload.hookEventName || payload.hook_event_name,
      toolName: payload.toolName || payload.tool_name,
      toolInput: payload.toolInput || payload.tool_input,
      toolResponse: payload.toolResponse || payload.tool_response,
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
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(r.history));
    } catch { /* 状态记不上不影响注入 */ }
    if (r.accountTokens > 0) {
      try { addReadInputTokens(r.accountTokens); } catch { /* 记账失败不影响注入 */ }
    }
    respond(r.context ? { additionalContext: r.context } : {});
  } catch { respond({}); }
  process.exit(0);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) main();
