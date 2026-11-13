/**
 * 预热登记表(2026-11-08):本工具在 Ollama 上拉起过哪些模型、local 常驻进程加载过哪些 id。
 *
 * 为什么要有这张表:Ollama 的 keep_alive 默认 2h,模型拉起后没人管就一直占着显存;
 * 清理侧要卸的是"我自己拉起来的"那批(用户自己的聊天模型不能碰),光看当前配置不够——
 * 切换模型后旧模型已经不在配置里了,必须靠这张表才认得出它是我们拉起的。
 * 因此**只增不减**:历史条目也留着,切换多轮后仍能卸干净。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { atomicWriteFileSync, takeJsonLock, releaseJsonLock } from './proc.mjs';

export const REGISTRY_PATH = path.join(DATA_DIR, '.warmed-registry.json');

function norm(v) {
  return [...new Set((Array.isArray(v) ? v : []).filter(Boolean).map(String))];
}

/** 读登记表;文件缺失或坏 JSON 一律当空表(不抛,清理侧 fail-open)。 */
export function readRegistry(file = REGISTRY_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ollama: norm(j?.ollama), local: norm(j?.local), updatedAt: Number(j?.updatedAt) || 0 };
  } catch {
    return { ollama: [], local: [], updatedAt: 0 };
  }
}

/** 写登记表(去重后落盘;原子写——崩溃不留半截 JSON)。 */
export function writeRegistry(reg = {}, file = REGISTRY_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = { ollama: norm(reg.ollama), local: norm(reg.local), updatedAt: Date.now() };
  atomicWriteFileSync(file, JSON.stringify(out) + '\n');
  return out;
}

/**
 * 登记一次预热。
 *   backend=ollama → 记 Ollama 模型名(embedding/reranker/decision)
 *   backend=local  → 记 transformers.js 模型 id(常驻进程加载的那三件套)
 */
export function registerWarmed({ backend, embedding, reranker, decision } = {}, file = REGISTRY_PATH) {
  // 锁内读改写(2026-11-10 审计修复):双进程并发登记会互相覆盖丢条目;锁忙时本次跳过,下个自愈周期再记
  const taken = takeJsonLock(file + '.lock');
  if (!taken) return null;
  try {
    const reg = readRegistry(file);
    const bucket = backend === 'local' ? reg.local : reg.ollama;
    [embedding, reranker, decision].filter(Boolean).forEach((n) => bucket.push(String(n)));
    return writeRegistry({ ollama: reg.ollama, local: reg.local }, file);
  } finally { releaseJsonLock(file + '.lock'); }
}

/** 清空登记表(全部清理完成后调用)。 */
export function clearRegistry(file = REGISTRY_PATH) {
  return writeRegistry({ ollama: [], local: [] }, file);
}
