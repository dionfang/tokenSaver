/**
 * 本地代理保活(动态模型路由):宿主侧钩子在用户消息进来之前,确保本地代理(modelRouteProxy.mjs)
 * 已经活着——否则选了虚拟供应商 tokenSaverModel 的会话会直接 connection refused。
 *
 * 为什么需要:代理进程是"选了路由模型的会话"的必经路径,当前没有任何自启机制(无计划任务/无启动项),
 * 机器重启或进程退出后路由面就断了。钩子拉起是零新增依赖的做法(钩子基础设施已就位,判据是端口)。
 *
 * 触发判据(按可得信息逐级收紧,拿不准时偏"保活"):
 *   ① 载荷暴露供应商 → 精确:providerId ∈ 虚拟条目 id 集(ZCode tokenSaverModel / Qoder tokensaver-auto)才拉起;
 *   ② 载荷只暴露模型 → auto 档位制下客户端清单恒为 ["auto"],真实模型名(来自其他供应商)可判定为不拉起,
 *      命中虚拟清单或来源不可辨仍按保活处理;
 *   ③ 载荷什么都没暴露 → 保活(漏拉起=会话直接报错;多拉起=一个空闲进程,代价小得多)。
 *
 * 铁律:全程 fail-open——任何异常都不抛、不阻塞用户输入;拉起失败只留痕不报错。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.mjs';
import { pidAlive, spawnLogged } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 虚拟供应商 id(ZCode 端,与 init 播种的条目一致)。 */
export const VIRTUAL_PROVIDER_ID = 'tokenSaverModel';
/** 虚拟供应商 id(Qoder 端 settings.json providers 键)。 */
export const QODER_VIRTUAL_PROVIDER_ID = 'tokensaver-auto';
/** 全部虚拟条目 id(两端各自播种一个,都指向本地代理)。 */
export const VIRTUAL_PROVIDER_IDS = [VIRTUAL_PROVIDER_ID, QODER_VIRTUAL_PROVIDER_ID];
/** 本地代理默认端口(与 modelRouteProxy.mjs 的 CLI 默认值一致)。 */
export const PROXY_PORT = 8117;
/** 拉起后等待端口就绪的上限(毫秒)——不等到就绪,这一轮请求会 connection refused。 */
const READY_WAIT_MS = 2500;
/** 拉起失败后的重试冷却(毫秒):避免代理起不来时每轮都刷一次进程。 */
const RESPAWN_COOLDOWN_MS = 30000;

export function proxyPidPath(dataDir = DATA_DIR) { return path.join(dataDir, 'usage', 'proxy.pid'); }
export function proxyLogPath(dataDir = DATA_DIR) { return path.join(dataDir, 'usage', 'proxy.log'); }
export function respawnGuardPath(dataDir = DATA_DIR) { return path.join(dataDir, 'usage', 'proxy-respawn.json'); }

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** 代理 pid 文件在且进程活着 → 确定在跑(最快的判定,零网络)。 */
export function proxyPidAlive(dataDir = DATA_DIR) {
  const rec = readJson(proxyPidPath(dataDir));
  return !!(rec && pidAlive(Number(rec.pid)));
}

/** 端口探测:本地环回,连上/被拒都是毫秒级。 */
export function probeProxy(port = PROXY_PORT, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 已断 */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, '127.0.0.1'); } catch { finish(false); }
  });
}

/** 虚拟条目里的模型清单(auto 档下恒为 ["auto"])。读不到返回空数组。 */
export function virtualProviderModels({ home = os.homedir(), providerId = null } = {}) {
  const ids = providerId ? [providerId] : VIRTUAL_PROVIDER_IDS;
  const out = [];
  const push = (m) => { if (typeof m === 'string' && m && !out.includes(m)) out.push(m); };
  // ZCode 形态
  const pc = readJson(path.join(home, '.zcode', 'v2', 'provider_config.json'));
  const rules = pc?.config?.providerConfigRules?.providerRules;
  if (Array.isArray(rules)) {
    for (const id of ids) {
      const entry = rules.find((r) => r?.providerId === id);
      if (Array.isArray(entry?.config?.personalModelIds)) entry.config.personalModelIds.forEach(push);
    }
  }
  // Qoder 形态
  for (const dir of ['.qoder-cn', '.qoder']) {
    const st = readJson(path.join(home, dir, 'settings.json'));
    for (const id of ids) {
      const models = st?.providers?.[id]?.models;
      if (Array.isArray(models)) models.forEach((m) => push(typeof m === 'string' ? m : m?.model));
    }
  }
  return out;
}

