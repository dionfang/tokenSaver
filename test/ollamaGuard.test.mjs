#!/usr/bin/env node
/** ollamaGuard 纯函数测试:模型名比对、替换探测。启动:cd code-index && npm test(或 node ../test/ollamaGuard.test.mjs) */
import assert from 'node:assert/strict';
import { sameOllamaName, replacedOllamaNames } from '../code-index/ollamaGuard.mjs';

assert.equal(sameOllamaName('qwen3-embedding:0.6b', 'qwen3-embedding:0.6b'), true);
assert.equal(sameOllamaName('qwen3-embedding:0.6b', 'qwen3-embedding:4b'), false);
assert.equal(sameOllamaName('llama3', 'llama3:latest'), true);
assert.equal(sameOllamaName('a:latest', 'a'), true);

assert.deepEqual(
  replacedOllamaNames(
    ['qwen3-embedding:0.6b', 'qwen3-embedding:4b', 'sam860/qwen3-reranker:0.6b-F16', 'qwen3-coder:30b'],
    ['qwen3-embedding:4b', 'sam860/qwen3-reranker:0.6b-F16'],
    ['qwen3-embedding:0.6b'],
  ),
  ['qwen3-embedding:0.6b'],
);
assert.deepEqual(
  replacedOllamaNames(['qwen3-embedding:4b'], ['qwen3-embedding:4b'], ['qwen3-embedding:0.6b']),
  [],
);

console.log('ok');
