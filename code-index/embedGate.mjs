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

/**
 * 上次批量嵌入是否异常终止(2026-11-11 WHEA 防再点火):.embed.pid 残留且 pid 已不在。
 * 正常退出(process.on('exit'))会释放锁;断电/强杀/WHEA 强制重启才留得下死 pid 锁——它就是崩溃现场标记。
 * 与 embedBusy 互补:busy=有人活着(生产消费方让行);crashed=上次死了(auto.mjs 挂起自动续嵌,
 * 硬件不稳期绝不自动再点火;人工确认后手动 node embed.mjs,锁走陈旧接管不被拦)。
 */
export function embedCrashed(dataDir = DATA_DIR) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, '.embed.pid'), 'utf8'));
    const pid = Number(raw?.pid);
    return Number.isFinite(pid) && pid > 0 && !pidAlive(pid);
  } catch { return false; }
}