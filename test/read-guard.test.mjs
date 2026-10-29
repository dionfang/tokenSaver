#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectDialect, evaluateReadGuard, formatDecision, oversizeGuidance, OVERRIDE_WINDOW_MS, tokensFromBlockedBytes } from '../code-index/read-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(here, '..', 'code-index', 'read-guard.mjs');
assert.equal(detectDialect({ hook_event_name: 'PreToolUse' }), 'claude');
assert.equal(detectDialect({ hook_event_name: 'preToolUse' }), 'cursor');
assert.equal(detectDialect({}, { ZCODE_SESSION_ID: 's' }), 'claude');
assert.equal(detectDialect({}, { QODER_PROJECT_DIR: 'D:/p' }), 'claude');
assert.equal(detectDialect({}, { CURSOR_AGENT: '1' }), 'cursor');
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-rg-'));
const big = path.join(tmp, 'big.js');
fs.writeFileSync(big, Array.from({ length: 800 }, (_, i) => `const n${i} = ${i};`).join('\n'));
const dataDir = path.join(tmp, 'data');
const env = { ...process.env, CODE_INDEX_DATA_DIR: dataDir };
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
assert.equal(JSON.parse(first.stdout).permission, 'deny');
assert.match(JSON.parse(first.stdout).agent_message, /offset\/limit/);
const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'session-savings.json'), 'utf8'));
const day = Object.values(ledger.days)[0];
assert.equal(day.originalTokens, blockedTokens);
assert.equal(day.compressedTokens, 0);
assert.equal(day.savedTokens, blockedTokens);

const second = runHook(payload);
assert.equal(JSON.parse(second.stdout).permission, 'allow');
const ledgerAfterAllow = JSON.parse(fs.readFileSync(path.join(dataDir, 'session-savings.json'), 'utf8'));
assert.equal(Object.values(ledgerAfterAllow.days)[0].savedTokens, blockedTokens);

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

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok');
