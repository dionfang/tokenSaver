/**
 * spawn 封装(tray 方案 §16.1/§16.8):超时树杀(taskkill /T)、stdout/stderr 捕获、命令间互斥。
 * 全部 spawn 一律 windowsHide:true(钩子闪窗教训:控制台子系统 node spawn 必刮 conhost)。
 * 锁组:status/hooksStatus 可并行;warm/auto/init/import 互斥(同族一条在跑就拒新)。
 */
import { spawn } from 'node:child_process';

// embed:1h→6h(2026-11-21 测试机实锤):客户端 CPU 限线程嵌入全量 ≈1s/块,4419 块首建 >1.2h,
// 旧 1h 超时准点树杀→「每次满 1 小时结束嵌入」来回点好几轮才攒完。6h 与 .embed.pid 锁 TTL/面板
// 读锁 TTL 同口径(proc.mjs LOCK_TTL_MS),慢机一次点完;真僵死也在 6h 内被收尸,锁 TTL 保证面板可见性恢复。
export const TIMEOUTS = { status: 30_000, hooksStatus: 15_000, warm: 120_000, auto: 300_000, init: 300_000, import: 60_000, pull: 600_000, embed: 6 * 3_600_000 };
const MUTEX_FAMILIES = new Set(['warm', 'auto', 'init', 'import', 'pull']); // pull 互斥(2026-11-17 M3:拉模型与 warm/init 抢资源);embed 自持 .embed.pid 锁不入互斥族

/** 树杀命令构造(纯函数,供单测):Windows=taskkill /PID x /T /F,其余平台退化为 kill -9。 */
export function killTreeCommand(pid, platform = process.platform) {
  return platform === 'win32'
    ? { file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
    : { file: 'kill', args: ['-9', String(pid)] };
}

export function createCmdRunner() {
  const running = new Map();  // family -> { pid, startedAt, label }(仅互斥族登记)
  const children = new Set(); // 全部在跑的 child(退出时统一收口)

  function busyFamily() { for (const f of MUTEX_FAMILIES) if (running.has(f)) return f; return null; }

  /** 跑一条命令。返回 { code, stdout, stderr, timedOut, skipped, busyFamily?, label }。
   *  互斥族忙时 skipped:true 不 spawn;超时先树杀、5s 仍未退强收口并标 timedOut:true。 */
  function run(family, file, args, { timeoutMs = TIMEOUTS[family] ?? 60_000, cwd, label = `${file} ${args.join(' ')}`.slice(0, 120), onLine = null } = {}) {
    const busy = busyFamily();
    if (MUTEX_FAMILIES.has(family) && busy) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, skipped: true, busyFamily: busy, label });
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(file, args, { cwd, windowsHide: true });
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: String(e?.message || e), timedOut: false, skipped: false, label });
        return;
      }
      const rec = { pid: child.pid, startedAt: Date.now(), label };
      if (MUTEX_FAMILIES.has(family)) running.set(family, rec);
      children.add(child);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const cap = (buf, max, keep) => (buf.length > max ? buf.slice(-keep) : buf);
      let lineBuf = ''; // 2026-11-17 M3:onLine 流式行回调(增量,不传则行为与旧版完全一致)
      child.stdout?.on('data', (d) => {
        stdout = cap(stdout + d, 1_000_000, 500_000);
        if (onLine) {
          lineBuf += d;
          const ls = lineBuf.split(/\r?\n/); lineBuf = ls.pop();
          for (const l of ls) if (l.trim()) { try { onLine(l); } catch { /* 回调异常不影响命令 */ } }
        }
      });
      child.stderr?.on('data', (d) => { stderr = cap(stderr + d, 200_000, 100_000); });
      const killTimer = setTimeout(() => {
        timedOut = true;
        const kc = killTreeCommand(child.pid);
        try { spawn(kc.file, kc.args, { windowsHide: true, stdio: 'ignore' }); } catch { /* 尽力而为 */ }
        hardTimer = setTimeout(() => finish(child.exitCode ?? null), 5_000); // 树杀后仍未 close 的兜底
      }, timeoutMs);
      let hardTimer = null;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (hardTimer) clearTimeout(hardTimer);
        children.delete(child);
        if (running.get(family) === rec) running.delete(family);
        resolve({ code, stdout, stderr, timedOut, skipped: false, label });
      };
      child.on('error', (e) => { stderr += `\n${e.message}`; finish(-1); });
      child.on('close', (code) => finish(code));
    });
  }

  /** 退出收口:在跑进程树杀(auto 后台 detach 出去的 embed 不在树内,续嵌不受影响,设计如此)。 */
  function killAll() {
    for (const child of [...children]) {
      const kc = killTreeCommand(child.pid);
      try { spawn(kc.file, kc.args, { windowsHide: true, stdio: 'ignore' }); } catch { /* 尽力而为 */ }
    }
  }

  return { run, killAll, isBusy: () => busyFamily(), runningCount: () => running.size };
}
