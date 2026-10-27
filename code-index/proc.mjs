/**
 * 进程/锁/后台拉起。auto、embed、warm、hooks 共用同一套判定,避免各文件各写一份 pidAlive。
 * 锁与 pid 文件都是 {pid,ts};超过 LOCK_TTL_MS 视为陈旧(防 PID 重用)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (pidAlive(raw.pid) && Number.isFinite(raw.ts) && Date.now() - raw.ts < LOCK_TTL_MS) return false;
  } catch { /* 无锁 */ }
  try { fs.unlinkSync(lockPath); } catch { /* 无锁或已失效 */ }
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch { return false; }
}

export function releaseJsonLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* 已释放 */ }
}

/** 分离后台 node 脚本,stdout/stderr 追加到 logAbs。调用方负责 unref 后的语义。 */
export function spawnLogged(scriptAbs, logAbs, cwd) {
  fs.mkdirSync(path.dirname(logAbs), { recursive: true });
  const logFd = fs.openSync(logAbs, 'a');
  const child = spawn(process.execPath, [scriptAbs], {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}
