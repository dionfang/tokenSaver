#!/usr/bin/env node
/** cmdRunner.mjs 测试(tray 方案 §16.8):超时表常量、树杀命令构造、互斥锁组、真实 spawn 回收/超时树杀。
 *  真实 spawn 均为秒级 node -e;Windows 本机跑 taskkill 树杀。启动:node ../test/tray/cmdRunner.test.mjs */
import assert from 'node:assert/strict';
import { TIMEOUTS, killTreeCommand, createCmdRunner } from '../../tray/src/cmdRunner.mjs';

// ---------- 1) 超时表(§16.8:status 30s/warm 120s/init 300s/import 60s) ----------
{
  assert.equal(TIMEOUTS.status, 30_000);
  assert.equal(TIMEOUTS.warm, 120_000);
  assert.equal(TIMEOUTS.init, 300_000);
  assert.equal(TIMEOUTS.import, 60_000);
  assert.ok(TIMEOUTS.auto >= TIMEOUTS.warm, 'auto 是编排入口(build+转后台 embed),不短于 warm');
  assert.ok(TIMEOUTS.hooksStatus > 0 && TIMEOUTS.hooksStatus < TIMEOUTS.status, 'hooksStatus 只读探测,最短');
  assert.equal(TIMEOUTS.pull, 600_000, 'M3:pull 族 10min(模型 GB 级)');
  // 2026-11-21:1h→6h——测试机 CPU 限线程嵌入 4419 块>1.2h,旧值准点树杀成「每次满 1 小时结束嵌入」;
  // 6h 与 .embed.pid 锁 TTL(proc.mjs LOCK_TTL_MS=6h)同口径,锚死防回退。
  assert.equal(TIMEOUTS.embed, 6 * 3_600_000, 'embed 族 6h(CPU 嵌入>1.2h,与锁 TTL 同口径)');
}

// ---------- 2) 树杀命令构造(纯函数) ----------
{
  const w = killTreeCommand(1234, 'win32');
  assert.equal(w.file, 'taskkill');
  assert.deepEqual(w.args, ['/PID', '1234', '/T', '/F'], 'Windows 树杀=taskkill /T /F');
  const u = killTreeCommand(1234, 'linux');
  assert.equal(u.file, 'kill');
  assert.deepEqual(u.args, ['-9', '1234'], '非 Windows 退化为 kill -9');
}

// ---------- 3) 真实 spawn:stdout 回收 + exit code ----------
{
  const r = createCmdRunner();
  const res = await r.run('status', process.execPath, ['-e', "console.log('tray-ok')"], { timeoutMs: 10_000 });
  assert.equal(res.skipped, false);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), 'tray-ok', 'stdout 捕获');
  assert.equal(res.timedOut, false);
}

// ---------- 4) 互斥锁组:warm/auto/init/import 互斥;status 可并行 ----------
{
  const r = createCmdRunner();
  const p1 = r.run('init', process.execPath, ['-e', 'setTimeout(()=>{},600)'], { timeoutMs: 5_000 });
  const busy = await r.run('auto', process.execPath, ['-e', "console.log('never')"], { timeoutMs: 5_000 });
  assert.equal(busy.skipped, true, '互斥族在跑时拒新');
  assert.equal(busy.busyFamily, 'init', '指明被谁占住');
  assert.equal(r.isBusy(), 'init');
  const par = await r.run('status', process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5_000 });
  assert.equal(par.skipped, false, 'status 不受互斥影响');
  const done = await p1;
  assert.equal(done.code, 0, '占住的 init 正常完成');
  assert.equal(r.isBusy(), null, '完成后锁释放');
  const after = await r.run('auto', process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5_000 });
  assert.equal(after.skipped, false, '锁释放后可再入');
}

// ---------- 5) 超时树杀:400ms 超时杀掉 10s 睡眠进程 ----------
{
  const r = createCmdRunner();
  const t0 = Date.now();
  const res = await r.run('warm', process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 400 });
  const dur = Date.now() - t0;
  assert.equal(res.timedOut, true, '超时标记');
  assert.ok(dur < 5_000, `超时后及时收口(实际 ${dur}ms,树杀+兜底生效)`);
}

// ---------- M3) onLine 流式行回调(2026-11-17:pull 进度经此推 Tooltip) ----------
{
  const runner = createCmdRunner();
  const got = [];
  const res = await runner.run('status', process.execPath, ['-e', "console.log('line-a');console.log('line-b');console.log('')"], { onLine: (l) => got.push(l) });
  assert.equal(res.code, 0);
  assert.deepEqual(got, ['line-a', 'line-b'], '逐行回调,空行过滤');
  assert.ok(res.stdout.includes('line-a'), '捕获不受 onLine 影响');
  // 不传 onLine 行为与旧版一致(不抛)
  const res2 = await runner.run('status', process.execPath, ['-e', "console.log('x')"]);
  assert.equal(res2.code, 0);
}

console.log('[ok] cmdRunner.test.mjs 全部通过(超时表 + 树杀构造 + 互斥锁组 + 真实 spawn/超时路径 + onLine 流式行)');
