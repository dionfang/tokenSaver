#!/usr/bin/env node
/**
 * Read/Bash 拦截:Cursor preToolUse 两条字面 matcher(Read、Grep)+beforeShellExecution(cat);
 *   ZCode/Qoder PreToolUse ^Read$|^Bash$|^Grep$。Cursor 的 matcher 不写正则,正则会整组跳过。
 * 全量 Read 超过 readMaxLines×1.25 → 三端都优先改写为语义区间读(rangePick 选段)。
 *   ZCode/Qoder 走 hookSpecificOutput.updatedInput;Cursor 走 preToolUse 的 updated_input。
 *   选不出区间则 deny(指路 search + 区间读)。改写是默认路径,不由配置开关。
 * Grep:不带 head_limit 的调用补 head_limit 封顶(拿不到结果量,此路不记账)。三端都改。
 * 终端/Bash 里各链式组末段的 cat 整读同规则拦;带 | 限量管道、> 重定向、cat 无文件参数则放行。
 * Cursor 终端走 beforeShellExecution(工具名常是 Shell,不进 preToolUse Bash);ZCode/Qoder 仍认 Bash。
 * 带 offset/limit 的区间读放行。刚拦过或改写过同一目标,5 分钟内再发全量则放行。
 *   Read 的 deny/改写在全量真进上下文时追加 void 事件退款;Bash 输出被宿主截断存盘,放行只删记录不退款。
 * 拦截/改写同时追加事件到 data/read-guard/events.jsonl(deny:{bytes};Rewrite:{bytes,rangeBytes,s,e}),
 *   供 modelStatus 按 rollout 回放做"会话累计"口径修正;入口账 deny 记 (bytes/4,0)、Rewrite 记 (bytes/4,区间/4)。
 * Cursor 拒绝输出 {permission:deny};放行/改写输出 {permission:allow,updated_input,agent_message}。
 *   ZCode/Qoder 拒绝走 hookSpecificOutput.permissionDecision;改写走 updatedInput。
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

/** 判定宿主。环境变量优先,事件名只能区分 Cursor 与 Claude 系。 */
export function detectAgentType(input, env = process.env) {
  if (env.ZCODE_PROJECT_DIR || env.ZCODE_SESSION_ID || env.ZCODE_PLUGIN_ROOT) return 'zcode';
  if (env.QODER_PROJECT_DIR || env.QODER_CONFIG_DIR || env.QODER_SESSION_ID || env.QODER_CWD) return 'qoder';
  if (env.CURSOR_AGENT || env.CURSOR_CONVERSATION_ID) return 'cursor';
  const ev = String(input?.hook_event_name || input?.hookEventName || '');
  return (ev === 'preToolUse' || ev === 'beforeShellExecution') ? 'cursor' : 'unknown';
}

/** 改写入参:ZCode/Qoder 的 updatedInput,Cursor preToolUse 的 updated_input。无宿主标记则不改。 */
export function supportsRewrite(input, env = process.env) {
  const t = detectAgentType(input, env);
  return t === 'zcode' || t === 'qoder' || t === 'cursor';
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

/** 预取 claim 认领(动态导入避循环;失败=null 走原口径,不影响拦截)。 */
async function takePrefetchClaimSafe(session, file, now) {
  try {
    const { takePrefetchClaim } = await import('./modelStatus.mjs');
    return takePrefetchClaim(session, file, { now });
  } catch { return null; }
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
    `不要整文件 Read。先检索 \`${searchCmd} <符号或关键词> --k 5\`(找定义可加 \`--symbol <符号>\`;命中的 file:起-止即大纲),` +
    `再按该区间用 Read 的 offset/limit 精读。` +
    `若确实需要全文,5 分钟内对同一文件再发一次同样的全量 Read 即放行。`
  );
}

/** 实验数据保护(2026-10-31 用户要求):A/B 实验唯一的原始证据,现行落位 agent_reports/ab-logs/
 *  (2026-11-11 自 test/ab/result 迁入;更早为 data/ab,2026-11-07 迁出),
 *  删了只能从本地会话库重建(见 tools/ab/recover-db.mjs)。禁止顺手清理。
 *  命中两类:①git clean 带 -x/-X(会连带删掉被 gitignore 的 data/ab);②递归删除命中数据目录或其保护祖先。
 *  旧路径 test/ab 仍在正则内(防历史脚本/文档引用期残留)。 */
