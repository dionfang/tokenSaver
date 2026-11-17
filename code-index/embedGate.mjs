/**
 * 批量嵌入让行闸(2026-11-10)。
 * 背景:ollama 单队列串行——代码向量重嵌(1643 块)与四票代签(每题一次 embedding + 每题一次
 * tev1 判定)并发时互相排队,签入从数秒拖到数分钟,重嵌也被压到 0.1 块/秒。
 * 规则:**有 embed.mjs / modelRoute --build-vectors 在跑时,生产消费方不向 ollama 发推理请求**
 * (判定票弃权、L2 票弃权、精排降级),让批量任务独占队列尽快跑完。
 * 复用 embed.mjs 的单实例锁 data/.embed.pid({pid,ts}),不新增状态文件;进程崩溃/退出后按 pid 存活自动失效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { pidAlive, LOCK_TTL_MS } from './proc.mjs';

/** 是否有批量嵌入任务在跑(当前进程自己持有锁时不算 busy,供嵌入器内部使用)。 */
export function embedBusy(dataDir = DATA_DIR) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, '.embed.pid'), 'utf8'));
    if (!raw || !Number.isFinite(Number(raw.pid)) || !Number.isFinite(Number(raw.ts))) return false;
    if (Number(raw.pid) === process.pid) return false;
    if (Date.now() - Number(raw.ts) >= LOCK_TTL_MS) return false;
    return pidAlive(Number(raw.pid));
  } catch { return false; }
}

/** 让行原因(供台账/日志区分"忙跳过"与真实故障——忙跳过不得触发断路器)。 */
export const EMBED_BUSY_REASON = '批量嵌入进行中(ollama 串行队列让行)';

/** 死 pid 锁只在这段时间内挡住自动续嵌(WHEA 防立刻再点火)。过期后 embedCrashed 返回 false,auto 再启动 embed.mjs。 */
export const EMBED_CRASH_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * 上次批量嵌入是否仍在冷却(2026-11-11 WHEA 防再点火;2026-11-16 改为有限期)。
 * 正常退出会释放锁。强杀/崩溃留下死 pid 时,冷却期内 auto 不立刻再点火;冷却结束后返回 false,
 * 由 takeJsonLock 接管过期锁。无时间戳或时钟回拨不算冷却,避免永久卡死。
 * 手动 node embed.mjs 不看这个函数,随时可接管。
 */
export function embedCrashed(dataDir = DATA_DIR, now = Date.now()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, '.embed.pid'), 'utf8'));
    const pid = Number(raw?.pid);
    if (!Number.isFinite(pid) || pid <= 0 || pidAlive(pid)) return false;
    const ts = Number(raw?.ts);
    if (!Number.isFinite(ts)) return false;
    const age = now - ts;
    if (age < 0) return false;
    return age < EMBED_CRASH_COOLDOWN_MS;
  } catch { return false; }
}