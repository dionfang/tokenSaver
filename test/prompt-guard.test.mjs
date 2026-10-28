#!/usr/bin/env node
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
