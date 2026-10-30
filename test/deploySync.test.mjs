#!/usr/bin/env node
/** 部署产物一致性门禁测试:比较逻辑自检(增/删/改/换序/ponytail 残留)+ 本仓 AGENTS.md 与模板一致。全密闭。 启动:cd code-index && npm test(或 node ../test/deploySync.test.mjs) */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const run = (args) => spawnSync(node, args, { encoding: 'utf8' });

const st = run([path.join(here, '..', 'code-index', 'deploySync.mjs'), '--selftest']);
assert.equal(st.status, 0, `selftest 失败:\n${st.stdout}\n${st.stderr}`);
assert.match(st.stdout, /\[selftest\] deploySync ok/);

// 本仓 AGENTS.md 必须与当前代码库模板一致(规则 10:改模板后必须重新 init 全盘部署)
const real = run([path.join(here, '..', 'code-index', 'deploySync.mjs')]);
assert.equal(real.status, 0,
  `本仓 AGENTS.md 与模板不一致(运行 node code-index/init.mjs 全盘部署后重试):\n${real.stdout}${real.stderr}`);
console.log('ok');