/** 载荷里的供应商线索(取第一个非空)。 */
export function providerHintOf(payload) {
  const p = payload || {};
  const cands = [
    p.providerId, p.provider_id, p.provider, p.modelProviderId, p.model_provider_id,
    p.session?.providerId, p.session?.provider, p.model?.providerId, p.model?.provider,
    p.turn?.providerId, p.workspace?.providerId, p.conversation?.providerId,
  ];
  for (const v of cands) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

/** 载荷里的模型线索(取第一个非空;model 是对象时取 id)。 */
export function modelHintOf(payload) {
  const p = payload || {};
  const cands = [
    typeof p.model === 'string' ? p.model : null,
    p.model?.id, p.modelId, p.model_id,
    p.session?.model, p.session?.modelId, p.turn?.model, p.conversation?.model,
  ];
  for (const v of cands) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

/**
 * 该不该保活代理:能精确判就精确判,判不了偏保活(漏拉起会让会话直接报错,多拉起只多一个空闲进程)。
 * 返回 {needed, reason}。
 */
export function shouldEnsureProxy(payload, { models = [] } = {}) {
  const provider = providerHintOf(payload);
  if (provider) {
    return VIRTUAL_PROVIDER_IDS.includes(provider)
      ? { needed: true, reason: `载荷供应商=${provider}(虚拟条目)` }
      : { needed: false, reason: `载荷供应商=${provider}(非虚拟条目,不拉起)` };
  }
  const model = modelHintOf(payload);
  if (model && models.length && !models.includes(model)) {
    return { needed: false, reason: `载荷模型=${model} 不在虚拟条目清单(非路由会话)` };
  }
  if (model) return { needed: true, reason: `载荷模型=${model} 命中虚拟清单或来源不可辨(保活)` };
  return { needed: true, reason: '载荷未暴露模型/供应商信息(保活)' };
}

/** 拉起后轮询端口就绪。 */
export async function waitProxyReady(port = PROXY_PORT, timeoutMs = READY_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeProxy(port, 200)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * 确保本地代理在跑:pid 文件活 → 直接返回;端口通 → 返回;否则分离后台拉起并等端口就绪。
 * 全程 fail-open,返回 {state, reason};state ∈ running | started | skipped | failed。
 */
export async function ensureProxyRunning({
  dataDir = DATA_DIR,
  port = PROXY_PORT,
  scriptPath = path.join(here, 'modelRouteProxy.mjs'),
  cwd = here,
  logFile = proxyLogPath(dataDir),
  payload = null,
  models = null,
  probeTimeoutMs = 300,
  waitReadyMs = READY_WAIT_MS,
} = {}) {
  try {
    const list = models || virtualProviderModels({});
    const judge = shouldEnsureProxy(payload || {}, { models: list });
    if (!judge.needed) return { state: 'skipped', reason: judge.reason };
    if (proxyPidAlive(dataDir)) return { state: 'running', reason: 'pid 文件在且进程活着', via: 'pid' };
    if (await probeProxy(port, probeTimeoutMs)) return { state: 'running', reason: '端口已在监听', via: 'probe' };
    const guard = readJson(respawnGuardPath(dataDir));
    if (guard && Date.now() - Number(guard.at || 0) < RESPAWN_COOLDOWN_MS) {
      return { state: 'failed', reason: `刚拉起失败过(${Math.round((Date.now() - Number(guard.at)) / 1000)}s 内不重试)` };
    }
    if (!fs.existsSync(scriptPath)) return { state: 'failed', reason: `代理脚本不存在:${scriptPath}` };
    const child = spawnLogged(scriptPath, logFile, cwd);
    const ready = await waitProxyReady(port, waitReadyMs);
    if (!ready) {
      try { fs.mkdirSync(path.dirname(respawnGuardPath(dataDir)), { recursive: true }); fs.writeFileSync(respawnGuardPath(dataDir), JSON.stringify({ at: Date.now() })); } catch { /* 记不上就下次再试 */ }
      return { state: 'failed', reason: '已拉起但端口未就绪' };
    }
    try { fs.unlinkSync(respawnGuardPath(dataDir)); } catch { /* 无冷却记录 */ }
    return { state: 'started', reason: `已分离后台拉起代理(端口 ${port}),pid=${child?.pid ?? '?'}`, via: 'spawn', pid: child?.pid ?? null, port };
  } catch (e) {
    return { state: 'failed', reason: `保活异常:${e?.message || e}` };
  }
}

/**
 * 载荷键名采样(只记键名,不记值):用于确认宿主到底暴露了哪些字段(模型/供应商),
 * 以便把保活判据从"拿不准就保活"收紧为精确触发。限频写入(每小时一次)。
 */
export function recordPayloadKeys(payload, { dataDir = DATA_DIR, file = null, minIntervalMs = 60 * 60 * 1000 } = {}) {
  try {
    const keys = Object.keys(payload || {});
    if (!keys.length) return false; // 空载荷(测试/坏 JSON)没有信息量,不落盘占位
    const out = file || path.join(dataDir, 'usage', 'hook-payload-keys.json');
    const prev = readJson(out);
    if (prev && Date.now() - Number(prev.at || 0) < minIntervalMs) return false;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ at: Date.now(), keys, sample: Object.fromEntries(keys.map((k) => [k, typeof (payload || {})[k]])) }, null, 2));
    return true;
  } catch { return false; }
}