const PROTECTED_DATA = /(^|[\\/])(?:test[\\/]ab|agent_reports[\\/]ab-logs)([\\/]|$)/i;
const RM_CMDS = /^(?:rm|rmdir|del|erase|remove-item|rd)$/i; // S3-F2:补 rd(cmd 递归删)
/** 宿主工具输出截断阈值(ZCode persisted-output >32KB 存盘只给 2KB 预览;Qoder/Cursor 近似同量级):
 *  Bash 拦截记账的节约上限——放行时宿主也会截断,超过它的部分不算"省下的"。 */
const HOST_OUTPUT_CAP_BYTES = 32 * 1024;

function expandTarget(t, cwd) {
  let s = String(t || '').trim().replace(/^["']|["']$/g, '');
  s = s.replace(/^(\$\{?PWD\}?|\$\(pwd\)|%CD%)[\\/]/i, '');
  if (!s) return null;
  try {
    let abs = path.resolve(cwd, s);
    // 20261120-S3-F2(夜审):Windows 8.3 短名(XXXX~N)绕过——只对**命令里字面带短名段**的目标做
    // realpathSync.native 归一(rm -rf AGENT_~1 曾全 allow);cwd 前缀自带的短名(如 ADMINI~1)不动,
    // 避免归一后与 cwd 两侧异形、相对比较全失效。归一出的真实路径照走 PROTECTED_DATA/protectedUnder。
    if (/[~][0-9]/.test(s) && fs.existsSync(abs)) {
      try { abs = fs.realpathSync.native(abs); } catch { /* 归一失败走字面 */ }
    }
    return abs;
  } catch { return null; }
}

/** S3-1(20261119 夜审):目录盘上实存核验——目标目录(-C 仓/递归删除目标)下现有 agent_reports/ab-logs
 *  (或旧 test/ab/result)即视为含保护数据。cwd 单点 hasProtected 挡不住跨 cwd 形态;按存在性核验,无数据目录不误伤。 */
function protectedUnder(dir) {
  if (!dir || typeof dir !== 'string') return false;
  try {
    return fs.existsSync(path.join(dir, 'agent_reports', 'ab-logs')) || fs.existsSync(path.join(dir, 'test', 'ab', 'result'));
  } catch { return false; }
}

/** 纯函数:判断命令是否会清掉受保护的实验数据。hasProtected 由调用方按 cwd 下是否存在 agent_reports/ab-logs(或旧 test/ab/result)传入。
 *  S3-1(20261119 夜审):跨 cwd 形态不再只看 cwd 单点——git -C 目标仓与递归/通配删除的绝对目标按盘上实存核验(protectedUnder)。 */
export function evaluateCleanGuard({ command, cwd = process.cwd(), hasProtected = false } = {}) {
  const cmd = String(command ?? '');
  if (!cmd.trim()) return { permission: 'allow' };
  // 20261120-S3-F2(夜审):cwd 自身含 8.3 短名段(如 ADMINI~1 前缀)先归一长形——expandTarget 对字面
  // 短名目标做 realpath 归一会得到整条长形路径,两侧异形则 covers/path.relative 全失效误放行。
  try { if (/[~][0-9]/.test(cwd) && fs.existsSync(cwd)) cwd = fs.realpathSync.native(cwd); } catch { /* 归一失败走原样 */ }
  // 20261120-S3-F1(夜审):分割正则补单管道 |——旧分割只切 &&/||/;/换行,管道右侧的 rm/git clean 整段逃判
  // (echo x | rm -rf test/ab 与 cat f | xargs rm -rf agent_reports/ab-logs 曾 allow)。
  // alternation 左优先:模式串里 \|\| 在裸 \| 之前,双管道整体先匹配,不会被拆成两个单管道。
  for (const raw of cmd.split(/&&|\|\||\||;|\n/)) {
    const seg = raw.trim();
    if (!seg) continue;
    const tokens0 = seg.split(/\s+/).filter(Boolean);
    if (!tokens0.length) continue;
    // 20261120-S3-F1b(NP1b):管道右侧「xargs rm …」形态——头是 xargs 本身无害,危险命令嵌在其参数里;
    // 跳到 xargs 后的首个删除/git 命令再走删除判定(与单管道分段同族的第二形态,夜审 cat f | xargs rm -rf 实例)。
    let tokens = tokens0;
    if (/^xargs(\.exe)?$/i.test(path.basename(tokens0[0].replace(/^["']|["']$/g, '')).toLowerCase())) {
      const dangerCmd = (t) => { const b = path.basename(String(t).replace(/^["']|["']$/g, '')).toLowerCase(); return RM_CMDS.test(b) || /^git(\.exe)?$/.test(b); };
      const k = tokens0.findIndex((t, idx) => idx > 0 && dangerCmd(t));
      if (k <= 0) continue; // xargs 后无删除命令:无害(如 xargs grep)
      tokens = tokens0.slice(k);
    }
    const head = tokens[0].replace(/^["']|["']$/g, '');
    const headBase = path.basename(head).toLowerCase(); // S3-F2:全路径 git.exe/rm 也认
    // ①git clean -x / -X:连被 gitignore 的文件一起删(旧 data/ab 曾因此被误删)
    if (/^git(\.exe)?$/.test(headBase)) {
      const sub = tokens.slice(1).map(t => t.replace(/^["']|["']$/g, ''));
      if (sub.includes('clean') && sub.some(t => /^-[A-Za-z]*[xX][A-Za-z]*$/.test(t) || /^--ignored/i.test(t))) {
        // S3-1(20261119 夜审):-C 目标仓实存核验——clean 的作用域是 -C 指的仓,不是会话 cwd;
        // 他仓 cwd 的 `git -C <受保护仓> clean -x` 曾按 cwd 单点判定放行。
        let repoDir = null;
        for (let i = 0; i < sub.length; i++) {
          if (sub[i] === '-C' && sub[i + 1] != null) { repoDir = sub[i + 1]; break; }
          const glued = /^-C(.+)$/.exec(sub[i]);
          if (glued) { repoDir = glued[1].replace(/^["']|["']$/g, ''); break; }
        }
        let repoHas = false;
        if (repoDir != null) { try { repoHas = protectedUnder(path.resolve(cwd, repoDir)); } catch { repoHas = false; } }
        if (hasProtected || repoHas) {
          return { permission: 'deny', kind: 'Clean', reason: repoDir != null ? `git clean 带 -x/-X(-C 目标仓含保护数据 ${repoDir})` : 'git clean 带 -x/-X' };
        }
      }
      continue;
    }
    // ②递归删除命中 data/ab 或父目录 data
    const isRm = RM_CMDS.test(headBase) || (headBase === 'find' && tokens.includes('-delete')); // S3-F2:find -delete 视同递归删
    if (!isRm) continue;
    const rest = tokens.slice(1);
    // 递归标志:POSIX 组合式(-rf/-fr/-R)、长写(--recurse/--recursive)、cmd 风格斜杠(/s /r)
    const recursive = (headBase === 'find' && rest.includes('-delete')) || rest.some((t) => { // S3-F2:find -delete 恒递归
      if (/^--/.test(t)) return /^--(recurse|recursive)$/i.test(t);
      if (/^[-/]/.test(t)) return /[rRs]/.test(t.slice(1));
      return false;
    });
    // S3-F1(2026-11-17 夜审):非递归通配删除(rm agent_reports/ab-logs/* / del …\*.json)不走 -r 门控,
    // 但 glob 会清空保护目录内容——glob 目标的目录部分落入保护目录/工作区即拦(结构性缺口补全)。
    // S3-F1(20261118 扩):通配元字符不止 * —— ?(单字符)与 [...](字符组)同样是 glob 展开形态,
    // 只查 * 会漏放「ab-logs/?????」「[a-z][a-z]」;Windows 文件名禁用 ?(不会误杀真实文件),[ 允许但极罕见。
    // S3-F4(20261118):目标含变量引用(rm $X/*)→静态解析不出真实目录,无法证明安全即按危险处理
    // (与递归分支「变量整体承载」同口径)。
    // S3-F2(20261118):**绝对路径**通配目标与递归分支对齐——绝对路径可指向别仓的证据目录,
    // 不能凭本 cwd 的 hasProtected 判安全;相对路径仍按 hasProtected(无数据工作区不误伤)。
    const isGlobTarget = (s) => /[*?]/.test(s) || /\[[^\]]*\]/.test(s);
    const hasVarRef = (s) => /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z0-9_]+%/.test(s);
    const covers = (from, to) => { const rel = path.relative(from, to); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
    for (const t of rest) {
      if (t.startsWith('-')) continue;
      const bare = t.replace(/^["']|["']$/g, '');
      if (!isGlobTarget(bare)) continue;
      if (hasVarRef(bare)) {
        return { permission: 'deny', kind: 'Clean', reason: `通配删除目标含变量引用(${t}),无法静态验证——请改用字面量路径` };
      }
      const dirPart = bare.split(/[\\/]/).filter((s) => s && !isGlobTarget(s)).join('/');
      const absDir = expandTarget(dirPart || '.', cwd);
      if (!absDir) continue;
      const norm = absDir.replace(/[\\/]+$/, '');
      const isAbs = path.isAbsolute(bare);
      if (PROTECTED_DATA.test(absDir) || /(^|[\\/])data$/i.test(norm)) {
        if (isAbs || hasProtected) return { permission: 'deny', kind: 'Clean', reason: `通配删除命中保护目录 ${bare}(非递归也可清空证据)` };
      }
      // 2A(20261119 用户裁定):data/ 子目录通配清空同拦(rm data/routing/* 等)
      { const rel = path.relative(path.resolve(cwd, 'data'), norm); if ((rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) && (isAbs || hasProtected)) return { permission: 'deny', kind: 'Clean', reason: `通配删除命中本地数据目录 ${bare}(data/ 子目录为本地资产)` }; }
      // S3-1(20261119 夜审):绝对路径通配打他仓根,与递归分支同口径盘上核验(相对路径仍按 hasProtected 不误伤)
      if (isAbs && protectedUnder(absDir)) return { permission: 'deny', kind: 'Clean', reason: `通配删除目标目录含保护数据 ${bare}` };
      if (hasProtected) {
        if (covers(absDir, path.resolve(cwd, 'agent_reports', 'ab-logs'))
          || covers(absDir, path.resolve(cwd, 'test', 'ab'))
          || norm === path.resolve(cwd)) {
          return { permission: 'deny', kind: 'Clean', reason: `通配删除命中保护目录 ${bare}(非递归也可清空证据)` };
        }
      }
    }
    if (!recursive) continue;
    for (const t of rest) {
      if (t.startsWith('-')) continue;
      // S3-F1(2026-11-11 夜审):目标整体是变量引用($D/"${D}"/%D%)时静态解析不出真实路径——
      // 变量可整体承载受保护段(实测绕过形态),无法证明安全即按危险处理,提示改字面量路径。
      const bare = t.replace(/^["']|["']$/g, '');
      if (hasProtected && (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(bare) || /^%[A-Za-z0-9_]+%$/.test(bare))) {
        return { permission: 'deny', kind: 'Clean', reason: `递归删除目标是变量引用(${t}),无法静态验证——请改用字面量路径` };
      }
      const abs = expandTarget(t, cwd);
      if (!abs) continue;
      if (PROTECTED_DATA.test(abs)) return { permission: 'deny', kind: 'Clean', reason: `递归删除命中 ${abs}` };
      const norm = abs.replace(/[\\/]+$/, '');
      if (/(^|[\\/])data$/i.test(norm)) return { permission: 'deny', kind: 'Clean', reason: `递归删除命中 ${abs}` };
      // 2A(20261119 用户裁定):data/ 全子目录(routing/vectors/usage/nightly…)为本地学习资产,
      // 删了不可再生且无版本控制兜底——定向递归删同样拦截,不止整 data 目录。
      { const rel = path.relative(path.resolve(cwd, 'data'), norm); if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { permission: 'deny', kind: 'Clean', reason: `递归删除命中本地数据目录 ${abs}(data/ 子目录为本地资产,禁递归清理)` }; }
      // S3-1(20261119 夜审):仓根实存核验——`rm -rf <他仓根>` 路径本体不带保护段、hasProtected 又按本 cwd
      // 判 false ⇒ 曾放行;目标目录实存且其下有保护数据即拦。与 -C 目标仓同一 protectedUnder。
      if (protectedUnder(abs)) return { permission: 'deny', kind: 'Clean', reason: `递归删除目标含保护数据目录 ${abs}` };
      if (norm === path.resolve(cwd) || /(^|[\\/])\*$/.test(norm)) {
        return { permission: 'deny', kind: 'Clean', reason: `递归删除命中工作区根 ${norm}` };
      }
      // S3-F1(2026-11-11 夜审):目标覆盖保护目录或 cwd 即拦——`rm -rf ..`/`../..`/`test/ab/result/../..`
      // 解析后落在保护目录的祖先(旧四条规则按"目标是保护路径后缀"判,祖先全不命中)。
      if (hasProtected) {
        const covers = (from, to) => { const rel = path.relative(from, to); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
        if (covers(abs, path.resolve(cwd, 'agent_reports', 'ab-logs')) || covers(abs, path.resolve(cwd, 'test', 'ab')) || covers(abs, path.resolve(cwd))) {
          return { permission: 'deny', kind: 'Clean', reason: `递归删除命中保护目录祖先/工作区自身 ${abs}` };
        }
      }
    }
  }
  return { permission: 'allow' };
}

export function cleanGuardMessage() {
  return (
    'code-index: 已阻止清理 A/B 实验数据(agent_reports/ab-logs)。那里是这批实验唯一的原始证据,' +
    '不在版本控制内,删掉只能从本地会话库重建。要重跑实验请直接覆盖写' +
    '(prepare 只清 agent_reports/ab-logs/work 下的任务目录),不要先删整个目录;确需清理请先征得用户同意,' +
    '或改成只删具体文件(路径里不要出现 agent_reports/ab-logs)。' +
    '若已经误删,可用 `node tools/ab/recover-db.mjs` 从 ~/.zcode/cli/db/db.sqlite 重建。'
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
    `① 先检索 \`${searchCmd} <关键词> --k 5\` 定位内容(找定义可加 \`--symbol <符号>\`;命中的 file:起-止即大纲);` +
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

/**
 * 护栏面与索引面统一(2026-11-07 用户定案):**只有 exts 白名单内的文本类型才做全量 Read 拦截与记账**;
 * 白名单外(图片/二进制/未收录类型)一律直接放行——它们不在索引口径里,按文本 bytes/4 折算记账必然失真
 * (实弹:3MB jpg 曾记 78.6 万×放大=2038 万虚账;图片走宿主视觉通道真实成本千级)。
 * 运行时读 data JSON 覆盖(与 resolveReadMaxLines 同模式),缺省回落 DEFAULT_CONFIG.exts。
 */
export function resolveGuardExts() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (Array.isArray(j.exts) && j.exts.length) return new Set(j.exts.map((s) => String(s).toLowerCase().replace(/^\./, '')));
  } catch { /* 缺文件或坏 JSON:用默认 */ }
  return new Set(DEFAULT_CONFIG.exts);
}

/** Grep 补封顶上限:写死,不走配置(防大仓库匹配倾倒;PreToolUse 拿不到结果量,此路不记账)。 */
export const GREP_HEAD_LIMIT = 100;

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

/** 按方言选改写体。Cursor 用 updated_input;agent_message 把选段说明送回模型。 */
export function rewriteFor(dialect, updatedInput, context) {
  if (dialect === 'cursor') {
    return { permission: 'allow', updated_input: updatedInput, agent_message: context };
  }
  return rewriteBody(updatedInput, context);
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
    if (st.size > HUGE_BYTES || totalLines <= 0) return Math.ceil(st.size * Math.min(1, (e - s + 1) / totalLines));
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

/** 放行窗口键:Windows 路径大小写不敏感,统一小写,否则同一文件的两种写法各记一条,逃生舱失效、重复记账。 */
export function denialKey(file) {
  return process.platform === 'win32' ? String(file).toLowerCase() : String(file);
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

/** 二进制嗅探:前 8KB 含 NUL 字节即判二进制(任何文本编码都绝无 NUL;UTF-16 文件不在索引白名单,可接受)。
 *  仅对 exts 白名单内的文件兜底(名义 .json/.xml 实为二进制的边缘);白名单外已在入口统一放行。 */
function isBinaryFile(file, size) {
  if (!(Number(size) > 0)) return false;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(Number(size), 8192));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.slice(0, n).includes(0);
  } catch { return false; } finally { if (fd != null) { try { fs.closeSync(fd); } catch { /* 已关 */ } } }
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

/** Grep:未带 head_limit 的调用补封顶,防大仓库匹配倾倒。拿不到结果量,不记账。 */
function grepGuard(input, dialect) {
  const ti = input.tool_input || {};
  if (ti.head_limit == null && supportsRewrite(input)) {
    const body = rewriteFor(
      dialect,
      { ...ti, head_limit: GREP_HEAD_LIMIT },
      `[code-index] 已给本次 Grep 补 head_limit=${GREP_HEAD_LIMIT} 封顶输出(原调用未带)。` +
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
  // 实验数据保护:先于整读拦截,命中就拒(不做 5 分钟放行,不可撤销)。
  const hasProtectedData = fs.existsSync(path.join(cwd, 'agent_reports', 'ab-logs')) || fs.existsSync(path.join(cwd, 'test', 'ab', 'result'));
  const clean = evaluateCleanGuard({ command: cmd, cwd, hasProtected: hasProtectedData });
  if (clean.permission === 'deny') {
    const body = formatDecision(dialect, 'deny', cleanGuardMessage());
    respond(body);
    return body;
  }
  const denials = loadDenials(convId);
  const key = catDumpPieces(cmd).join(' && ');
  const stats = [];
  const guardedExts = resolveGuardExts();
  const statFile = (f) => {
    const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
    // 白名单统一(2026-11-07):cat 图片/二进制/未收录类型不进文本行数闸与记账——
    // 二进制的"行数"本就是乱码,判定失真;记账口径也只对索引面内的文本成立。
    if (!guardedExts.has(path.extname(abs).slice(1).toLowerCase())) return null;
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    if (isBinaryFile(abs, st.size)) return null;
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
    // 5 分钟内重发同一命令 → 放行。放行不倒扣之前 deny 的累计记账(不发票据)。
    delete denials[key];
    try { saveDenials(convId, denials); } catch { /* 仍放行 */ }
    return emit(dialect, 'allow');
  }
  if (decision.permission !== 'deny' || !key) return emit(dialect, 'allow');
  // 记账口径(2026-11-07 修 Bash 侧虚高):宿主对 >32KB 的工具输出做 persisted-output 存盘只给
  // 2KB 预览——即使放行,全文也不会进上下文,拦截的真实节约上限是宿主截断阈值,不是文件全量。
  // 记账 = min(文件合计, 32KB);行数闸(totalLines)判定不受影响。
  const size = Math.min(stats.reduce((n, s) => n + s.size, 0), HOST_OUTPUT_CAP_BYTES);
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
  // Bash/Shell 与 Cursor beforeShellExecution 走整读拦截;Grep 三端补 head_limit。
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
  const dkey = denialKey(file);

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return emit(dialect, 'allow');
  }
  if (!st.isFile()) return emit(dialect, 'allow');

  // 白名单统一(2026-11-07 用户定案):exts 外的文件类型不做全量 Read 拦截/记账——图片走宿主视觉通道
  // (真实成本视觉 token 千级,按文本 bytes/4 折算曾放大两个数量级:3MB jpg=78.6 万×25 请求=2038 万虚账),
  // 二进制/未收录类型同理不在索引口径。放行不计账不留痕——文本节约口径只对 exts 内的文本文件成立。
  // 白名单内仍保留 NUL 嗅探兜底(名义 .json/.xml 实为二进制的文件)。
  if (!resolveGuardExts().has(path.extname(file).slice(1).toLowerCase())) return emit(dialect, 'allow');
  if (isBinaryFile(file, st.size)) return emit(dialect, 'allow');

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
    denialAt: denials[dkey]?.at,
    readMaxLines: resolveReadMaxLines(),
    lines,
  });

  if (decision.override) {
    // 5 分钟内重发同一文件 → 放行。全文此刻真的进了上下文,那笔 deny/改写的节约不成立:
    // 追加 void 事件(与原事件同 session|file|at)配对,modelStatus 退款(入口一次+已入账,只退一次)。
    // Bash 不退款:宿主对超限输出做 persisted-output 存盘截断,全文并未进上下文。
    const d = denials[dkey];
    if (d && Number(d.bytes) > 0) {
      await trackEvent({ at: d.at, session: convId, kind: d.kind || 'Read', file, bytes: d.bytes, void: true });
    }
    delete denials[dkey];
    try { saveDenials(convId, denials); } catch { /* 仍放行 */ }
    return emit(dialect, 'allow');
  }

  if (decision.permission === 'deny') {
    // 三端改写路径(默认):选得出语义区间就改写入参,选不出(无意图/索引缺失/不相关)落回 deny
    if (supportsRewrite(input)) {
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
          const body = rewriteFor(
            dialect,
            { ...ti, offset: s, limit },
            rewriteGuidance({ file, lines, size: st.size, range, searchCmd: searchCmd() }),
          );
          const claim = await takePrefetchClaimSafe(convId, file, now);
          const compressed = claim ? (Number(claim.injectedTokens) || 0) : Math.ceil(rangeBytes / 4);
          try {
            const { addInputSavings } = await import('./modelStatus.mjs');
            addInputSavings(tokensFromBlockedBytes(st.size), compressed);
          } catch { /* 记账失败仍改写 */ }
          await trackEvent(claim
            ? { at: now, session: convId, kind: 'Prefetch', file, bytes: st.size, originalTokens: tokensFromBlockedBytes(st.size), compressedTokens: compressed }
            : { at: now, session: convId, kind: 'Rewrite', file, bytes: st.size, rangeBytes, s, e: Math.min(range.e, lines) });
          markHookRewrite(convId, file, now);
          // 改写也登记一次拦截:5 分钟内重发同一文件即放行全文(与 deny 同口径的逃生舱)
          try {
            denials[dkey] = { at: now, agentType: detectAgentType(input), response: body, bytes: st.size, kind: claim ? 'Prefetch' : 'Rewrite', file };
            saveDenials(convId, denials);
          } catch { /* 登记不上不影响改写 */ }
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
      denials[dkey] = { at: now, agentType: detectAgentType(input), response: body, bytes: st.size, kind: 'Read' };
      saveDenials(convId, denials);
    } catch {
      return emit(dialect, 'allow');
    }
    // 预取免读转正(PU-002 A):同会话同文件有未转正 claim → 本次拦截证实免读,
    // 以 claim 的注入量为 compressed 入账一次,guard 自身不再重复计;无 claim 走原口径。
    const claim = await takePrefetchClaimSafe(convId, file, now);
    if (claim) {
      const tok = tokensFromBlockedBytes(st.size);
      try {
        const { addInputSavings } = await import('./modelStatus.mjs');
        addInputSavings(tok, Number(claim.injectedTokens) || 0);
      } catch { /* 记账失败仍拒绝 */ }
      await trackEvent({ at: now, session: convId, kind: 'Prefetch', file, bytes: st.size, originalTokens: tok, compressedTokens: Number(claim.injectedTokens) || 0 });
      denials[dkey] = { ...denials[dkey], kind: 'Prefetch' };
      try { saveDenials(convId, denials); } catch { /* 仍拒绝 */ }
    } else {
      await recordBlockedBytes(st.size);
      await trackEvent({ at: now, session: convId, kind: 'Read', file, bytes: st.size });
    }
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
