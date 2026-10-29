#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rewriteCursorHooks } from '../code-index/init.mjs';
import { bashOversizeGuidance, catDumpPieces, detectAgentType, detectDialect, evaluateBashGuard, evaluateReadGuard, formatDecision, oversizeGuidance, OVERRIDE_WINDOW_MS, tokensFromBlockedBytes } from '../code-index/read-guard.mjs';

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
assert.equal(Object.values(ledgerAfterAllow.days)[0].savedTokens, blockedTokens);

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
rewriteCursorHooks(hookRoot);
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
console.log('ok');
