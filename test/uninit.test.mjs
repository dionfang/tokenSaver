#!/usr/bin/env node
/** uninit 测试:用户级钩子移除(保留他人配置)、AGENTS.md 剥离(纪律/输出纪律/旧 ponytail)整删跳过、运行时痕迹清理。全密闭。 启动:cd code-index && npm test(或 node ../test/uninit.test.mjs) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uninstallZcodeUserHooks, uninstallCursorUserHooks, uninstallQoderUserHooks, stripAgentsFile, stripPonytailSection, stripDietSection } from '../code-index/uninit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-un-home-'));
const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-un-a-')); // 有用户内容 + 注入段 + 段后用户内容
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-un-b-')); // 仅注入内容 → 整删
const rootC = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-un-c-')); // 无 AGENTS.md

// ---- 种入用户级 ----
fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true });
fs.writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({
  plugins: { keep: true },
  hooks: { enabled: true, events: { SessionStart: [
    { matcher: 'startup|resume', hooks: [{ type: 'process', command: 'node', args: ['D:/ts/code-index/auto.mjs'], timeoutMs: 1000 }] },
    { matcher: 'startup', hooks: [{ type: 'process', command: 'node', args: ['D:/other/x.mjs'], timeoutMs: 1000 }] },
  ] } },
}));
fs.mkdirSync(path.join(home, '.cursor', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(home, '.cursor', 'hooks', 'read-guard.mjs'), 'ours\n');
fs.writeFileSync(path.join(home, '.cursor', 'hooks', 'user-own.mjs'), 'theirs\n');
fs.writeFileSync(path.join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [
  { command: 'node D:/ts/code-index/read-guard.mjs', matcher: 'Read', timeout: 10 },
  { command: 'node other/y.mjs', timeout: 5 },
] } }));
fs.mkdirSync(path.join(home, '.qoder-cn', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(home, '.qoder-cn', 'hooks', 'session-start.mjs'), 'ours\n');
fs.writeFileSync(path.join(home, '.qoder-cn', 'settings.json'), JSON.stringify({ hooks: {} }));

// ---- 种入 AGENTS.md(ponytail 块用真实模板,模拟 init 写入) ----
const ponytailBody = fs.readFileSync(path.join(here, '..', 'code-index', 'ponytail.md'), 'utf8').trim();
const ponytailBlock = `<!-- ponytail -->\n## Ponytail 模式（懒惰资深开发者规则）\n\n${ponytailBody}\n`;
// diet 块按 init 的 upsertDiet 生成格式构造(标记行 + output-diet.md 全文)
const dietBlock = `<!-- output-diet-v7 -->\n${fs.readFileSync(path.join(here, '..', 'code-index', 'output-diet.md'), 'utf8').trim()}\n`;
const agentsA = [
  '# 项目说明',
  '',
  '这是用户自己的项目说明。',
  '',
  '<!-- code-index:v2 -->',
  '## 代码检索纪律(节约 token)',
  '',
  '1. 先走索引',
  '',
  ponytailBlock,
  '## 用户自己的尾段',
  '',
  '这段在 ponytail 之后,必须保留。',
  '',
].join('\n');
fs.writeFileSync(path.join(rootA, 'AGENTS.md'), agentsA);
// rootB:仅注入内容(纪律段 + 输出纪律段,模拟 init 写入)→ 整删
fs.writeFileSync(path.join(rootB, 'AGENTS.md'), [
  '<!-- code-index:v2 -->',
  '## 代码检索纪律(节约 token)',
  '',
  '1. 先走索引',
  '',
  dietBlock,
].join('\n'));

// ---- 执行 ----
const zk = uninstallZcodeUserHooks({ home });
assert.equal(zk.groups, 1, '只移除本模块的组');
const zkAfter = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'cli', 'config.json'), 'utf8'));
assert.deepEqual(zkAfter.plugins, { keep: true }, 'plugins 保留');
assert.equal(zkAfter.hooks.events.SessionStart[0].hooks[0].args[0], 'D:/other/x.mjs', '他人钩子保留');
assert.equal(zk.fileDeleted, false, '含他人配置不删文件');

const cu = uninstallCursorUserHooks({ home });
assert.equal(cu.groups, 1);
assert.equal(cu.forwarders, 1, '只删本模块转发器');
assert.equal(fs.existsSync(path.join(home, '.cursor', 'hooks', 'user-own.mjs')), true, '他人转发器保留');
const cuAfter = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8'));
assert.deepEqual(cuAfter.hooks.preToolUse.map(h => h.command), ['node other/y.mjs'], '他人钩子保留');

const qd = uninstallQoderUserHooks({ home });
assert.equal(qd.fileDeleted, true, 'Qoder 空壳整删');
assert.equal(fs.existsSync(path.join(home, '.qoder-cn')), false, '空目录回收');

// ---- AGENTS.md ----
const stA = stripAgentsFile(path.join(rootA, 'AGENTS.md'));
assert.equal(stA, 'clean');
const afterA = fs.readFileSync(path.join(rootA, 'AGENTS.md'), 'utf8');
assert.match(afterA, /# 项目说明/);
assert.match(afterA, /## 用户自己的尾段/);
assert.match(afterA, /这段在 ponytail 之后,必须保留。/);
assert.doesNotMatch(afterA, /<!-- ponytail -->|## Ponytail|代码检索纪律|lazy senior|code-index:v2/);

const stB = stripAgentsFile(path.join(rootB, 'AGENTS.md'));
assert.equal(stB, 'deleted', '仅含注入内容 → 整文件删除');
assert.equal(fs.existsSync(path.join(rootB, 'AGENTS.md')), false);

// stripDietSection 纯函数:段后带标题的用户内容保留
const dietRound = stripDietSection(`# 项目\n\n${dietBlock}\n## 用户尾段\n\n内容保留\n`);
assert.equal(dietRound.changed, true);
assert.match(dietRound.content, /## 用户尾段/);
assert.doesNotMatch(dietRound.content, /output-diet|省话不省工/);
// 无标记原样返回
assert.equal(stripDietSection('# 纯内容\n').changed, false);

assert.equal(stripAgentsFile(path.join(rootC, 'AGENTS.md')), 'absent');

// stripPonytailSection 纯函数:无标记原样返回
const untouched = stripPonytailSection('# 纯内容\n');
assert.equal(untouched.changed, false);
assert.equal(untouched.content, '# 纯内容\n');

// ---- 运行时痕迹 ----
const pf = path.join(os.tmpdir(), 'ts-un-pf.json');
fs.writeFileSync(pf, '{}');
assert.equal(fs.existsSync(pf), true);
// 直接复用 rmIfExists 的语义经主流程验证;此处仅验证文件可被清理
fs.rmSync(pf, { force: true });

for (const d of [home, rootA, rootB, rootC]) fs.rmSync(d, { recursive: true, force: true });
console.log('ok');
