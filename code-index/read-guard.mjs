#!/usr/bin/env node
/**
 * Read/Bash 拦截:Cursor preToolUse(Read)+beforeShellExecution(cat);ZCode/Qoder PreToolUse ^Read$|^Bash$(ZCode 另接 ^Grep$)。
 * 全量 Read 超过 readMaxLines×1.25 → ZCode 优先改写为语义区间读(rangePick 选段,updatedInput),
 *   选不出区间或非 ZCode 时退回 deny(指路 search + 区间读)。
 * Grep(ZCode):不带 head_limit 的调用补 head_limit 封顶(PreToolUse 拿不到结果量,此路不记账)。
 * 终端/Bash 里各链式组末段的 cat 整读同规则拦;带 | 限量管道、> 重定向、cat 无文件参数则放行。
 * Cursor 终端走 beforeShellExecution(工具名常是 Shell,不进 preToolUse Bash);ZCode/Qoder 仍认 Bash。
 * 带 offset/limit 的区间读放行。刚拦过同一目标 5 分钟内再发则放行(deny 专属;改写幂等,重发即再改写)。
 * 拦截/改写同时追加事件到 data/read-guard/events.jsonl(deny:{bytes};Rewrite:{bytes,rangeBytes,s,e}),
 *   供 modelStatus 按 rollout 回放做"会话累计"口径修正;入口账 deny 记 (bytes/4,0)、Rewrite 记 (bytes/4,区间/4)。
 * Cursor 输出 {permission};ZCode/Qoder 输出 hookSpecificOutput.permissionDecision;改写走
 *   hookSpecificOutput.updatedInput(ZCode 实测采纳;未文档化能力,失效时关 readGuard.rewrite 即回 deny)。
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
  if (ev === 'preToolUse' || ev === 'beforeShellExecution') return 'cursor';
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

/** 记录拒绝时来自哪个宿主。环境变量优先,事件名只能区分 Cursor 与 Claude 系。 */
export function detectAgentType(input, env = process.env) {
  if (env.ZCODE_PROJECT_DIR || env.ZCODE_SESSION_ID || env.ZCODE_PLUGIN_ROOT) return 'zcode';
  if (env.QODER_PROJECT_DIR || env.QODER_CONFIG_DIR || env.QODER_SESSION_ID || env.QODER_CWD) return 'qoder';
  if (env.CURSOR_AGENT || env.CURSOR_CONVERSATION_ID) return 'cursor';
  const ev = String(input?.hook_event_name || input?.hookEventName || '');
  return (ev === 'preToolUse' || ev === 'beforeShellExecution') ? 'cursor' : 'unknown';
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

/** 拦截留痕经 modelStatus.appendReadEvent 落 events.jsonl;动态导入避免顶层循环依赖。 */
async function trackEvent(entry) {
  try {
    const { appendReadEvent } = await import('./modelStatus.mjs');
    appendReadEvent(entry);
  } catch { /* 留痕失败不影响拦截 */ }
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

/** Bash 命令按 &&/||/; 分组,取每组管道末段:只有它直接写进工具结果,前面的输出已被后续命令消化。 */
export function catDumpPieces(command) {
  return String(command ?? '')
    .split(/&&|\|\||;/)
    .map((g) => g.split('|').pop().trim())
    .filter((p) => /^cat(\s|$)/.test(p) && !/[<>]/.test(p));
}

/** shortcut: cat 整读与 Read 同阈值;命令是字符串启发式,node -e 之类间接整读拦不住,宁可放行。 */
export function evaluateBashGuard({ command, now, denialAt, readMaxLines, statFile } = {}) {
  const files = [];
  let totalLines = 0;
  for (const piece of catDumpPieces(command)) {
    const tokens = (piece.match(/"[^"]*"|'[^']*'|\S+/g) || []).slice(1);
    for (const t of tokens) {
      const f = t.replace(/^["']|["']$/g, '');
      if (!f || f.startsWith('-')) continue;
      const st = statFile(f);
      if (!st) continue;
      files.push(st.file);
      totalLines += st.lines;
    }
  }
  if (!files.length) return { permission: 'allow' };
  if (denialAt != null && Number.isFinite(denialAt) && now - denialAt < OVERRIDE_WINDOW_MS) {
    return { permission: 'allow', override: true };
  }
  const cap = Number(readMaxLines);
  if (!Number.isFinite(cap) || cap <= 0) return { permission: 'allow' };
  if (totalLines > cap * 1.25) return { permission: 'deny', files };
  return { permission: 'allow' };
}

export function bashOversizeGuidance({ files, lines, size, readMaxLines, searchCmd }) {
  const kb = Math.max(1, Math.round((size || 0) / 1024));
  const cap = readMaxLines;
  const slack = Math.floor(cap * 1.25);
  const target = files.length === 1 ? files[0] : `${files[0]}(多文件请逐个)`;
  return (
    `code-index: Bash 整读 ${files.join(' ')} 共 ${lines} 行(~${kb} KB),超过全量读上限 ${cap} 行(宽限至 ${slack} 行)。不要用 cat 整读大文件。替代方案:` +
    `① 先检索 \`${searchCmd} <关键词> --k 5\` 定位内容(命中的 file:起-止即大纲);` +
    `② 看片段可直接照抄 \`sed -n '1,${cap}p' ${target}\`(首 ${cap} 行,后续段改起止行号),或改用 Read 的 offset/limit;` +
    `③ 按内容定位用 \`grep -n <关键词> ${target}\` 拿行号后再区间读。` +
    `确实需要全量输出时,5 分钟内重发同一命令即放行。`
  );
}

/** 改写预置标记:写进 read-nudge 的 <会话>.reads.json(hookRewrites[文件]=时刻),
 *  PostToolUse 消费标记后跳过本次钩子注入读的"连续区间读"计数(字节记账保留)。失败静默。 */
export function markHookRewrite(sessionId, absFile, at = Date.now(), stateFile) {
  try {
    const p = stateFile || path.join(DATA_DIR, 'read-guard', `${String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}.reads.json`);
    let j = {};
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* 新文件 */ }
    if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
    j.hookRewrites = { ...(j.hookRewrites || {}), [absFile]: at };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(j));
    return true;
  } catch { return false; }
}

export function resolveReadMaxLines() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const n = Number(j.readMaxLines);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* 缺文件或坏 JSON:用默认,不走 loadConfig(它会 process.exit) */ }
  return DEFAULT_CONFIG.readMaxLines;
}

/** 改写路径配置:readGuard.rewrite 总开关;grepHeadLimit 给 Grep 补封顶(0=关)。默认全关。 */
export function rewriteConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const rg = j.readGuard && typeof j.readGuard === 'object' ? j.readGuard : {};
    const gh = Number(rg.grepHeadLimit);
    return {
      rewrite: rg.rewrite === true,
      grepHeadLimit: Number.isFinite(gh) && gh > 0 ? gh : 0,
    };
  } catch { return { rewrite: false, grepHeadLimit: 0 }; }
}

