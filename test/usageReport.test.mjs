#!/usr/bin/env node
/** usageReport 纯函数测试:解析、来源过滤、去重、汇总、A/B 对比。不联网、不读用户目录。 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, 'usageReport.mjs')).href);

const rec = (o) => JSON.stringify({
  type: 'model_io',
  sessionId: o.s,
  requestId: o.r,
  querySource: o.q || 'main_turn',
  model: { modelId: o.m || 'm1' },
  startedAt: o.t || '2026-10-28T00:00:00.000Z',
  completedAt: '2026-10-28T00:00:01.000Z',
  durationMs: 100,
  response: { usage: { inputTokens: o.i, outputTokens: o.o, totalTokens: o.i + o.o, cacheReadTokens: 0, cacheWriteTokens: 0 } },
});

const text = [
  rec({ s: 's1', r: 'r1', i: 100, o: 10 }),
  rec({ s: 's1', r: 'r2', i: 200, o: 20 }),
  rec({ s: 's2', r: 'r3', i: 300, o: 30 }),
  rec({ s: 's1', r: 'title', q: 'session_title', i: 50, o: 5 }),
  JSON.stringify({ type: 'model_io', sessionId: 's2', requestId: 'bad', error: { message: 'x' }, response: { usage: {} } }),
  'not json',
].join('\n');

const all = mod.parseRolloutLines(text, 'fixture');
assert.equal(all.length, 4, '错误行、空 usage、坏 JSON 不计数');

const main = mod.filterRecords(all);
assert.equal(main.length, 3, '默认只留 main_turn');
assert.equal(mod.filterRecords(all, { allSources: true }).length, 4);

const dup = [...all, all[0]];
assert.equal(mod.filterRecords(dup).length, 3, '同一 requestId 只算一次');

const summary = mod.aggregate(main);
assert.equal(summary.totals.sessions, 2);
assert.equal(summary.totals.requests, 3);
assert.equal(summary.totals.outputTotal, 60);
assert.equal(summary.totals.outputPerRequestMedian, 20);
assert.equal(summary.totals.inputTotal, 600);
assert.equal(summary.totals.inputPerRequestMedian, 200);
assert.equal(summary.sessions.find(s => s.sessionId === 's1').output, 30);

const lower = mod.aggregate(main.map(r => ({ ...r, output: 10 })));
const cmp = mod.compare(summary, lower);
assert.equal(cmp.rows.find(r => r.metric === 'outputPerRequestMedian').delta, -0.5);
assert.ok(cmp.warnings.some(w => w.includes('样本偏小')), '请求数过少要提示');

console.log('ok');
