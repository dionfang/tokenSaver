#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseInitArgs, isCodeIndexHookRef, gitignoreEntries } from './init.mjs';

assert.equal(parseInitArgs([]).modelIn, null);
assert.equal(parseInitArgs(['--model-in', 'local']).modelIn, 'local');
assert.equal(parseInitArgs(['--model-in', 'ollama']).modelIn, 'ollama');
assert.equal(parseInitArgs(['--model-in=ollama']).modelIn, 'ollama');
assert.equal(parseInitArgs(['--roots', 'D:/a']).roots, 'D:/a');
assert.ok(parseInitArgs(['--model-in', 'gpu']).error);
assert.ok(parseInitArgs(['--unknown']).error);
assert.ok(parseInitArgs(['--roots']).error);

assert.equal(isCodeIndexHookRef('scripts/code-index/auto.mjs'), true);
assert.equal(isCodeIndexHookRef('node_modules/@dionfang/tokensaver/warm.mjs'), true);
assert.equal(isCodeIndexHookRef('.cursor/hooks/warm-code-index.mjs'), true);
assert.equal(isCodeIndexHookRef('src/utils/auto.mjs'), false);

const copiedGi = gitignoreEntries({
  packed: false,
  repoRoot: path.join('D:', 'proj'),
  moduleDir: path.join('D:', 'proj', 'scripts', 'code-index'),
  dataDir: path.join('D:', 'proj', 'scripts', 'data'),
});
assert.deepEqual(copiedGi, ['/.zcode/', '/.cursor/', '/scripts/data/', '/scripts/code-index/']);

const packedGi = gitignoreEntries({
  packed: true,
  repoRoot: path.join('D:', 'proj'),
  moduleDir: path.join('D:', 'proj', 'node_modules', '@dionfang', 'tokensaver'),
  dataDir: path.join('D:', 'proj', 'scripts', 'data'),
});
assert.deepEqual(packedGi, ['/.zcode/', '/.cursor/', '/scripts/data/']);

console.log('ok');