/** 改写输出体(claude 方言)。updatedInput 会替换执行入参;additionalContext 随工具结果注入。 */
export function rewriteBody(updatedInput, context) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
      additionalContext: context,
    },
  };
}

export function rewriteGuidance({ file, lines, size, range, searchCmd }) {
  const kb = Math.max(1, Math.round((size || 0) / 1024));
  return (
    `[code-index] ${file} 共 ${lines} 行(~${kb} KB),超过全量 Read 上限。` +
    `已按你的提问改写为语义最相关区间 ${range.s}-${range.e} 行(${range.src === 'rerank' ? '精排' : '余弦'}选段)。` +
    `这不是全文:要读其他区间用 Read 的 offset/limit,确需全文用 offset=1 limit=${lines},` +
    `或先检索 \`${searchCmd} <符号> --k 5\` 拿大纲再精准跳。`
  );
}

/** [s,e] 行的字节数;超 8MB 的大文件按行数比例估,不整读。 */
export function bytesOfLines(file, totalLines, s, e) {
  try {
    const st = fs.statSync(file);
    if (st.size > 8 * 1024 * 1024 || totalLines <= 0) return Math.ceil(st.size * Math.min(1, (e - s + 1) / totalLines));
    const content = fs.readFileSync(file, 'utf8');
    const all = content.split('\n');
    return Buffer.byteLength(all.slice(s - 1, e).join('\n'), 'utf8');
  } catch { return 0; }
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

/** Grep(ZCode):未带 head_limit 的调用补封顶,防大仓库匹配倾倒。PreToolUse 无结果量,不记账。 */
function grepGuard(input, dialect) {
  const rc = rewriteConfig();
  const ti = input.tool_input || {};
  if (rc.rewrite && rc.grepHeadLimit > 0 && ti.head_limit == null && detectAgentType(input) === 'zcode') {
    const body = rewriteBody(
      { ...ti, head_limit: rc.grepHeadLimit },
      `[code-index] 已给本次 Grep 补 head_limit=${rc.grepHeadLimit} 封顶输出(原调用未带)。` +
      `要更多命中请分目录或加 glob 缩小,确需更多时显式带 head_limit 重发。`,
    );
    respond(body);
    return body;
  }
  return emit(dialect, 'allow');
}

async function bashGuard(input, dialect) {
  // Cursor beforeShellExecution 把命令放在顶层 command;Bash/Shell preToolUse 在 tool_input.command。
  const cmd = input.tool_input?.command ?? input.command;
  if (typeof cmd !== 'string' || !cmd.trim()) return emit(dialect, 'allow');
  const convId = input.conversation_id || input.session_id || 'unknown';
  const now = Date.now();
  const cwd = input.cwd || process.cwd();
  const denials = loadDenials(convId);
  const key = catDumpPieces(cmd).join(' && ');
  const stats = [];
  const statFile = (f) => {
    const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    let lines;
    try { lines = countLines(abs, st.size); } catch { return null; }
    const s = { file: abs, size: st.size, lines };
    stats.push(s);
    return s;
  };
  const decision = evaluateBashGuard({
    command: cmd,
    now,
    denialAt: key ? denials[key]?.at : undefined,
    readMaxLines: resolveReadMaxLines(),
    statFile,
  });
  if (decision.override) {
    const d = key ? denials[key] : null;
    if (d && d.bytes) await trackEvent({ at: d.at, session: convId, kind: 'Bash', file: d.file || key, bytes: d.bytes, void: true });
    delete denials[key];
    try { saveDenials(convId, denials); } catch { /* 仍放行 */ }
    return emit(dialect, 'allow');
  }
  if (decision.permission !== 'deny' || !key) return emit(dialect, 'allow');
  const size = stats.reduce((n, s) => n + s.size, 0);
  const msg = bashOversizeGuidance({
    files: decision.files,
    lines: stats.reduce((n, s) => n + s.lines, 0),
    size,
    readMaxLines: resolveReadMaxLines(),
    searchCmd: searchCmd(),
  });
  const body = formatDecision(dialect, 'deny', msg);
  try {
    denials[key] = { at: now, agentType: detectAgentType(input), response: body, bytes: size, kind: 'Bash', file: decision.files.join(' ') };
    saveDenials(convId, denials);
  } catch {
    return emit(dialect, 'allow');
  }
  await recordBlockedBytes(size);
  await trackEvent({ at: now, session: convId, kind: 'Bash', file: decision.files.join(' '), bytes: size });
  respond(body);
  return body;
}

export async function runReadGuard({ stdinText } = {}) {
  const raw = stdinText != null ? stdinText : await readStdin();
  let input;
  try {
    // Cursor 在 stdin JSON 前写 UTF-8 BOM,JSON.parse 会抛错,否则整段被当成放行。
    input = JSON.parse(String(raw || '').replace(/^\uFEFF/, '') || '{}');
  } catch {
    return emit(detectDialect({}), 'allow');
  }
  const dialect = detectDialect(input || {});
  const ev = String(input?.hook_event_name || input?.hookEventName || '');
  const tool = input?.tool_name;
  // ZCode/Qoder:Bash;Grep(ZCode 改写封顶);Cursor:beforeShellExecution,偶发 Shell preToolUse。
  if (tool === 'Bash' || tool === 'Shell' || ev === 'beforeShellExecution') {
    return bashGuard(input, dialect);
  }
  if (tool === 'Grep') return grepGuard(input, dialect);
  if (!input || (tool && tool !== 'Read')) return emit(dialect, 'allow');
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
    const d = denials[file];
    if (d && d.bytes) await trackEvent({ at: d.at, session: convId, kind: 'Read', file, bytes: d.bytes, void: true });
    delete denials[file];
    try { saveDenials(convId, denials); } catch { /* 仍放行 */ }
    return emit(dialect, 'allow');
  }

  if (decision.permission === 'deny') {
    // ZCode 改写路径:选得出语义区间就改写入参,选不出(无意图/索引缺失/不相关)落回 deny
    const rc = rewriteConfig();
    if (rc.rewrite && detectAgentType(input) === 'zcode') {
      let range = null;
      try {
        const { pickRangeForFile } = await import('./rangePick.mjs');
        range = await pickRangeForFile(file, convId, { maxLines: Math.floor(resolveReadMaxLines() * 1.25) });
      } catch { /* 选段失败落回 deny */ }
      if (range) {
        const s = Math.max(1, range.s);
        const limit = Math.min(range.e, lines) - s + 1;
        if (limit > 0) {
          const rangeBytes = bytesOfLines(file, lines, s, Math.min(range.e, lines));
          const body = rewriteBody(
            { ...ti, offset: s, limit },
            rewriteGuidance({ file, lines, size: st.size, range, searchCmd: searchCmd() }),
          );
          try {
            const { addInputSavings } = await import('./modelStatus.mjs');
            addInputSavings(tokensFromBlockedBytes(st.size), Math.ceil(rangeBytes / 4));
          } catch { /* 记账失败仍改写 */ }
          await trackEvent({ at: now, session: convId, kind: 'Rewrite', file, bytes: st.size, rangeBytes, s, e: Math.min(range.e, lines) });
          markHookRewrite(convId, file, now);
          respond(body);
          return body;
        }
      }
    }
    const msg = oversizeGuidance({
      file,
      lines,
      size: st.size,
      readMaxLines: resolveReadMaxLines(),
      searchCmd: searchCmd(),
    });
    const body = formatDecision(dialect, 'deny', msg);
    try {
      denials[file] = { at: now, agentType: detectAgentType(input), response: body, bytes: st.size, kind: 'Read' };
      saveDenials(convId, denials);
    } catch {
      return emit(dialect, 'allow');
    }
    await recordBlockedBytes(st.size);
    await trackEvent({ at: now, session: convId, kind: 'Read', file, bytes: st.size });
    respond(body);
    return body;
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
