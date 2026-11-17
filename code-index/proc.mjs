/**
 * 进程/锁/后台拉起。auto、embed、warm、hooks 共用同一套判定,避免各文件各写一份 pidAlive。
 * 锁与 pid 文件都是 {pid,ts};超过 LOCK_TTL_MS 视为陈旧(防 PID 重用)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

export function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}

export function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

export function takeJsonLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // wx-first(2026-11-10 二次审计 P1-5):先尝试原子创建,存在才走"读-验陈-清-重试"一次,
  // 消除"读旧锁→unlink→open(wx)"之间他人新锁被误删的 TOCTOU 窗口。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return false;
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* 锁文件损坏视为陈旧 */ }
      const stale = !raw || !pidAlive(raw.pid) || !Number.isFinite(raw.ts) || Date.now() - raw.ts >= LOCK_TTL_MS;
      if (!stale) return false;
      try { fs.unlinkSync(lockPath); } catch { /* 并发对手已清→下轮 wx 直接成功 */ }
    }
  }
  return false;
}

/** 只删除本进程持有的锁。晚退出的旧进程不能删掉后任已经写上的锁。 */
export function releaseJsonLock(lockPath, ownerPid = process.pid) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (Number(raw?.pid) !== Number(ownerPid)) return false;
  } catch { return false; }
  try { fs.unlinkSync(lockPath); return true; } catch { return false; }
}

/**
 * 找本模块脚本的运行中进程(孤儿清扫/看护去重用)。
 * 返回 [{pid, cmd}]。Windows 走 WQL 一把取全 node 进程再在 JS 里过滤;
 * moduleDir 用来只认"本模块目录下的同名脚本"(别的项目同名脚本不算)。
 */
export function findNodeScriptProcesses({ scriptNames = [], moduleDir = '', platform = process.platform } = {}) {
  const out = [];
  const dir = String(moduleDir || '').split(/[\\/]/).join('/');
  const want = scriptNames.map(String).filter(Boolean);
  if (!want.length) return out;
  try {
    if (platform === 'win32') {
      const filters = want.map((s) => `CommandLine LIKE '%${s}%'`).join(' OR ');
      const q = `Get-CimInstance Win32_Process -Filter "Name='node.exe' AND (${filters})" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
      const r = spawnSync('powershell', ['-NoProfile', '-Command', q], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1 << 24 });
      const parsed = JSON.parse(String(r.stdout || '[]').trim() || '[]');
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of list) {
        const pid = Number(p && p.ProcessId);
        const cmd = String((p && p.CommandLine) || '');
        if (!pid || !cmd) continue;
        const norm = cmd.split(/[\\/]/).join('/');
        if (dir && !norm.includes(dir)) continue;
        if (!want.some((s) => norm.includes(s))) continue;
        out.push({ pid, cmd: norm });
      }
    } else {
      const r = spawnSync('pgrep', ['-f', want.join('|')], { encoding: 'utf8', timeout: 8000 });
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (!pid) continue;
        let cmd = '';
        try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
        const norm = cmd.split(/[\\/]/).join('/');
        if (dir && !norm.includes(dir)) continue;
        if (!want.some((s) => norm.includes(s))) continue;
        out.push({ pid, cmd: norm });
      }
    }
  } catch { /* 枚举失败:当没有(fail-open,下轮自愈) */ }
  return out;
}

/** 分离后台 node 脚本,stdout/stderr 追加到 logAbs。调用方负责 unref 后的语义。args 可传附加参数。 */
export function spawnLogged(scriptAbs, logAbs, cwd, args = []) {
  fs.mkdirSync(path.dirname(logAbs), { recursive: true });
  const logFd = fs.openSync(logAbs, 'a');
  try {
    const child = spawn(process.execPath, [scriptAbs, ...args], {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.unref();
    return child;
  } finally { fs.closeSync(logFd); } // spawn 同步抛错也关 fd(2026-11-10 审计修复)
}

/**
 * 原子写(2026-11-10 审计修复):同目录 tmp + rename(Windows rename 覆盖已存在目标),崩溃不留半截文件。
 * 失败先清 tmp 再抛出。跨进程并发仍由调用方按需上 takeJsonLock;单进程内覆盖写点全部应改走本函数。
 * 2026-11-11 补 fsync:tmp 数据先落盘再 rename——掉电/异常关机时 NTFS 只保 rename 元数据、不保数据块,
 * 无 fsync 会留下"大小对、内容全 NUL"的空账(11-11 0:20 断电实证,rename 原子性只防并发撕裂不防掉电)。
 */
export function atomicWriteFileSync(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* 未开成 */ }
    try { fs.unlinkSync(tmp); } catch { /* tmp 已不在 */ }
    throw e;
  }
  try { fs.closeSync(fd); } catch { /* 已关 */ }
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* tmp 已不在 */ } throw e; }
}

/** JSON 原子写(2 空格缩进,与既有 writeFileSync(JSON.stringify(x, null, 2)) 口径一致)。 */
export function atomicWriteJsonSync(file, obj, space = 2) {
  atomicWriteFileSync(file, JSON.stringify(obj, null, space));
}
