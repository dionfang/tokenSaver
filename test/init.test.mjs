#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseInitArgs, isCodeIndexHookRef, gitignoreEntries, detectAgent, resolveHookTargets, rewriteCursorHooks, rewriteQoderHooks, rewriteZcodeHooks, splitRoots, mergeRoots, healRoots, rollKnownAnnotations } from '../code-index/init.mjs';

assert.equal(parseInitArgs([]).modelIn, null);
assert.equal(parseInitArgs(['--model-in', 'local']).modelIn, 'local');
assert.equal(parseInitArgs(['--model-in', 'ollama']).modelIn, 'ollama');
assert.equal(parseInitArgs(['--model-in=ollama']).modelIn, 'ollama');
assert.equal(parseInitArgs(['--roots', 'D:/a']).roots, 'D:/a');
assert.deepEqual(splitRoots('D:/a, D:/b'), ['D:/a', 'D:/b']);
assert.deepEqual(mergeRoots(['D:/a'], ['D:/a', 'D:/b']), mergeRoots(['D:/a'], ['D:/b']));
assert.equal(mergeRoots(['D:/a'], ['D:/b']).length, 2);

assert.deepEqual(rollKnownAnnotations({ 'p/a.ts': '注解' }, true), {});
assert.deepEqual(rollKnownAnnotations({ 'p/a.ts': '注解' }, false), { 'p/a.ts': '注解' });
assert.deepEqual(rollKnownAnnotations(undefined, false), {});
assert.deepEqual(rollKnownAnnotations('坏数据', true), {});
{
  const exists = (p) => String(p).replace(/\\/g, '/') === 'D:/keep';
  assert.deepEqual(healRoots(['D:/keep', 'D:/gone'], { exists, siblingOf: 'D:/sib' }), ['D:/keep']);
  const healed = healRoots(['D:/missing/proj'], {
    exists: (p) => String(p).replace(/\\/g, '/').endsWith('/sib/proj'),
    siblingOf: 'D:/sib',
  });
  assert.equal(healed.length, 1);
  assert.match(healed[0].replace(/\\/g, '/'), /sib\/proj$/);
}
assert.equal(parseInitArgs(['--hooks', 'cursor']).hooks, 'cursor');
assert.equal(parseInitArgs(['--hooks=all']).hooks, 'all');
assert.ok(parseInitArgs(['--model-in', 'gpu']).error);
assert.ok(parseInitArgs(['--unknown']).error);
assert.ok(parseInitArgs(['--roots']).error);
assert.ok(parseInitArgs(['--hooks', 'claude']).error);

assert.equal(detectAgent({ CURSOR_AGENT: '1' }), 'cursor');
assert.equal(detectAgent({ QODER_PROJECT_DIR: 'D:/p', CLAUDE_PROJECT_DIR: 'D:/p' }), 'qoder');
assert.equal(detectAgent({ ZCODE_SESSION_ID: 'x' }), 'zcode');
assert.equal(detectAgent({ VSCODE_CWD: 'C:\\Program Files\\cursor' }), 'cursor');
assert.equal(detectAgent({}), null);
assert.deepEqual(resolveHookTargets('cursor', {}), ['cursor']);
assert.deepEqual(resolveHookTargets('all', { CURSOR_AGENT: '1' }), ['cursor', 'zcode', 'qoder']);
assert.deepEqual(resolveHookTargets(null, { CURSOR_AGENT: '1' }), ['cursor']);
assert.deepEqual(resolveHookTargets(null, {}), ['cursor', 'zcode', 'qoder']);

assert.equal(isCodeIndexHookRef('scripts/code-index/auto.mjs'), true);
assert.equal(isCodeIndexHookRef('node_modules/@dionfang/tokensaver/warm.mjs'), true);
assert.equal(isCodeIndexHookRef('.cursor/hooks/warm-code-index.mjs'), true);
assert.equal(isCodeIndexHookRef('.cursor/hooks/prompt-guard.mjs'), true);
assert.equal(isCodeIndexHookRef('.cursor/hooks/read-guard.mjs'), true);
assert.equal(isCodeIndexHookRef('.qoder/hooks/session-start.mjs'), true);
assert.equal(isCodeIndexHookRef('.qoder/hooks/read-guard.mjs'), true);
assert.equal(isCodeIndexHookRef('node .qoder/hooks/session-start.mjs'), true);
assert.equal(isCodeIndexHookRef('node .qoder/hooks/commit-refresh.mjs'), true);
assert.equal(isCodeIndexHookRef('src/utils/auto.mjs'), false);

const copiedGi = gitignoreEntries({
  packed: false,
  repoRoot: path.join('D:', 'proj'),
  moduleDir: path.join('D:', 'proj', 'scripts', 'code-index'),
  dataDir: path.join('D:', 'proj', 'scripts', 'data'),
});
assert.deepEqual(copiedGi, ['/.zcode/', '/.cursor/', '/.qoder/', '/scripts/data/', '/scripts/code-index/']);

const hubGi = gitignoreEntries({
  packed: false,
  repoRoot: path.join('D:', 'TokenSaver'),
  moduleDir: path.join('D:', 'TokenSaver', 'code-index'),
  dataDir: path.join('D:', 'TokenSaver', 'data'),
});
assert.deepEqual(hubGi, ['/.zcode/', '/.cursor/', '/.qoder/', '/data/']);

