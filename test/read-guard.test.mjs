#!/usr/bin/env node
/** read-guard 端到端测试:超行数 Read/Bash cat 拦截、offset/limit 放行、5 分钟重试、BOM、fail-open、记账。启动:cd code-index && npm test(或 node ../test/read-guard.test.mjs) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rewriteCursorUserHooks, rewriteQoderUserHooks } from '../code-index/init.mjs';
import { bashOversizeGuidance, catDumpPieces, detectAgentType, detectDialect, evaluateBashGuard, evaluateReadGuard, formatDecision, markHookRewrite, oversizeGuidance, OVERRIDE_WINDOW_MS, rewriteBody, rewriteFor, rewriteGuidance, supportsRewrite, tokensFromBlockedBytes, bytesOfLines } from '../code-index/read-guard.mjs';
import { pickSpan, pathMatchesChunk } from '../code-index/rangePick.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(here, '..', 'code-index', 'read-guard.mjs');
assert.equal(detectDialect({ hook_event_name: 'PreToolUse' }), 'claude');
assert.equal(detectDialect({ hook_event_name: 'preToolUse' }), 'cursor');
assert.equal(detectDialect({}, { ZCODE_SESSION_ID: 's' }), 'claude');
assert.equal(detectDialect({}, { QODER_PROJECT_DIR: 'D:/p' }), 'claude');
assert.equal(detectDialect({}, { CURSOR_AGENT: '1' }), 'cursor');
assert.equal(detectAgentType({}, { ZCODE_SESSION_ID: 's' }), 'zcode');
assert.equal(detectAgentType({}, { QODER_PROJECT_DIR: 'D:/p' }), 'qoder');
assert.equal(detectAgentType({}, { CURSOR_AGENT: '1' }), 'cursor');
assert.equal(detectAgentType({ hook_event_name: 'preToolUse' }, {}), 'cursor');
assert.equal(detectAgentType({ hook_event_name: 'PreToolUse' }, {}), 'unknown');
assert.equal(supportsRewrite({}, { ZCODE_SESSION_ID: 's' }), true);
assert.equal(supportsRewrite({}, { QODER_PROJECT_DIR: 'D:/p' }), true, 'Qoder 实测采纳 updatedInput');
assert.equal(supportsRewrite({}, { CURSOR_AGENT: '1' }), true, 'Cursor preToolUse 采纳 updated_input');
assert.equal(supportsRewrite({ hook_event_name: 'PreToolUse' }, {}), false, '无宿主标记不改写');
assert.equal(formatDecision('cursor', 'allow').permission, 'allow');
assert.equal(formatDecision('claude', 'allow').hookSpecificOutput, undefined);
assert.equal(formatDecision('claude', 'deny', 'x').hookSpecificOutput.permissionDecision, 'deny');
assert.equal(formatDecision('claude', 'deny', 'x').permission, undefined);

const cap = 500;
const slack = cap * 1.25;

assert.equal(evaluateReadGuard({
  toolName: 'Read',
  toolInput: { path: 'a.js', offset: 10, limit: 20 },
  now: 1,
  readMaxLines: cap,
  lines: 9000,
}).permission, 'allow');

assert.equal(evaluateReadGuard({
  toolName: 'Read',
  toolInput: { path: 'a.js', offset: 0 },
  now: 1,
  readMaxLines: cap,
  lines: 9000,
}).permission, 'allow');

assert.equal(evaluateReadGuard({
  toolName: 'Grep',
  toolInput: { path: 'a.js' },
  now: 1,
  readMaxLines: cap,
  lines: 9000,
}).permission, 'allow');

assert.equal(evaluateReadGuard({
  toolName: 'Read',
  toolInput: { path: 'a.js' },
  now: 1,
  readMaxLines: cap,
  lines: slack,
}).permission, 'allow');

assert.equal(evaluateReadGuard({
  toolName: 'Read',
  toolInput: { path: 'a.js' },
  now: 1,
  readMaxLines: cap,
  lines: slack + 1,
}).permission, 'deny');

const over = evaluateReadGuard({
  toolName: 'Read',
  toolInput: { path: 'a.js' },
  now: 10_000,
  denialAt: 10_000 - 1000,
  readMaxLines: cap,
  lines: 9000,
});
assert.equal(over.permission, 'allow');
assert.equal(over.override, true);

assert.equal(evaluateReadGuard({
  toolName: 'Read',
  toolInput: { path: 'a.js' },
  now: OVERRIDE_WINDOW_MS + 2,
  denialAt: 1,
  readMaxLines: cap,
  lines: 9000,
}).permission, 'deny');

assert.equal(evaluateReadGuard({
  toolName: 'Read',
  toolInput: { path: 'a.js' },
  now: 1,
  readMaxLines: 0,
  lines: 9000,
}).permission, 'allow');

const msg = oversizeGuidance({
  file: 'D:/p/big.js',
  lines: 900,
  size: 40_000,
  readMaxLines: cap,
  searchCmd: 'node "D:/p/search.mjs"',
});
assert.match(msg, /search\.mjs/);
assert.match(msg, /offset\/limit/);
assert.doesNotMatch(msg, /context_query/);

// --- Bash cat 整读 ---
const statBig = (f) => (f === 'big.js' ? { file: f, isFile: true, lines: 800, size: 20_000 } : null);
assert.deepEqual(catDumpPieces('cat big.js | head -5'), []);
assert.deepEqual(catDumpPieces('cat big.js > out.txt'), []);
assert.deepEqual(catDumpPieces('grep x big.js'), []);
assert.deepEqual(catDumpPieces('cat big.js && tail -1 other.log'), ['cat big.js']);

assert.equal(evaluateBashGuard({ command: 'cat big.js', now: 1, readMaxLines: cap, statFile: statBig }).permission, 'deny');
assert.equal(evaluateBashGuard({ command: 'cat big.js | head -20', now: 1, readMaxLines: cap, statFile: statBig }).permission, 'allow');
assert.equal(evaluateBashGuard({ command: 'cat big.js > out.txt', now: 1, readMaxLines: cap, statFile: statBig }).permission, 'allow');
assert.equal(evaluateBashGuard({ command: 'cat small.js', now: 1, readMaxLines: cap, statFile: () => null }).permission, 'allow');
assert.equal(evaluateBashGuard({ command: 'cat big.js && echo done', now: 1, readMaxLines: cap, statFile: statBig }).permission, 'deny');
assert.equal(evaluateBashGuard({ command: 'cat -n big.js', now: 1, readMaxLines: cap, statFile: statBig }).permission, 'deny');
assert.equal(evaluateBashGuard({ command: 'wc -l big.js', now: 1, readMaxLines: cap, statFile: statBig }).permission, 'allow');
const bashOver = evaluateBashGuard({ command: 'cat big.js', now: 10_000, denialAt: 10_000 - 1000, readMaxLines: cap, statFile: statBig });
assert.equal(bashOver.permission, 'allow');
assert.equal(bashOver.override, true);

const bMsg = bashOversizeGuidance({ files: ['D:/p/big.js'], lines: 900, size: 40_000, readMaxLines: cap, searchCmd: 'node "D:/p/search.mjs"' });
assert.match(bMsg, /search\.mjs/);
assert.match(bMsg, /offset\/limit/);
assert.match(bMsg, /sed -n/);
assert.match(bMsg, /grep -n/);
assert.match(bMsg, /5 分钟内重发同一命令即放行/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rg-'));
const big = path.join(tmp, 'big.js');
fs.writeFileSync(big, Array.from({ length: 800 }, (_, i) => `const n${i} = ${i};`).join('\n'));
const dataDir = path.join(tmp, 'data');
const env = { ...process.env, CODE_INDEX_DATA_DIR: dataDir };
for (const k of Object.keys(env)) if (/^(QODER_|ZCODE_|CURSOR_)/.test(k)) delete env[k];
const payload = {
  hook_event_name: 'preToolUse',
  conversation_id: 'c1',
  tool_name: 'Read',
  tool_input: { path: big },
  cwd: tmp,
};

function runHook(input) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

assert.equal(tokensFromBlockedBytes(0), 0);
assert.equal(tokensFromBlockedBytes(4), 1);
assert.equal(tokensFromBlockedBytes(5), 2);

const blockedTokens = tokensFromBlockedBytes(fs.statSync(big).size);
const first = runHook(payload);
assert.equal(first.status, 0, first.stderr);
const cursorOut = JSON.parse(first.stdout);
assert.equal(cursorOut.permission, 'deny');
assert.match(cursorOut.agent_message, /offset\/limit/);
const cursorState = JSON.parse(fs.readFileSync(path.join(dataDir, 'read-guard', 'c1.json'), 'utf8'));
assert.equal(cursorState.denials[big].agentType, 'cursor');
assert.deepEqual(cursorState.denials[big].response, cursorOut);
const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'session-savings.json'), 'utf8'));
const day = Object.values(ledger.days)[0];
assert.equal(day.originalTokens, blockedTokens);
assert.equal(day.compressedTokens, 0);
assert.equal(day.savedTokens, blockedTokens);

const second = runHook(payload);
assert.equal(JSON.parse(second.stdout).permission, 'allow');
const ledgerAfterAllow = JSON.parse(fs.readFileSync(path.join(dataDir, 'session-savings.json'), 'utf8'));
assert.equal(Object.values(ledgerAfterAllow.days)[0].savedTokens, blockedTokens, '5 分钟放行不倒扣之前 deny 的累计记账');
// 放行只删放行记录,不发票据(没有 void 事件):deny 的账保留在账本里
const evtsAfterAllow = fs.readFileSync(path.join(dataDir, 'read-guard', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.ok(evtsAfterAllow.every((e) => !e.void), '放行不发票据,不做 void 退款');
assert.ok(evtsAfterAllow.some((e) => e.kind === 'Read' && e.session === 'c1'), '原 deny 事件仍在,账保留');

const bom = spawnSync(process.execPath, [hook], {
  input: `\uFEFF${JSON.stringify({ ...payload, conversation_id: 'c-bom' })}`,
  encoding: 'utf8',
  env,
  windowsHide: true,
});
assert.equal(JSON.parse(bom.stdout).permission, 'deny', bom.stderr);

const ranged = runHook({ ...payload, tool_input: { path: big, offset: 1, limit: 20 } });
assert.equal(JSON.parse(ranged.stdout).permission, 'allow');

const bad = spawnSync(process.execPath, [hook], {
  input: 'not-json',
  encoding: 'utf8',
  env,
  windowsHide: true,
});
assert.equal(JSON.parse(bad.stdout).permission, 'allow');

const claudeEnv = { ...env, ZCODE_SESSION_ID: 's1' };
const claudePayload = {
  hook_event_name: 'PreToolUse',
  session_id: 'c-claude',
  tool_name: 'Read',
  tool_input: { file_path: big },
  cwd: tmp,
};
function runClaude(input) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: claudeEnv,
    windowsHide: true,
  });
}
const claudeDeny = JSON.parse(runClaude(claudePayload).stdout);
assert.equal(claudeDeny.hookSpecificOutput.permissionDecision, 'deny');
assert.match(claudeDeny.hookSpecificOutput.permissionDecisionReason, /offset\/limit/);
assert.equal(claudeDeny.permission, undefined);
const claudeRetry = JSON.parse(runClaude(claudePayload).stdout);
assert.equal(claudeRetry.hookSpecificOutput, undefined);
assert.equal(claudeRetry.permission, undefined);

const qoderEnv = { ...env, QODER_PROJECT_DIR: 'D:/p' };
const qoderPayload = {
  hook_event_name: 'PreToolUse',
  session_id: 'c-qoder',
  tool_name: 'Read',
  tool_input: { file_path: big },
  cwd: tmp,
};
const qoderOut = JSON.parse(spawnSync(process.execPath, [hook], {
  input: JSON.stringify(qoderPayload),
  encoding: 'utf8',
  env: qoderEnv,
  windowsHide: true,
}).stdout);
assert.equal(qoderOut.hookSpecificOutput.permissionDecision, 'deny');
const qoderState = JSON.parse(fs.readFileSync(path.join(dataDir, 'read-guard', 'c-qoder.json'), 'utf8'));
assert.equal(qoderState.denials[big].agentType, 'qoder');
assert.deepEqual(qoderState.denials[big].response, qoderOut);

const bashPayload = {
  hook_event_name: 'preToolUse',
  conversation_id: 'c-bash',
  tool_name: 'Bash',
  tool_input: { command: `cat ${big}` },
  cwd: tmp,
};
const bashDeny = JSON.parse(runHook(bashPayload).stdout);
assert.equal(bashDeny.permission, 'deny');
assert.match(bashDeny.agent_message, /grep -n/);
assert.match(bashDeny.agent_message, /sed -n/);
const bashState = JSON.parse(fs.readFileSync(path.join(dataDir, 'read-guard', 'c-bash.json'), 'utf8'));
assert.ok(bashState.denials[`cat ${big}`]);
const bashRetry = JSON.parse(runHook(bashPayload).stdout);
assert.equal(bashRetry.permission, 'allow');

const cursorShellDeny = JSON.parse(runHook({
  hook_event_name: 'beforeShellExecution',
  conversation_id: 'c-shell',
  command: `cat ${big}`,
  cwd: tmp,
}).stdout);
assert.equal(cursorShellDeny.permission, 'deny');
assert.match(cursorShellDeny.agent_message, /sed -n/);
const shellState = JSON.parse(fs.readFileSync(path.join(dataDir, 'read-guard', 'c-shell.json'), 'utf8'));
assert.ok(shellState.denials[`cat ${big}`]);
assert.equal(shellState.denials[`cat ${big}`].agentType, 'cursor');

const cursorShellTool = JSON.parse(runHook({
  hook_event_name: 'preToolUse',
  conversation_id: 'c-shell-tool',
  tool_name: 'Shell',
  tool_input: { command: `cat ${big}` },
  cwd: tmp,
}).stdout);
assert.equal(cursorShellTool.permission, 'deny');

const claudeBashPiped = JSON.parse(runClaude({
  hook_event_name: 'PreToolUse',
  session_id: 'c-bash-c',
  tool_name: 'Bash',
  tool_input: { command: `cat ${big} | tail -3` },
  cwd: tmp,
}).stdout);
assert.equal(claudeBashPiped.hookSpecificOutput, undefined);

const claudeBashDeny = JSON.parse(runClaude({
  hook_event_name: 'PreToolUse',
  session_id: 'c-bash-c',
  tool_name: 'Bash',
  tool_input: { command: `cat ${big}` },
  cwd: tmp,
}).stdout);
assert.equal(claudeBashDeny.hookSpecificOutput.permissionDecision, 'deny');
assert.match(claudeBashDeny.hookSpecificOutput.permissionDecisionReason, /sed -n/);

const hookRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rg-hook-'));
rewriteCursorUserHooks({ home: hookRoot });
const fwd = path.join(hookRoot, '.cursor', 'hooks', 'read-guard.mjs');
const fwdDir = path.join(tmp, 'data-fwd');
const fwdChild = spawn(process.execPath, [fwd], {
  env: { ...env, CODE_INDEX_DATA_DIR: fwdDir },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let fwdOut = '';
let fwdErr = '';
fwdChild.stdout.on('data', (d) => { fwdOut += d; });
fwdChild.stderr.on('data', (d) => { fwdErr += d; });
const fwdResult = await new Promise((resolve) => {
  fwdChild.on('close', (status) => resolve(status));
  setTimeout(() => fwdChild.stdin.end(`\uFEFF${JSON.stringify({ ...payload, conversation_id: 'c-fwd' })}`), 200);
});
assert.equal(fwdResult, 0, fwdErr);
const fwdJson = JSON.parse(fwdOut);
assert.equal(fwdJson.permission, 'deny');
assert.match(fwdJson.agent_message, /offset\/limit/);
const fwdState = JSON.parse(fs.readFileSync(path.join(fwdDir, 'read-guard', 'c-fwd.json'), 'utf8'));
assert.equal(fwdState.denials[big].response.permission, 'deny');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(hookRoot, { recursive: true, force: true });

// ---------- 改写路径:Grep 补 head_limit;无意图时 Read 落回 deny ----------
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rg-rw-'));
  const big2 = path.join(tmp2, 'big2.js');
  fs.writeFileSync(big2, Array.from({ length: 800 }, (_, i) => `const m${i} = ${i};`).join('\n'));
  const dataDir2 = path.join(tmp2, 'data');
  fs.mkdirSync(dataDir2, { recursive: true });
  // 改写与 Grep 封顶都恒开:配置里不再有 readGuard 段
  fs.writeFileSync(path.join(dataDir2, 'code-index.config.json'), JSON.stringify({ readMaxLines: 500 }));
  const env2 = { ...process.env, CODE_INDEX_DATA_DIR: dataDir2 };
  for (const k of Object.keys(env2)) if (/^(QODER_|ZCODE_|CURSOR_)/.test(k)) delete env2[k];
  const zEnv = { ...env2, ZCODE_SESSION_ID: 'zs-rw' };
  const run2 = (input, e = zEnv) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input), encoding: 'utf8', env: e, windowsHide: true,
  });

  // 纯函数:选段
  let sp = pickSpan([{ s: 1, e: 50, score: 0.3 }, { s: 60, e: 120, score: 0.8 }, { s: 400, e: 500, score: 0.5 }], { maxLines: 625, topK: 3, gap: 40 });
  assert.equal(sp.s, 1, '近邻块合并');
  assert.equal(sp.e, 120);
  assert.equal(sp.topScore, 0.8);
  sp = pickSpan([{ s: 1, e: 100, score: 0.2 }, { s: 2000, e: 2100, score: 0.9 }], { maxLines: 150, topK: 2, gap: 40 });
  assert.equal(sp.s, 2000, '远块不合并,锚定最高分簇');
  assert.equal(sp.e, 2100, '簇宽 101 ≤ maxLines 不外扩');
  sp = pickSpan([{ s: 2000, e: 2400, score: 0.9 }], { maxLines: 150, topK: 2, gap: 40 });
  assert.equal(sp.s, 2000, '簇超宽从锚块起截');
  assert.equal(sp.e, 2149, '封顶到 maxLines');
  assert.equal(pickSpan([]), null);
  assert.equal(pickSpan([{ s: 1, e: 2, score: 0 }]), null, '非正分不选');

  // 纯函数:路径匹配与区间字节
  assert.ok(pathMatchesChunk('D:/a/B/c.MJS', 'B/c.mjs'));
  assert.ok(!pathMatchesChunk('D:/a/b/c.mjs', 'b/c.tsx'));
  assert.ok(bytesOfLines(big2, 800, 1, 10) > 0);
  assert.ok(bytesOfLines(big2, 800, 1, 10) < fs.statSync(big2).size);

  // 纯函数:改写输出体与回执
  const rb = rewriteBody({ file_path: 'x', offset: 1, limit: 3 }, 'ctx');
  assert.equal(rb.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(rb.hookSpecificOutput.updatedInput.limit, 3);
  assert.equal(rb.hookSpecificOutput.additionalContext, 'ctx');
  const crb = rewriteFor('cursor', { file_path: 'x', offset: 1, limit: 3 }, 'ctx');
  assert.equal(crb.permission, 'allow');
  assert.equal(crb.updated_input.limit, 3);
  assert.equal(crb.agent_message, 'ctx');
  assert.equal(crb.hookSpecificOutput, undefined, 'Cursor 改写不走 hookSpecificOutput');
  assert.match(rewriteGuidance({ file: 'f', lines: 900, size: 9000, range: { s: 1, e: 9, src: 'rerank' }, searchCmd: 'node s' }), /语义最相关区间 1-9 行\(精排选段\)/);
  assert.match(rewriteGuidance({ file: 'f', lines: 900, size: 9000, range: { s: 1, e: 9, src: 'vec' }, searchCmd: 'node s' }), /offset=1 limit=900/);

  // Grep 未带 head_limit → ZCode 补封顶;已带 → 不动
  const g1 = JSON.parse(run2({ hook_event_name: 'PreToolUse', session_id: 'g1', tool_name: 'Grep', tool_input: { pattern: 'foo', path: tmp2 }, cwd: tmp2 }).stdout);
  assert.equal(g1.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(g1.hookSpecificOutput.updatedInput.head_limit, 100);
  assert.equal(g1.hookSpecificOutput.updatedInput.pattern, 'foo', '原入参其余键保留');
  assert.match(g1.hookSpecificOutput.additionalContext, /head_limit=100/);
  assert.deepEqual(JSON.parse(run2({ hook_event_name: 'PreToolUse', session_id: 'g2', tool_name: 'Grep', tool_input: { pattern: 'foo', head_limit: 5 }, cwd: tmp2 }).stdout), {}, '已带 head_limit 放行');
  // Qoder 同走 Claude 方言且实测采纳 updatedInput → 同样补封顶
  const gq = JSON.parse(run2({ hook_event_name: 'PreToolUse', session_id: 'g4', tool_name: 'Grep', tool_input: { pattern: 'foo', path: tmp2 }, cwd: tmp2 }, { ...env2, QODER_SESSION_ID: 'q-g' }).stdout);
  assert.equal(gq.hookSpecificOutput.updatedInput.head_limit, 100);
  assert.equal(gq.hookSpecificOutput.updatedInput.pattern, 'foo');
  // 无宿主环境不改 Grep;Cursor 用 updated_input,且已带 head_limit 时放行
  assert.deepEqual(JSON.parse(run2({ hook_event_name: 'PreToolUse', session_id: 'g3', tool_name: 'Grep', tool_input: { pattern: 'foo' }, cwd: tmp2 }, env2).stdout), {}, '无宿主不改写');
  const gc = JSON.parse(run2({ hook_event_name: 'preToolUse', conversation_id: 'g5', tool_name: 'Grep', tool_input: { pattern: 'foo', path: tmp2 }, cwd: tmp2 }, { ...env2, CURSOR_AGENT: '1' }).stdout);
  assert.equal(gc.permission, 'allow');
  assert.equal(gc.updated_input.head_limit, 100);
  assert.equal(gc.updated_input.pattern, 'foo', 'Cursor 改写保留原入参');
  assert.match(gc.agent_message, /head_limit=100/);
  assert.deepEqual(JSON.parse(run2({ hook_event_name: 'preToolUse', conversation_id: 'g6', tool_name: 'Grep', tool_input: { pattern: 'foo', head_limit: 5 }, cwd: tmp2 }, { ...env2, CURSOR_AGENT: '1' }).stdout), { permission: 'allow' }, 'Cursor 已带 head_limit 放行');
  const cDeny = JSON.parse(run2({ hook_event_name: 'preToolUse', conversation_id: 'c-cur', tool_name: 'Read', tool_input: { file_path: big2 }, cwd: tmp2 }, { ...env2, CURSOR_AGENT: '1' }).stdout);
  assert.equal(cDeny.permission, 'deny', 'Cursor 选不出区间仍 deny');
  assert.match(cDeny.agent_message, /offset\/limit/);

  // 开着改写但无意图向量(chunk/模型不可用同路径)→ 落回 deny,fail-safe
  const rw = JSON.parse(run2({ hook_event_name: 'PreToolUse', session_id: 'c-rw', tool_name: 'Read', tool_input: { file_path: big2 }, cwd: tmp2 }).stdout);
  assert.equal(rw.hookSpecificOutput.permissionDecision, 'deny', '选不出区间仍 deny');
  assert.match(rw.hookSpecificOutput.permissionDecisionReason, /offset\/limit/);
  const evts = fs.readFileSync(path.join(dataDir2, 'read-guard', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(evts.every((e) => e.kind !== 'Rewrite'), '降级路径不产 Rewrite 事件');
  assert.ok(evts.some((e) => e.kind === 'Read' && e.session === 'c-rw'));

  // 改写恒开:配置里没有 rewrite 开关,ZCode/Qoder 下仍走改写分支
  // (选段依赖意图向量与索引,此处无 → 落回 deny;分支归属由 updatedInput 缺席 + deny 判定体现)
  {
    const noCfgDir = path.join(tmp2, 'data-nocfg');
    fs.mkdirSync(noCfgDir, { recursive: true });
    const noCfgEnv = { ...env2, CODE_INDEX_DATA_DIR: noCfgDir };
    const out = JSON.parse(spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'nocfg', tool_name: 'Read', tool_input: { file_path: big2 }, cwd: tmp2 }),
      encoding: 'utf8', env: noCfgEnv, windowsHide: true,
    }).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', '无配置时选不出区间仍落 deny');
    const ncEvts = fs.readFileSync(path.join(noCfgDir, 'read-guard', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(ncEvts.some((e) => e.kind === 'Read' && e.session === 'nocfg'), '无配置也走拦截路径并记账');
  }

  // Bash 拒绝文案带可照抄的具体命令(不再是占位符)
  assert.match(bashOversizeGuidance({ files: ['D:/a/b.js'], lines: 900, size: 9000, readMaxLines: 500, searchCmd: 'node s' }), /sed -n '1,500p' D:\/a\/b\.js/);
  assert.match(bashOversizeGuidance({ files: ['D:/a/b.js', 'D:/a/c.js'], lines: 900, size: 9000, readMaxLines: 500, searchCmd: 'node s' }), /多文件请逐个/);

  // 改写预置标记:写进 read-nudge 状态文件,已有内容合并不覆盖
  {
    const st = path.join(dataDir2, 'read-guard', 'sess_mk.reads.json');
    fs.mkdirSync(path.dirname(st), { recursive: true });
    fs.writeFileSync(st, JSON.stringify({ reads: { 'D:/keep.ts': { ranges: 1, bytes: 10, lastAt: 1, nudgedAt: 0 } } }));
    assert.equal(markHookRewrite('sess_mk', 'D:/a/b.js', 123, st), true);
    const j = JSON.parse(fs.readFileSync(st, 'utf8'));
    assert.equal(j.hookRewrites['D:/a/b.js'], 123);
    assert.equal(j.reads['D:/keep.ts'].ranges, 1, '已有 reads 状态保留');
    markHookRewrite('sess_mk', 'D:/a/b.js', 456, st); // 幂等覆盖同文件标记
    assert.equal(JSON.parse(fs.readFileSync(st, 'utf8')).hookRewrites['D:/a/b.js'], 456);
  }

  // Qoder 转发器:改写体(updatedInput)必须透传,不能被当成"无 permissionDecision"吞掉
  {
    const qHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rg-qh-'));
    rewriteQoderUserHooks({ home: qHome });
    const qFwd = path.join(qHome, '.qoder-cn', 'hooks', 'read-guard.mjs');
    const qRun = (payload) => spawnSync(process.execPath, [qFwd], {
      input: JSON.stringify(payload), encoding: 'utf8', env: { ...env2, QODER_SESSION_ID: 'q-fwd' }, windowsHide: true,
    });
    const qOut = JSON.parse(qRun({ hook_event_name: 'PreToolUse', session_id: 'q-fwd', tool_name: 'Grep', tool_input: { pattern: 'foo' }, cwd: tmp2 }).stdout);
    assert.equal(qOut.hookSpecificOutput.updatedInput.head_limit, 100, 'Qoder 转发器透传改写体');
    fs.writeFileSync(path.join(tmp2, 'small.js'), 'const a = 1;\n');
    assert.deepEqual(JSON.parse(qRun({ hook_event_name: 'PreToolUse', session_id: 'q-allow', tool_name: 'Read', tool_input: { file_path: path.join(tmp2, 'small.js') }, cwd: tmp2 }).stdout), {}, '放行时输出 {}');
    fs.rmSync(qHome, { recursive: true, force: true });
  }

  fs.rmSync(tmp2, { recursive: true, force: true });
}

console.log('ok');
