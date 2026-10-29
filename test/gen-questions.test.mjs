#!/usr/bin/env node
/** gen-questions 纯函数测试:符号拆词、按块抽 SYM/GAP 题、可复现。启动:cd code-index && npm test(或 node ../test/gen-questions.test.mjs) */
import assert from 'node:assert/strict';
import { chunkQueries, generateFromChunks, splitIdent } from './scripts/gen-questions.mjs';

assert.deepEqual(splitIdent('topListingByUser'), ['top', 'Listing', 'By', 'User']);
assert.ok(splitIdent('script:unlockContact').includes('unlock') || splitIdent('script:unlockContact').includes('Contact'));

const chunks = [
  { p: 'proj-a/server/pay.service.js', s: 10, e: 40, y: 'validateWechatPayNotify', t: 'x\n微信支付回调 验签\nfunction validateWechatPayNotify() {}' },
  { p: 'proj-a/server/contact.service.js', s: 20, e: 50, y: 'unlockContact', t: 'x\n解锁联系方式\nfunction unlockContact() {}' },
  { p: 'proj-b/src/foo.ts', s: 1, e: 30, y: 'ensureUserExists', t: 'x\n新用户第一次进来\nfunction ensureUserExists() {}' },
  { p: 'proj-b/package.json', s: 1, e: 20, y: 'name', t: 'x\n' },
  { p: 'proj-a/admin/index.html', s: 1, e: 80, y: '', t: 'x\n' },
];

const g = generateFromChunks(chunks, { nSym: 2, nGap: 2, seed: 1, rootLabels: new Set(['proj-a', 'proj-b']) });
assert.equal(g.rows.length, 4);
assert.ok(g.rows.every((r) => r.query && r.file && r.lines?.[0]));
assert.ok(g.rows.some((r) => r.type === 'SYM'));
assert.ok(g.rows.some((r) => r.type === 'GAP'));
assert.ok(g.rows.every((r) => r.project === 'proj-a' || r.project === 'proj-b'));
assert.ok(!g.rows.some((r) => r.file.endsWith('package.json')));

const again = generateFromChunks(chunks, { nSym: 2, nGap: 2, seed: 1, rootLabels: new Set(['proj-a', 'proj-b']) });
assert.deepEqual(again.rows.map((r) => r.file + r.query), g.rows.map((r) => r.file + r.query));

const onlyA = generateFromChunks(chunks, { nSym: 4, nGap: 0, seed: 2, rootLabels: new Set(['proj-a']) });
assert.ok(onlyA.rows.every((r) => r.project === 'proj-a'));

const many = Array.from({ length: 8 }, (_, i) => ({
  p: `proj-a/src/f${i}.js`, s: 1, e: 20, y: `doThing${i}`, t: `x\n处理事项${i}\nfunction doThing${i}() {}`,
}));
const g5 = generateFromChunks(many, { nSym: 5, nGap: 3, seed: 1, rootLabels: new Set(['proj-a']) });
assert.equal(g5.rows.filter((r) => r.type === 'SYM').length, 5);
assert.equal(g5.rows.filter((r) => r.type === 'GAP').length, 3);
assert.equal(new Set(g5.rows.filter((r) => r.type === 'SYM').map((r) => r.file)).size, 5);

const q = chunkQueries(chunks[0], '微信支付回调验签');
assert.equal(q.gapQ, '微信支付回调验签');
assert.ok(q.symQ.includes('validate') || q.symQ.includes('Wechat'));
assert.ok(!q.symQ.includes('service'));

const noAnno = chunkQueries(chunks[0], '');
assert.ok(noAnno.gapQ);
assert.ok(!noAnno.gapQ.includes('validate'));
assert.ok(noAnno.gapQ.length <= 10);

const easyLeak = chunkQueries(
  { p: 'p/a.js', s: 1, e: 20, y: 'formatStatus', t: 'x\n审核状态展示\nfunction formatStatus() {}' },
  '',
);
assert.equal(easyLeak.symQ, '');
assert.ok(easyLeak.gapQ);

const weak = generateFromChunks([
  { p: 'proj-a/src/index.vue', s: 1, e: 40, y: 'template', t: 'x\n资讯分类\n<template></template>' },
], { nSym: 2, nGap: 1, seed: 1, rootLabels: new Set(['proj-a']) });
assert.equal(weak.rows.filter((r) => r.type === 'SYM').length, 0);
assert.equal(weak.rows.filter((r) => r.type === 'GAP').length, 1);

console.log('ok');
