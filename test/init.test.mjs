#!/usr/bin/env node
/** init 纯函数测试:参数解析、钩子接线(Cursor/Qoder/ZCode 用户级+工作区清理)、roots 合并自愈、knownAnnotations 重置。启动:cd code-index && npm test(或 node ../test/init.test.mjs) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseInitArgs, isCodeIndexHookRef, gitignoreEntries, detectAgent, resolveHookTargets, cleanCursorWorkspaceHooks, cleanQoderWorkspaceHooks, cleanZcodeWorkspaceHooks, rewriteCursorUserHooks, rewriteQoderUserHooks, rewriteZcodeUserHooks, qoderUserDir, splitRoots, mergeRoots, healRoots, rollKnownAnnotations } from '../code-index/init.mjs';

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
assert.equal(isCodeIndexHookRef('.qoder-cn/hooks/session-start.mjs'), true, 'Qoder CN 用户级目录');
assert.equal(isCodeIndexHookRef('node C:/Users/x/.qoder-cn/hooks/prompt-guard.mjs'), true);
assert.equal(isCodeIndexHookRef('.zcode/hooks/session-start.mjs'), true);
assert.equal(isCodeIndexHookRef('.zcode/hooks/read-guard.mjs'), true);
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

// ===== 工作区钩子清理:只删本模块的条目与转发器,他人钩子保留 =====
const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-hooks-'));

// Cursor:种入本模块钩子 + 一个他人钩子,清理后只应剩下他人的
fs.mkdirSync(path.join(hookDir, '.cursor', 'hooks'), { recursive: true });
for (const f of ['warm-code-index.mjs', 'prompt-guard.mjs', 'read-guard.mjs', 'output-savings.mjs']) {
  fs.writeFileSync(path.join(hookDir, '.cursor', 'hooks', f), 'stale\n');
}
fs.writeFileSync(path.join(hookDir, '.cursor', 'hooks.json'), JSON.stringify({
  version: 1,
  hooks: {
    sessionStart: [
      { command: 'node .cursor/hooks/warm-code-index.mjs', timeout: 600 },
      { command: 'node other-tool/notify.mjs', timeout: 5 },
    ],
    beforeSubmitPrompt: [{ command: 'node .cursor/hooks/prompt-guard.mjs', timeout: 10 }],
    preToolUse: [{ command: 'node .cursor/hooks/read-guard.mjs', matcher: '^Read$', timeout: 10 }],
  },
}, null, 2));
cleanCursorWorkspaceHooks(hookDir);
const cursorAfter = JSON.parse(fs.readFileSync(path.join(hookDir, '.cursor', 'hooks.json'), 'utf8'));
assert.deepEqual(cursorAfter.hooks.sessionStart.map(h => h.command), ['node other-tool/notify.mjs'], '他人钩子保留');
assert.equal(cursorAfter.hooks.beforeSubmitPrompt, undefined);
assert.equal(cursorAfter.hooks.preToolUse, undefined);
assert.equal(fs.existsSync(path.join(hookDir, '.cursor', 'hooks')), false, '本模块转发器应删光,目录回收');

// 空壳场景:清理后只剩骨架 → 连配置文件和空目录一起删
const skel = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-skel-'));
fs.mkdirSync(path.join(skel, '.cursor', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(skel, '.cursor', 'hooks', 'read-guard.mjs'), 'stale\n');
fs.writeFileSync(path.join(skel, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'node .cursor/hooks/read-guard.mjs', matcher: '^Read$', timeout: 10 }] } }));
cleanCursorWorkspaceHooks(skel);
assert.equal(fs.existsSync(path.join(skel, '.cursor')), false, 'Cursor 空壳:整个 .cursor 目录回收');

fs.mkdirSync(path.join(skel, '.zcode', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(skel, '.zcode', 'config.json'), JSON.stringify({ hooks: { enabled: true, events: { PreToolUse: [{ matcher: '^Read$|^Bash$', hooks: [{ type: 'process', command: 'node', args: ['D:/x/.zcode/hooks/read-guard.mjs'], timeoutMs: 1000 }] }] } } }));
cleanZcodeWorkspaceHooks(skel);
assert.equal(fs.existsSync(path.join(skel, '.zcode')), false, 'ZCode 空壳:整个 .zcode 目录回收');

fs.mkdirSync(path.join(skel, '.qoder'), { recursive: true });
fs.writeFileSync(path.join(skel, '.qoder', 'settings.json'), JSON.stringify({ hooks: {} }));
cleanQoderWorkspaceHooks(skel);
assert.equal(fs.existsSync(path.join(skel, '.qoder')), false, 'Qoder 空壳:整个 .qoder 目录回收');

// 带他人键的文件不能整删:只清钩子条目
const mixed = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-mixed-'));
fs.mkdirSync(path.join(mixed, '.zcode'), { recursive: true });
fs.writeFileSync(path.join(mixed, '.zcode', 'config.json'), JSON.stringify({ mcpServers: { x: { command: 'y' } }, hooks: { enabled: true, events: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'process', command: 'node', args: ['D:/x/.zcode/hooks/read-guard.mjs'], timeoutMs: 1000 }] }] } } }));
cleanZcodeWorkspaceHooks(mixed);
assert.equal(fs.existsSync(path.join(mixed, '.zcode', 'config.json')), true, '有他人配置时文件保留');
const mixedAfter = JSON.parse(fs.readFileSync(path.join(mixed, '.zcode', 'config.json'), 'utf8'));
assert.deepEqual(mixedAfter.mcpServers, { x: { command: 'y' } });
assert.equal(mixedAfter.hooks.events.PreToolUse, undefined);
fs.rmSync(skel, { recursive: true, force: true });
fs.rmSync(mixed, { recursive: true, force: true });

// Qoder
fs.mkdirSync(path.join(hookDir, '.qoder', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(hookDir, '.qoder', 'hooks', 'read-guard.mjs'), 'stale\n');
fs.writeFileSync(path.join(hookDir, '.qoder', 'settings.json'), JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node .qoder/hooks/session-start.mjs', timeout: 420 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node other/stop.mjs', timeout: 5 }] }],
  },
}, null, 2));
cleanQoderWorkspaceHooks(hookDir);
const qoderAfter = JSON.parse(fs.readFileSync(path.join(hookDir, '.qoder', 'settings.json'), 'utf8'));
assert.equal(qoderAfter.hooks.SessionStart, undefined);
assert.equal(qoderAfter.hooks.Stop[0].hooks[0].command, 'node other/stop.mjs', '他人钩子保留');
assert.equal(fs.existsSync(path.join(hookDir, '.qoder', 'hooks', 'read-guard.mjs')), false);

// ZCode
fs.mkdirSync(path.join(hookDir, '.zcode', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(hookDir, '.zcode', 'hooks', 'session-start.mjs'), 'stale\n');
fs.writeFileSync(path.join(hookDir, '.zcode', 'config.json'), JSON.stringify({
  other: { keep: true },
  hooks: {
    enabled: true,
    events: {
      SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'process', command: 'node', args: ['D:/x/.zcode/hooks/session-start.mjs'], timeoutMs: 1000 }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['D:/other/refresh.mjs'], timeoutMs: 1000 }] }],
    },
  },
}, null, 2));
cleanZcodeWorkspaceHooks(hookDir);
const zcodeAfter = JSON.parse(fs.readFileSync(path.join(hookDir, '.zcode', 'config.json'), 'utf8'));
assert.equal(zcodeAfter.other.keep, true, '非 hooks 键保留');
assert.equal(zcodeAfter.hooks.events.SessionStart, undefined);
assert.equal(zcodeAfter.hooks.events.PostToolUse.length, 1, '他人钩子保留');
assert.equal(fs.existsSync(path.join(hookDir, '.zcode', 'hooks', 'session-start.mjs')), false);

// ===== 用户级接线:绝对路径直指 hub,他人配置保留,幂等 =====
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-home-'));
fs.mkdirSync(path.join(fakeHome, '.zcode', 'cli'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.zcode', 'cli', 'config.json'), JSON.stringify({ plugins: { somePlugin: true }, hooks: { enabled: false, events: {} } }, null, 2));
fs.mkdirSync(path.join(fakeHome, '.qoder-cn'), { recursive: true });

rewriteZcodeUserHooks({ home: fakeHome });
const userZcode = JSON.parse(fs.readFileSync(path.join(fakeHome, '.zcode', 'cli', 'config.json'), 'utf8'));
assert.deepEqual(userZcode.plugins, { somePlugin: true }, '用户级其他键保留');
assert.equal(userZcode.hooks.enabled, true);
assert.equal(userZcode.hooks.events.PreToolUse[0].matcher, '^Read$|^Bash$');
const zcArg = userZcode.hooks.events.PreToolUse[0].hooks[0].args[0].replace(/\\/g, '/');
assert.match(zcArg, /code-index\/read-guard\.mjs$/, '绝对路径直指 hub 脚本');
assert.ok(path.isAbsolute(zcArg));
assert.equal(userZcode.hooks.events.PostToolUse.length, 2, 'PostToolUse:commit-refresh + read-nudge');
assert.equal(userZcode.hooks.events.PostToolUse[1].matcher, '^Read$|^Bash$');
assert.ok(userZcode.hooks.events.PostToolUse[1].hooks[0].args[0].replace(/\\/g, '/').endsWith('code-index/read-nudge.mjs'));
assert.equal(userZcode.hooks.events.PostToolUseFailure[0].matcher, '^Read$|^Bash$', '失败导航已接线');
assert.ok(userZcode.hooks.events.PostToolUseFailure[0].hooks[0].args[0].replace(/\\/g, '/').endsWith('code-index/read-nudge.mjs'));
assert.equal(userZcode.hooks.events.UserPromptSubmit[0].hooks[0].statusMessage.includes('语义预取'), true);
rewriteZcodeUserHooks({ home: fakeHome });
const userZcode2 = JSON.parse(fs.readFileSync(path.join(fakeHome, '.zcode', 'cli', 'config.json'), 'utf8'));
assert.equal(userZcode2.hooks.events.PreToolUse.length, 1, '幂等:不重复累积');
assert.equal(userZcode2.hooks.events.PostToolUse.length, 2, '幂等:PostToolUse 两组不累积');

rewriteCursorUserHooks({ home: fakeHome });
const userCursor = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'hooks.json'), 'utf8'));
assert.equal(userCursor.hooks.preToolUse[0].matcher, 'Read', 'matcher 只能是字面工具名,正则会被 Cursor 整组跳过');
assert.ok(userCursor.hooks.preToolUse[0].command.startsWith('node '), 'Cursor preToolUse 用转发器命令');
const userCursorFwd = userCursor.hooks.preToolUse[0].command.replace(/^node /, '');
assert.ok(fs.existsSync(userCursorFwd), 'Cursor 转发器真实存在');
rewriteCursorUserHooks({ home: fakeHome });
const userCursor2 = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'hooks.json'), 'utf8'));
assert.equal(userCursor2.hooks.preToolUse.length, 1, '幂等');

rewriteQoderUserHooks({ home: fakeHome });
assert.equal(qoderUserDir(fakeHome), path.join(fakeHome, '.qoder-cn'), 'CN 目录优先');
const userQoder = JSON.parse(fs.readFileSync(path.join(fakeHome, '.qoder-cn', 'settings.json'), 'utf8'));
assert.equal(userQoder.hooks.PreToolUse[0].matcher, '^Read$|^Bash$');
const qCmd = userQoder.hooks.PreToolUse[0].hooks[0].command.replace(/^node /, '');
assert.ok(fs.existsSync(qCmd), 'Qoder 用户级转发器真实存在');
rewriteQoderUserHooks({ home: fakeHome });
const userQoder2 = JSON.parse(fs.readFileSync(path.join(fakeHome, '.qoder-cn', 'settings.json'), 'utf8'));
assert.equal(userQoder2.hooks.PreToolUse.length, 1, '幂等');

// 用户级是国际化版目录时择 ~/.qoder
const intlHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-home2-'));
fs.mkdirSync(path.join(intlHome, '.qoder'), { recursive: true });
assert.equal(qoderUserDir(intlHome), path.join(intlHome, '.qoder'), '已有 ~/.qoder 时用国际版目录');

fs.rmSync(hookDir, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
fs.rmSync(intlHome, { recursive: true, force: true });

console.log('ok');
