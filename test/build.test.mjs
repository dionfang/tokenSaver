#!/usr/bin/env node
/** build 纯函数测试:hub 目录识别(isHubDir)。启动:cd code-index && npm test(或 node ../test/build.test.mjs) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isHubDir } from '../code-index/build.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-hub-'));
const host = path.join(tmp, 'host');
fs.mkdirSync(path.join(host, '.git'), { recursive: true });
fs.mkdirSync(path.join(host, 'code-index'), { recursive: true });
fs.mkdirSync(path.join(host, 'scripts', 'code-index'), { recursive: true });

assert.equal(isHubDir(path.join(host, 'code-index')), true);
assert.equal(isHubDir(path.join(host, 'scripts', 'code-index')), false);
assert.equal(isHubDir(path.join(tmp, 'loose', 'code-index')), false);
console.log('ok');
