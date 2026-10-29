#!/usr/bin/env node
/** modelStatus 纯函数测试:输入端按日累计(原文/压缩后/节约)、比率与历史日期保留。 启动:cd code-index && npm test(或 node ../test/modelStatus.test.mjs) */
/** 输入端按日累计:原文、压缩后、节约。比率由当天前两个数相除。历史日期保留。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '../code-index/modelStatus.mjs')).href);

assert.equal(typeof mod.estimateSavedTokens, 'undefined', '未读行估算应已删除');
assert.equal(typeof mod.addSessionSavings, 'undefined');
assert.equal(typeof mod.normalizeSavings, 'function');
assert.equal(typeof mod.accumulateSavings, 'function');

{
  const once = mod.savingsFromCounts(1000, 400);
  assert.equal(once.saved, 600);
  assert.equal(once.percent, 0.6);
  assert.equal(mod.savingsFromCounts(10, 40).saved, 0, '压缩后更多则本次节约为 0');
}

{
  const ts = Date.parse('2026-10-28T12:01:17Z');
  const doc = mod.normalizeSavings({
    savedTokens: 72212,
    originalTokens: 17041,
    basisSaved: 56820,
    updatedAt: ts,
  }, ts);
  const day = doc.days[mod.dayKey(ts)];
  assert.equal(day.originalTokens, 17041);
  assert.equal(day.compressedTokens, 1649);
  assert.equal(day.savedTokens, 15392);
  assert.equal(doc.days[mod.dayKey(ts)].basisSaved, undefined);
  assert.equal(mod.normalizeSavings({ savedTokens: 100, updatedAt: ts }, ts).days[mod.dayKey(ts)], undefined, '没有原文的旧估算不带入');
}

{
  let state = {
    originalTokens: 0,
    compressedTokens: 0,
    savedTokens: 0,
    date: '2026-10-28',
    days: { '2026-10-27': { originalTokens: 10, compressedTokens: 4, savedTokens: 6 } },
  };
  state = mod.accumulateSavings(state, 1000, 400);
  state = mod.accumulateSavings(state, 100, 0);
  assert.equal(state.originalTokens, 1100);
  assert.equal(state.compressedTokens, 400);
  assert.equal(state.savedTokens, 700);
  assert.equal(state.days['2026-10-27'].savedTokens, 6, '累加今天不清昨天');
  assert.equal(mod.formatSavedClause(state), '700 tokens(压缩率 63.6%)', '比率由当天原文与压缩后相除');
}

{
  const before = mod.readSessionSavings();
  assert.ok(Number.isFinite(before) && before >= 0);
  assert.equal(mod.addInputSavings(0, 0), before, '原文为 0 不累加');
  assert.equal(mod.addInputSavings(-3, 1), before);
}

{
  // readInputTokens 信息字段:写入真实账本后原样还原,不影响节约口径
  const file = path.join(here, '..', 'data', 'session-savings.json');
  const snapshot = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    mod.addReadInputTokens(500);
    mod.addReadInputTokens(250);
    assert.ok(mod.readDayReadInputTokens() >= 750, 'readInputTokens 累加');
    // 回归:随后的搜索/拦截记账不得清零 readInputTokens
    mod.addInputSavings(1000, 400);
    assert.ok(mod.readDayReadInputTokens() >= 750, 'addInputSavings 后 readInputTokens 存活');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const today = j.days[mod.dayKey(Date.now())];
    assert.equal(typeof today.readInputTokens, 'number', '当日桶带 readInputTokens');
    assert.equal(typeof today.savedTokens, 'number');
  } finally {
    if (snapshot) fs.writeFileSync(file, snapshot); else fs.rmSync(file, { force: true });
  }
}

console.log('ok');
