#!/usr/bin/env node
/** prompt-guard 进程测试:spawn 中心脚本验 stdout 契约。启动:cd code-index && npm test(或 node ../test/prompt-guard.test.mjs) */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'code-index', 'prompt-guard.mjs');
const t0 = Date.now();
const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
let out = '';
child.stdout.on('data', (d) => { out += d; });
const code = await new Promise((resolve) => child.on('exit', resolve));
const ms = Date.now() - t0;
assert.equal(code, 0);
assert.equal(out.trim(), '{}');
assert.ok(ms < 2000, `钩子应立即退出,实际 ${ms}ms`);

// 有 prompt 时输出必须是 JSON 对象:命中则 {additionalContext:string},未命中则 {}
const child2 = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
let out2 = '';
child2.stdout.on('data', (d) => { out2 += d; });
child2.stdin.write(JSON.stringify({ prompt: 'read-guard 拦截阈值测试 ' + Date.now() }));
child2.stdin.end();
const code2 = await new Promise((resolve) => child2.on('exit', resolve));
assert.equal(code2, 0);
const parsed = JSON.parse(out2.trim());
assert.equal(typeof parsed, 'object', `输出必须是 JSON 对象,实际: ${out2.trim().slice(0, 120)}`);
if (parsed.additionalContext != null) assert.equal(typeof parsed.additionalContext, 'string');
