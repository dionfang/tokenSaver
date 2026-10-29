#!/usr/bin/env node
/** 预取纯函数测试:载荷提取、bm25 命中、格式化、预取总入口(开关/去重/短话跳过)。 启动:cd code-index && npm test(或 node ../test/prefetch.test.mjs) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPrompt, tokenizeQuery, bm25Prefetch, formatHits, prefetchContext } from '../code-index/prompt-guard.mjs';

// extractPrompt 候选键
assert.equal(extractPrompt({ prompt: 'abc' }), 'abc');
assert.equal(extractPrompt({ user_prompt: 'def' }), 'def');
assert.equal(extractPrompt({ text: '  ghi  ' }), 'ghi');
assert.equal(extractPrompt({ unrelated: 1 }), '');
assert.equal(extractPrompt(null), '');

// tokenize:标识符拆分 + CJK 二元组
assert.deepEqual(tokenizeQuery('measureInputSavings'), ['measureinputsavings', 'measure', 'input', 'savings']);
assert.deepEqual(tokenizeQuery('节约'), ['节约']);
assert.ok(tokenizeQuery('记账逻辑在哪').includes('记账'));

// bm25:相关块排前,无关块不入
const chunks = [
  { p: 'a/token.ts', s: 1, e: 50, t: 'a/token.ts\nfunction countTokens(qwen) { return encode(text).ids.length; } 节约记账' },
  { p: 'b/ui.vue', s: 1, e: 30, t: 'b/ui.vue\n<button @click="showModal">打开弹窗</button>' },
  { p: 'c/ledger.mjs', s: 10, e: 20, t: 'c/ledger.mjs\nsavedTokens 累计 压缩后 originalTokens 记账' },
];
const hits = bm25Prefetch(chunks, 'token 节约 记账 在哪', 3);
assert.equal(hits.length, 2, '无关块不得入选');
assert.equal(hits[0].p, 'a/token.ts');
assert.ok(bm25Prefetch(chunks, '弹窗', 3)[0].p === 'b/ui.vue');
assert.deepEqual(bm25Prefetch(chunks, '', 3), [], '空查询返回空');
assert.deepEqual(bm25Prefetch([], 'abc', 3), []);

const lines = formatHits(hits);
assert.match(lines, /^1\. a\/token\.ts:1-50\n2\. c\/ledger\.mjs:10-20$/);

// prefetchContext:临时 DATA 替身(状态文件也密闭,不碰真实 data/)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pf-'));
const chunksPath = path.join(tmp, 'chunks.jsonl');
fs.writeFileSync(chunksPath, chunks.map(c => JSON.stringify(c)).join('\n'));
const configPath = path.join(tmp, 'code-index.config.json');
fs.writeFileSync(configPath, JSON.stringify({}));
const statePath = path.join(tmp, '.prefetch-last.json');
const opts = { chunksPath, configPath, statePath };
const prompt = 'token 节约 记账 的逻辑在哪,如何统计压缩前后';
const ctx = prefetchContext({ prompt }, opts);
assert.ok(ctx && ctx.includes('a/token.ts:1-50'), '应注入命中');

// 相同原话 10 分钟内去重
assert.equal(prefetchContext({ prompt }, opts), null, '同话去重');

// 开关关闭
fs.writeFileSync(configPath, JSON.stringify({ prefetch: { enabled: false } }));
assert.equal(prefetchContext({ prompt: '另一个完全不同的问题关于弹窗组件' }, opts), null, 'enabled=false 不注入');

// 短话跳过
fs.writeFileSync(configPath, JSON.stringify({ prefetch: { minChars: 12 } }));
assert.equal(prefetchContext({ prompt: '继续' }, opts), null, '短话不注入');

// chunks 缺失
assert.equal(prefetchContext({ prompt: 'token 节约 记账 的逻辑' }, { chunksPath: path.join(tmp, 'missing.jsonl'), configPath, statePath }), null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok');
