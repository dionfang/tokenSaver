#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { isInsideNodeModules, resolveLayout } from './config.mjs';

assert.equal(isInsideNodeModules(path.join('D:', 'proj', 'scripts', 'code-index')), false);
assert.equal(isInsideNodeModules(path.join('D:', 'proj', 'node_modules', '@dionfang', 'tokensaver')), true);

const copied = resolveLayout({
  moduleDir: path.join('D:', 'proj', 'scripts', 'code-index'),
  cwd: path.join('D:', 'proj'),
  env: {},
  homedir: path.join('C:', 'Users', 'me'),
  gitRoot: path.join('D:', 'proj'),
});
assert.equal(copied.packed, false);
assert.equal(copied.dataDir, path.resolve(path.join('D:', 'proj', 'scripts', 'data')));
assert.equal(copied.hfCacheDir, path.join('D:', 'proj', 'scripts', 'code-index', 'hf-cache'));

const standalone = resolveLayout({
  moduleDir: path.join('D:', 'HbuilderX-Project', 'TokenSaver', 'code-index'),
  cwd: path.join('D:', 'HbuilderX-Project', 'TokenSaver', 'code-index'),
  env: {},
  homedir: path.join('C:', 'Users', 'me'),
  gitRoot: path.join('D:', 'HbuilderX-Project', 'TokenSaver'),
});
assert.equal(standalone.packed, false);
assert.equal(standalone.dataDir, path.join('D:', 'HbuilderX-Project', 'TokenSaver', 'data'));

const packed = resolveLayout({
  moduleDir: path.join('D:', 'proj', 'node_modules', '@dionfang', 'tokensaver'),
  cwd: path.join('D:', 'proj'),
  env: {},
  homedir: path.join('C:', 'Users', 'me'),
  gitRoot: path.join('D:', 'proj'),
});
assert.equal(packed.packed, true);
assert.equal(packed.dataDir, path.join('D:', 'proj', 'scripts', 'data'));
assert.equal(packed.hfCacheDir, path.join('C:', 'Users', 'me', '.tokensaver', 'hf-cache'));

const overridden = resolveLayout({
  moduleDir: path.join('D:', 'proj', 'node_modules', '@dionfang', 'tokensaver'),
  cwd: path.join('D:', 'proj'),
  env: { CODE_INDEX_DATA_DIR: path.join('E:', 'idx') },
  homedir: path.join('C:', 'Users', 'me'),
  gitRoot: path.join('D:', 'proj'),
});
assert.equal(overridden.dataDir, path.resolve(path.join('E:', 'idx')));

console.log('ok');
