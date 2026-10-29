#!/usr/bin/env node
/**
 * Read 拦截:Cursor preToolUse;ZCode/Qoder PreToolUse。matcher ^Read$。
 * 全量读超过 readMaxLines×1.25 → deny,指路 search + 区间读。
 * 带 offset/limit 的区间读放行。刚拦过同一文件 5 分钟内再读则放行。
 * Cursor 输出 {permission};ZCode/Qoder 输出 hookSpecificOutput.permissionDecision。
 * 自身出错 fail-open:Cursor 写 {permission:allow}(缺字段会被拦);Claude 系写 {}(allow 不短路权限链)。
 * 不拦重复读,不做差分。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, DATA_DIR, DEFAULT_CONFIG, MODULE_DIR, PACKED_INSTALL } from './config.mjs';

export const ALLOW = { permission: 'allow' };
export const OVERRIDE_WINDOW_MS = 5 * 60 * 1000;
const HUGE_BYTES = 8 * 1024 * 1024;

/** Cursor 用 camelCase preToolUse;ZCode/Qoder 用 PreToolUse。解析失败时看环境变量。 */
export function detectDialect(input, env = process.env) {
  const ev = String(input?.hook_event_name || input?.hookEventName || '');
  if (ev === 'PreToolUse') return 'claude';
  if (ev === 'preToolUse') return 'cursor';
  if (env.ZCODE_PROJECT_DIR || env.ZCODE_SESSION_ID || env.ZCODE_PLUGIN_ROOT) return 'claude';
  if (env.QODER_PROJECT_DIR || env.QODER_CONFIG_DIR || env.QODER_SESSION_ID || env.QODER_CWD) return 'claude';
  if (env.CURSOR_AGENT || env.CURSOR_CONVERSATION_ID) return 'cursor';
  return 'cursor';
}

/** Claude 系 allow 不带 permissionDecision,避免短路项目里其他权限规则。 */
export function formatDecision(dialect, permission, reason) {
  if (dialect === 'claude') {
    if (permission !== 'deny') return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason || '',
      },
    };
  }
  if (permission === 'deny') {
    return { permission: 'deny', agent_message: reason, user_message: reason };
  }
  return ALLOW;
}

export function evaluateReadGuard({
  toolName,
  toolInput,
  now,
  denialAt,
  readMaxLines,
  lines,
} = {}) {
  if (toolName != null && toolName !== 'Read') return { permission: 'allow' };
  const ti = toolInput || {};
  if (ti.limit != null || ti.offset != null) return { permission: 'allow' };
  if (denialAt != null && Number.isFinite(denialAt) && now - denialAt < OVERRIDE_WINDOW_MS) {
    return { permission: 'allow', override: true };
  }
  const cap = Number(readMaxLines);
  if (!Number.isFinite(cap) || cap <= 0) return { permission: 'allow' };
  if (lines != null && lines > cap * 1.25) return { permission: 'deny' };
  return { permission: 'allow' };
}

/** shortcut: 钩子只有文件字节数,按 4 字节约 1 token,不再把整文件送进 tokenizer。 */
export function tokensFromBlockedBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 4);
}

async function recordBlockedBytes(bytes) {
  const tokens = tokensFromBlockedBytes(bytes);
  if (tokens <= 0) return;
  try {
    const { addInputSavings } = await import('./modelStatus.mjs');
    addInputSavings(tokens, 0);
  } catch { /* 记账失败仍拒绝 */ }
}

export function oversizeGuidance({ file, lines, size, readMaxLines, searchCmd }) {
  const kb = Math.max(1, Math.round((size || 0) / 1024));
  const cap = readMaxLines;
  const slack = Math.floor(cap * 1.25);
  return (
    `code-index: ${file} 共 ${lines} 行(~${kb} KB),超过全量 Read 上限 ${cap} 行(宽限至 ${slack} 行)。` +
    `不要整文件 Read。先检索 \`${searchCmd} <符号或关键词> --k 5\`(命中的 file:起-止即大纲),` +
    `再按该区间用 Read 的 offset/limit 精读。` +
    `若确实需要全文,5 分钟内对同一文件再发一次同样的全量 Read 即放行。`
  );
}

export function resolveReadMaxLines() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const n = Number(j.readMaxLines);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* 缺文件或坏 JSON:用默认,不走 loadConfig(它会 process.exit) */ }
  return DEFAULT_CONFIG.readMaxLines;
}

function searchCmd() {
  return PACKED_INSTALL
    ? 'npx tokensaver search'
    : `node "${MODULE_DIR.split(path.sep).join('/')}/search.mjs"`;
}

function statePath(convId) {
  const id = String(convId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(DATA_DIR, 'read-guard', `${id}.json`);
}

function loadDenials(convId) {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(convId), 'utf8'));
    return j && typeof j.denials === 'object' && !Array.isArray(j.denials) ? j.denials : {};
  } catch {
    return {};
  }
}

function saveDenials(convId, denials) {
  fs.mkdirSync(path.dirname(statePath(convId)), { recursive: true });
  fs.writeFileSync(statePath(convId), JSON.stringify({ denials }));
}

function countLines(file, size) {
  if (size > HUGE_BYTES) return Math.ceil(size / 40);
  const content = fs.readFileSync(file, 'utf8');
  return content.length ? content.split('\n').length : 0;
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj ?? ALLOW));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function emit(dialect, permission, reason) {
  const body = formatDecision(dialect, permission, reason);
  respond(body);
  return body;
}

export async function runReadGuard({ stdinText } = {}) {
  const raw = stdinText != null ? stdinText : await readStdin();
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    return emit(detectDialect({}), 'allow');
  }
  const dialect = detectDialect(input || {});
  if (!input || (input.tool_name && input.tool_name !== 'Read')) return emit(dialect, 'allow');
  const ti = input.tool_input || {};
  const rawPath = ti.file_path || ti.path || ti.target_file;
  if (!rawPath || typeof rawPath !== 'string') return emit(dialect, 'allow');
  const file = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(input.cwd || process.cwd(), rawPath);

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return emit(dialect, 'allow');
  }
  if (!st.isFile()) return emit(dialect, 'allow');

  const convId = input.conversation_id || input.session_id || 'unknown';
  const now = Date.now();
  const denials = loadDenials(convId);
  let lines;
  try {
    lines = countLines(file, st.size);
  } catch {
    return emit(dialect, 'allow');
  }

  const decision = evaluateReadGuard({
    toolName: input.tool_name || 'Read',
    toolInput: ti,
    now,
    denialAt: denials[file]?.at,
    readMaxLines: resolveReadMaxLines(),
    lines,
  });

  if (decision.override) {
    delete denials[file];
    try { saveDenials(convId, denials); } catch { /* 仍放行 */ }
    return emit(dialect, 'allow');
  }

  if (decision.permission === 'deny') {
    try {
      denials[file] = { at: now };
      saveDenials(convId, denials);
    } catch {
      return emit(dialect, 'allow');
    }
    const msg = oversizeGuidance({
      file,
      lines,
      size: st.size,
      readMaxLines: resolveReadMaxLines(),
      searchCmd: searchCmd(),
    });
    await recordBlockedBytes(st.size);
    return emit(dialect, 'deny', msg);
  }

  return emit(dialect, 'allow');
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  try {
    if (process.stdin.isTTY) emit(detectDialect({}), 'allow');
    else await runReadGuard();
  } catch {
    emit(detectDialect({}), 'allow');
  }
  process.exit(0);
}
