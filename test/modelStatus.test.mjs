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

{
  // 会话累计口径修正:rollout 还在的拦截事件,按其后 main_turn 请求数补重复计费(入口一次账不动)
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-acc-'));
  const rollDir = path.join(dir, 'rollout');
  fs.mkdirSync(rollDir);
  const sid = 'session_abc123';
  const now = Date.now();
  const row = (iso, src = 'main_turn') => JSON.stringify({ type: 'model_io', querySource: src, startedAt: iso, response: { usage: { inputTokens: 100, outputTokens: 1 } } });
  fs.writeFileSync(path.join(rollDir, `model-io-${sid}.jsonl`), [
    row(new Date(now - 60000).toISOString()),
    row(new Date(now + 1000).toISOString()),
    row(new Date(now + 2000).toISOString()),
    row(new Date(now + 3000).toISOString()),
    row(new Date(now + 4000).toISOString(), 'session_title'),
  ].join('\n') + '\n');
  const acc = mod.accumulateReadEvents([{ at: now, session: sid, kind: 'Read', file: 'x.txt', bytes: 400 }], rollDir);
  assert.equal(acc.detail[0].rowsAfter, 3, '事件后 3 个 main_turn 请求(title 行不计)');
  assert.equal(acc.extra, 200, 'bytes/4=100,额外 (3-1)×100=200');
  assert.equal(mod.accumulateReadEvents([{ at: now - 70000, session: sid, kind: 'Read', file: 'x', bytes: 400 }], rollDir).extra, 300, '事件在全部请求之前 → (4-1)×100');
  assert.equal(mod.accumulateReadEvents([{ at: now, session: 'session_none', kind: 'Read', file: 'x', bytes: 400 }], rollDir).extra, 0, 'rollout 已清不修正');
  // void 配对:5 分钟内重发被放行,原事件与作废事件双双不计
  const voidEvents = [
    { at: now, session: sid, kind: 'Read', file: 'y.txt', bytes: 400 },
    { at: now, session: sid, kind: 'Read', file: 'y.txt', bytes: 400, void: true },
  ];
  assert.equal(mod.accumulateReadEvents(voidEvents, rollDir).extra, 0, 'override 配对后不计');
  assert.equal(mod.accumulateReadEvents(voidEvents, rollDir).detail[0].voided, true);
  const evPath = path.join(dir, 'events.jsonl');
  fs.writeFileSync(evPath, [
    JSON.stringify({ at: now, session: sid, kind: 'Read', file: 'x', bytes: 400 }),
    JSON.stringify({ at: now - 5 * 86400000, session: sid, kind: 'Read', file: 'old', bytes: 800 }),
    'broken-line',
  ].join('\n') + '\n');
  assert.equal(mod.readReadEvents(evPath, mod.dayKey(now)).length, 1, '只取当日有效事件');
  assert.equal(mod.readReadEvents(path.join(dir, 'missing.jsonl')).length, 0, '缺事件文件返回空');
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // 检索事件:认领前不累计,SearchClaim 指认后按"单次节约×其后请求数"累计
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-srch-'));
  const rollDir = path.join(dir, 'rollout');
  fs.mkdirSync(rollDir);
  const sid = 'session_srch';
  const now = Date.now();
  const row = (iso, src = 'main_turn') => JSON.stringify({ type: 'model_io', querySource: src, startedAt: iso, response: { usage: { inputTokens: 100, outputTokens: 1 } } });
  fs.writeFileSync(path.join(rollDir, `model-io-${sid}.jsonl`), [
    row(new Date(now - 60000).toISOString()),
    row(new Date(now + 1000).toISOString()),
    row(new Date(now + 2000).toISOString()),
    row(new Date(now + 3000).toISOString()),
  ].join('\n') + '\n');
  const search = { at: now, session: null, kind: 'Search', file: '会话累计 修正', originalTokens: 500, compressedTokens: 100 };
  assert.equal(mod.accumulateReadEvents([search], rollDir).extra, 0, '无主检索事件不累计');
  const claim = { at: now + 500, session: sid, kind: 'SearchClaim', refAt: now };
  const acc = mod.accumulateReadEvents(mod.attributeSearchEvents([search, claim]), rollDir);
  assert.equal(acc.extra, 800, '单次节约 400 × (3−1) = 800');
  assert.equal(acc.detail[0].rowsAfter, 3);
  // attributeSearchEvents:先到先得,重复指认取第一个
  const twoClaims = mod.attributeSearchEvents([search, claim, { at: now + 900, session: 'session_other', kind: 'SearchClaim', refAt: now }]);
  assert.equal(twoClaims[0].session, sid, '先到先得');
  // findSearchEventRef:命令含查询原文才认领,已认领/超窗/无 search.mjs 均不认领
  const evs = [search, claim];
  assert.equal(mod.findSearchEventRef(evs, 'node search.mjs "会话累计 修正" --k 5', now + 600), null, '已被认领不重复认领');
  assert.equal(mod.findSearchEventRef([{ ...search, at: now - 200000 }], 'node search.mjs "会话累计 修正"', now + 600), null, '超窗不认领');
  assert.equal(mod.findSearchEventRef([{ ...search, at: now + 700 }], 'node search.mjs "会话累计 修正"', now + 600), null, '事件晚于命令不认领');
  assert.equal(mod.findSearchEventRef([{ ...search, at: now - 1000 }], 'node search.mjs 别的查询', now + 600), null, '查询不匹配不认领');
  const ref = mod.findSearchEventRef([search], 'node x && node search.mjs "会话累计 修正" --k 5', now + 600);
  assert.equal(ref, now, '命令含查询原文即认领');
  assert.equal(mod.findSearchEventRef([search], 'node build.mjs', now + 600), null, '非检索命令不认领');
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // 水位化持久累计:增量入账、单调不回落、不重复计、void 退款、rollout 缺失保留已入账
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-wm-'));
  const rollDir = path.join(dir, 'rollout');
  fs.mkdirSync(rollDir);
  const sid = 'session_wm';
  const t0 = Date.parse('2026-10-30T10:00:00Z');
  const mk = (i, ms) => JSON.stringify({
    type: 'model_io', querySource: 'main_turn', requestId: `rq_${String(i).padStart(4, '0')}`,
    startedAt: new Date(ms).toISOString(), response: { usage: { inputTokens: 100, outputTokens: 1 } },
  });
  const file = path.join(rollDir, `model-io-${sid}.jsonl`);
  const writeRows = (n) => fs.writeFileSync(file, [0, 1, 2].map((i) => mk(i, t0 + i * 1000)).concat(Array.from({ length: n }, (_, i) => mk(10 + i, t0 + 10000 + i * 1000))).join('\n') + '\n');
  writeRows(3);
  const ev = { at: t0 - 5000, session: sid, kind: 'Read', file: 'w.txt', bytes: 400 };
  // 首次:边界=事件时刻,计入事件之后的全部 main_turn iteration
  const first = mod.computeAccumulation([ev], {}, rollDir);
  assert.equal(first.total, 600, '单次节约 100 × 6 iteration = 600');
  assert.equal(first.detail[0].newIterations, 6);
  // 水位推进后再算:没有新 iteration → 增量为 0(不重复计)
  const wm = { [mod.eventKey(ev)]: { at: ev.at, session: sid, kind: 'Read', file: 'w.txt', tokens: 100, counted: 6, lastAt: first.detail[0].lastAt, lastKey: first.detail[0].lastKey, accumulated: 600 } };
  const again = mod.computeAccumulation([ev], wm, rollDir);
  assert.equal(again.total, 0, '已计入的不再重复计');
  assert.equal(again.detail[0].accumulated, 600, '已入账累计保持');
  // 新增 iteration → 只补差额
  writeRows(5);
  const more = mod.computeAccumulation([ev], wm, rollDir);
  assert.equal(more.total, 200, '新增 2 个 iteration × 100 = 200');
  assert.equal(more.detail[0].accumulated, 800, '累计 = 600 + 200');
  // rollout 被清理 → 不产生增量,已入账保留(不回落)
  fs.rmSync(file);
  const gone = mod.computeAccumulation([ev], wm, rollDir);
  assert.equal(gone.total, 0, 'rollout 已清不新增');
  assert.equal(gone.detail[0].accumulated, 600, '已入账金额保留');
  assert.equal(gone.detail[0].rolloutMissing, true);
  // void(5 分钟内重发放行)→ 退回此前已入账金额,并退回入口一次的账(内容真进了上下文)
  const voided = mod.computeAccumulation([ev, { ...ev, void: true }], wm, rollDir);
  assert.equal(voided.refund, 700, 'void 退回已入账 600 + 入口一次 100');
  assert.equal(voided.detail[0].entryRefund, 100, '入口一次也要退');
  assert.equal(voided.total, 0);
  // 只退一次:水位标记 entryRefunded 后不再重复退
  const wmVoided = { [mod.eventKey(ev)]: { ...wm[mod.eventKey(ev)], accumulated: 0, voided: true, entryRefunded: true } };
  const voided2 = mod.computeAccumulation([ev, { ...ev, void: true }], wmVoided, rollDir);
  assert.equal(voided2.refund, 0, '不重复退');
  // Rewrite 事件:单次节约 = (bytes − rangeBytes)/4,同样按其后 iteration 数累计
  writeRows(2);
  const rwEv = { at: t0 + 500, session: sid, kind: 'Rewrite', file: 'w2.txt', bytes: 40000, rangeBytes: 10000 };
  const rwAcc = mod.computeAccumulation([rwEv], {}, rollDir);
  assert.equal(rwAcc.detail[0].tokens, 7500, '(40000−10000)/4 = 7500');
  assert.equal(rwAcc.total, 7500 * 4, '事件后 4 个 main_turn iteration(t0+500 之后)');

  // 水位文件读写
  const wmFile = path.join(dir, 'wm.json');
  mod.writeWatermarks({ k: { accumulated: 5 } }, wmFile);
  assert.equal(mod.readWatermarks(wmFile).k.accumulated, 5);
  mod.writeWatermarks({}, wmFile);
  assert.deepEqual(mod.readWatermarks(wmFile), {});
  assert.deepEqual(mod.readWatermarks(path.join(dir, 'none.json')), {}, '缺文件返回空');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('ok');