const packedGi = gitignoreEntries({
  packed: true,
  repoRoot: path.join('D:', 'proj'),
  moduleDir: path.join('D:', 'proj', 'node_modules', '@dionfang', 'tokensaver'),
  dataDir: path.join('D:', 'proj', 'scripts', 'data'),
});
assert.deepEqual(packedGi, ['/.zcode/', '/.cursor/', '/.qoder/', '/scripts/data/']);

const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-hooks-'));
rewriteCursorHooks(hookDir);
const cursorCfg = JSON.parse(fs.readFileSync(path.join(hookDir, '.cursor', 'hooks.json'), 'utf8'));
assert.equal(cursorCfg.hooks.sessionStart[0].command, 'node .cursor/hooks/warm-code-index.mjs');
assert.equal(cursorCfg.hooks.beforeSubmitPrompt[0].command, 'node .cursor/hooks/prompt-guard.mjs');
assert.equal(cursorCfg.hooks.preToolUse[0].command, 'node .cursor/hooks/read-guard.mjs');
assert.equal(cursorCfg.hooks.preToolUse[0].matcher, '^Read$');
assert.equal(cursorCfg.hooks.afterAgentResponse, undefined, '不再安装输出端 tokens 统计钩子');
assert.ok(fs.existsSync(path.join(hookDir, '.cursor', 'hooks', 'warm-code-index.mjs')));
assert.ok(fs.existsSync(path.join(hookDir, '.cursor', 'hooks', 'read-guard.mjs')));
fs.writeFileSync(path.join(hookDir, '.cursor', 'hooks', 'output-savings.mjs'), 'stale\n');
cursorCfg.hooks.afterAgentResponse = [{ command: 'node .cursor/hooks/output-savings.mjs', timeout: 20 }];
fs.writeFileSync(path.join(hookDir, '.cursor', 'hooks.json'), JSON.stringify(cursorCfg, null, 2) + '\n');
rewriteCursorHooks(hookDir);
const cursorCfg2 = JSON.parse(fs.readFileSync(path.join(hookDir, '.cursor', 'hooks.json'), 'utf8'));
assert.equal(cursorCfg2.hooks.preToolUse.filter((h) => String(h.command || '').includes('read-guard')).length, 1);
assert.equal(cursorCfg2.hooks.afterAgentResponse, undefined);
assert.equal(fs.existsSync(path.join(hookDir, '.cursor', 'hooks', 'output-savings.mjs')), false);
rewriteQoderHooks(hookDir);
const qoderCfg = JSON.parse(fs.readFileSync(path.join(hookDir, '.qoder', 'settings.json'), 'utf8'));
assert.equal(qoderCfg.hooks.SessionStart[0].hooks[0].command, 'node .qoder/hooks/session-start.mjs');
assert.equal(qoderCfg.hooks.PreToolUse[0].matcher, '^Read$');
assert.equal(qoderCfg.hooks.PreToolUse[0].hooks[0].command, 'node .qoder/hooks/read-guard.mjs');
assert.ok(fs.existsSync(path.join(hookDir, '.qoder', 'hooks', 'read-guard.mjs')));
qoderCfg.hooks.Stop = [{ hooks: [{ type: 'command', command: 'node .qoder/hooks/output-savings.mjs', timeout: 10 }] }];
fs.writeFileSync(path.join(hookDir, '.qoder', 'settings.json'), JSON.stringify(qoderCfg, null, 2) + '\n');
fs.writeFileSync(path.join(hookDir, '.qoder', 'hooks', 'output-savings.mjs'), 'stale\n');
rewriteQoderHooks(hookDir);
const qoderCfg2 = JSON.parse(fs.readFileSync(path.join(hookDir, '.qoder', 'settings.json'), 'utf8'));
assert.equal(qoderCfg2.hooks.PreToolUse.filter((g) => (g.hooks || []).some((h) => String(h.command || '').includes('read-guard'))).length, 1);
assert.equal(qoderCfg2.hooks.SessionStart.length, 1);
assert.equal(qoderCfg2.hooks.PostToolUse.length, 1);
assert.equal(qoderCfg2.hooks.UserPromptSubmit.length, 1);
assert.equal(qoderCfg2.hooks.PreToolUse.length, 1);
assert.equal(qoderCfg2.hooks.Stop, undefined);
assert.equal(fs.existsSync(path.join(hookDir, '.qoder', 'hooks', 'output-savings.mjs')), false);
rewriteZcodeHooks(hookDir);
const zcodeCfg = JSON.parse(fs.readFileSync(path.join(hookDir, '.zcode', 'config.json'), 'utf8'));
assert.equal(zcodeCfg.hooks.events.PreToolUse[0].matcher, '^Read$');
assert.ok(zcodeCfg.hooks.events.PreToolUse[0].hooks[0].args.some((a) => String(a).replace(/\\/g, '/').endsWith('/read-guard.mjs')));
rewriteZcodeHooks(hookDir);
const zcodeCfg2 = JSON.parse(fs.readFileSync(path.join(hookDir, '.zcode', 'config.json'), 'utf8'));
assert.equal(zcodeCfg2.hooks.events.PreToolUse.length, 1);
fs.rmSync(hookDir, { recursive: true, force: true });

console.log('ok');
