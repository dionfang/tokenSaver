#!/usr/bin/env node
/**
 * session-start.mjs — ZCode SessionStart 合并入口(闪窗修复方案 A,2026-11-12 用户批准)。
 *
 * 背景:ZCode 对 type:'process' 钩子的 spawn 未加 windowsHide(C 问题,已提反馈),Windows 下
 * 每条钩子闪一个 conhost——原 SessionStart 挂两条(auto + snapshot-refresh)= 每次会话 2 闪。
 * 本入口把两条串成一条:ZCode 只 spawn 本入口(1 闪);两个子进程由这里以 windowsHide spawn,
 * **连子进程的窗一起消掉**——ZCode 的 C 修复落地前就先拿到"子进程零闪"。
 *
 * 顺序:snapshot-refresh(快,先同步路由库存与 auto 条目)→ auto(cleanup/预热/保鲜/状态句)。
 * stdout 契约:整个入口只输出一个 JSON——优先转发 auto 的 {"additionalContext":…};
 * snapshot-refresh 恒回 {} 不透传;子进程无 JSON 时输出 {}。退出码恒 0(hook 失败不阻断会话)。
 * 子进程超时:snapshot 10s / auto 400s,均在 ZCode 入口超时(420s)内;超时杀掉后仍按上面契约出 JSON。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (script, timeoutMs) => spawnSync(process.execPath, [path.join(here, script)], {
  cwd: here,
  encoding: 'utf8',
  timeout: timeoutMs,
  windowsHide: true, // 子进程零闪(父入口由 ZCode spawn,那 1 闪等 C 修复)
  stdio: ['ignore', 'pipe', 'inherit'], // stderr 透传(日志可见性不变);stdout 捕获做合并
});

// 先 snapshot-refresh:重抓路由库存 + auto 条目自愈,恒回 {}(不透传,只吃掉它的 stdout)
run('snapshot-refresh.mjs', 10000);

// 再 auto:预热前置(2026-11-12)后的主链,cleanup/warm/保鲜 build/状态句都在里面
let out = {};
const auto = run('auto.mjs', 400000);
const lines = String(auto.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
for (let i = lines.length - 1; i >= 0; i--) {
  try {
    const j = JSON.parse(lines[i]);
    if (j && typeof j === 'object' && Object.keys(j).length) { out = j; break; }
  } catch { /* 非 JSON 行(理论上 stdout 不该有)继续向前找 */ }
}
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
