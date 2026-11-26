#!/usr/bin/env node
/**
 * memorix-capture-bg.mjs —— 捕获类事件的**后台转发器**(2026-11-26 用户裁定)。
 *
 * 背景:捕获类钩子(PostToolUse/Stop)只落记忆、不注入上下文,宿主等它没有收益;
 *   而 memorix CLI 每次启动约 2-3s(13MB bundle + 128 模块 + React/ink 全家桶,与内容无关)。
 *
 * 为什么需要这个文件(而不是在转发器里直接 spawn):
 *   memorix 只从 **stdin** 读载荷(readHookStdin);detached + stdio:'ignore' 会丢载荷,
 *   而 Windows 下 cmd.exe 的 `< file` 重定向 + 引号嵌套在含空格路径下解析不可靠(实测报
 *   `'li' 不是内部或外部命令`)。本脚本用 Node 自己开管道:读载荷文件 → spawn memorix
 *   并写 stdin → 等其退出 → 删载荷文件。宿主侧 spawn 本脚本即返回,零等待。
 *
 * 串行化:并行工具调用会同时甩出多个本脚本,memorix 多进程并发写同一个 sqlite 会撞
 *   "database is locked"(本机 codegraph-refresh 已多次因此耗尽重试)。全局锁文件保证同一时刻
 *   只有一个捕获在跑;宿主不等,排队没有代价。持有者进程死亡即判陈旧锁,由后来者接管。
 *
 * 用法(由 memorix-hook.mjs 调用,勿手工跑):
 *   node memorix-capture-bg.mjs <cliEntry.js> <cliArg...> --payload <payloadFile>
 * 载荷文件由本脚本在退出时删除(成功/失败都删);失败静默(fail-open,不阻断宿主)。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { takeJsonLock, releaseJsonLock } from './proc.mjs';

const WATCHDOG_MS = 60_000; // memorix 卡死兜底:宿主不再等,改由本脚本自己收尾
const LOCK_WAIT_MS = 120_000; // 排队上限:前面堆积超过 2 分钟还没轮到,放弃本次(fail-open)
const LOCK = path.join(os.tmpdir(), 'tokensaver-mx-capture.lock');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--payload');
if (sep < 1 || sep === argv.length - 1) process.exit(0); // 至少要有 <cliEntry>,--payload 后要有文件
const cliEntry = argv[0];
const cliArgs = argv.slice(1, sep);
const payloadFile = argv[sep + 1];

const cleanup = () => { try { fs.unlinkSync(payloadFile); } catch { /* 已删 */ } };
const done = () => { clearTimeout(watchdog); releaseJsonLock(LOCK); cleanup(); process.exit(0); };

// 排队拿锁:100ms 一试,等到或超时为止
let locked = false;
for (const until = Date.now() + LOCK_WAIT_MS; !locked; ) {
  locked = takeJsonLock(LOCK);
  if (locked || Date.now() >= until) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
if (!locked) { cleanup(); process.exit(0); }

let payload = '{}';
try { payload = fs.readFileSync(payloadFile, 'utf8'); } catch { /* 读不到就空载荷 */ }

let child;
try {
  child = spawn(process.execPath, [cliEntry, ...cliArgs], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    env: { ...process.env, __MEMORIX_HEAP: '1' }, // 跳过 memorix 自重启 wrapper(省一次进程启动)
  });
} catch { cleanup(); releaseJsonLock(LOCK); process.exit(0); }

const watchdog = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } done(); }, WATCHDOG_MS);
child.on('error', done);
// 子进程早退时写 stdin 会 EPIPE:交给 exit 收尾;不挂监听则未处理的 error 事件炸掉本进程,载荷文件与锁泄漏。
child.stdin.on('error', () => { /* 见 exit */ });
try { child.stdin.write(payload); child.stdin.end(); } catch { /* 写失败即中止 */ }
child.on('exit', done);
