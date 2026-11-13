#!/usr/bin/env node
/**
 * 关闭看护(2026-11-08):宿主关掉时,本地模型要跟着卸干净。
 *
 * 为什么需要看护:ZCode 的钩子只有七个事件(SessionStart / UserPromptSubmit / PreToolUse /
 * PermissionRequest / PostToolUse / PostToolUseFailure / Stop),**没有 SessionEnd**——
 * 宿主进程退出时没有任何回调能拿到"我要走了"这个信号。而 Ollama 的 keep_alive 默认 2h、
 * transformers.js 常驻进程空闲 2h 才自退,于是宿主关了模型还在后台占着显存。
 * 本模块补这个洞:会话开始时拉起一个脱离父进程的看护,盯住宿主进程;宿主退出即卸掉本地模型。
 *
 * 判"宿主已退出"的口径(2026-11-08 实弹修正):**祖先链上的进程全死**且**机器上没有宿主应用在跑**。
 * 只认某一个宿主 PID 会误判——ZCode.exe 有多个进程(主进程 + 短命helper),认到短命的那个
 * 会导致"应用还开着就把模型卸了"(实测踩过)。两条都满足才算退出。
 *
 * 多会话:本地模型是共享资源,登记表 data/.cleanup-watchers.json 里还有别的看护活着就不卸,
 * 等最后一个会话结束才统一清。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { spawnLogged, findNodeScriptProcesses } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 宿主应用映像名(小写比对):机器上还有这些在跑 ⇒ 宿主没退。 */
export const HOST_IMAGES = ['zcode.exe', 'cursor.exe', 'qoder.exe'];

/** 看护登记表:每个活跃会话一条。 */
export const WATCHERS_PATH = path.join(DATA_DIR, '.cleanup-watchers.json');

/** 轮询间隔与"连续判定宿主已退出"的次数(约 3×4s=12s 宽限,躲开进程抖动)。 */
export const POLL_MS = 4000;
export const DEAD_STREAK = 3;

export function readWatchers(file = WATCHERS_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j.filter((w) => w && Number.isFinite(Number(w.pid))) : [];
  } catch {
    return [];
  }
}

export function writeWatchers(list = [], file = WATCHERS_PATH) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list) + '\n');
  } catch { /* 写不了就当没登记,不影响主流程 */ }
  return list;
}

/** 登记/注销看护。 */
export function addWatcher(w, file = WATCHERS_PATH) {
  const list = readWatchers(file).filter((x) => Number(x.pid) !== Number(w.pid));
  list.push({ pid: Number(w.pid), hostPid: Number(w.hostPid) || 0, chain: (w.chain || []).map(Number), startedAt: Date.now() });
  return writeWatchers(list, file);
}

export function removeWatcher(pid, file = WATCHERS_PATH) {
  return writeWatchers(readWatchers(file).filter((x) => Number(x.pid) !== Number(pid)), file);
}

/**
 * 解析 tasklist /FO CSV /NH 的输出 → pid → 映像名(小写)。
 * ⚠️ tasklist 的**每个字段都带引号**,PID 是 "54300" 不是 54300——按无引号解析会整表读空,
 * 后果是"所有进程都像死了"(实测踩过:看护把还开着的 ZCode 当成已退出,误卸了模型)。
 */
export function parseProcessListCsv(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m) map.set(Number(m[2]), m[1].toLowerCase());
  }
  return map;
}

/** 当前活着的进程表 pid → 映像名(小写)。Windows 用 tasklist(快),其他平台用 ps。 */
export function aliveProcesses() {
  const map = new Map();
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      return parseProcessListCsv(r.stdout);
    }
    const r = spawnSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8', timeout: 8000 });
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m && Number(m[1]) > 0) map.set(Number(m[1]), m[2].toLowerCase());
    }
  } catch { /* 列进程失败:当没有活进程,上层保守地不动手 */ }
  return map;
}

/** 当前活着的 pid 集合(兼容旧调用面)。 */
export function alivePids() {
  return new Set(aliveProcesses().keys());
}

/** 全量进程表 [{pid,ppid,name}]。Windows 走 PowerShell 一次拿全(约 0.5s),其他平台用 ps。 */
export function procTree() {
  try {
    if (process.platform === 'win32') {
      const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1 << 24 });
      const j = JSON.parse(String(r.stdout || '').trim() || '[]');
      const arr = Array.isArray(j) ? j : [j];
      return arr.filter(Boolean).map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId) || 0, name: String(p.Name || '') }));
    }
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 8000 });
    return String(r.stdout || '').split(/\r?\n/).map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), name: m[3] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** 从 pid 往上走祖先链(不含自己),最多 12 层。 */
export function ancestorChain(fromPid, tree = []) {
  const map = new Map(tree.map((p) => [p.pid, p]));
  const chain = [];
  let pid = Number(fromPid);
  for (let i = 0; i < 12 && pid; i++) {
    const node = map.get(pid);
    if (!node) break;
    pid = node.ppid;
    if (!pid || pid <= 0) break;
    const parent = map.get(pid);
    chain.push({ pid, name: parent ? parent.name : '' });
  }
  return chain;
}

/** 祖先链里的宿主应用进程(ZCode.exe / Cursor.exe / Qoder.exe);认不到返回 []。 */
export function findHostPids(chain = []) {
  return chain.filter((c) => HOST_IMAGES.includes(String(c.name || '').toLowerCase())).map((c) => Number(c.pid));
}

/** 祖先链里出现过的宿主应用**名**(小写);认不到返回 []。只认本会话所属的那个宿主,别把别的编辑器算进来。 */
export function findHostImages(chain = []) {
  return [...new Set(chain.map((c) => String(c.name || '').toLowerCase()).filter((n) => HOST_IMAGES.includes(n)))];
}

/** 机器上还有宿主应用在跑吗(任一实例即可)。 */
export function hostImageAlive(procs = aliveProcesses(), images = HOST_IMAGES) {
  const want = new Set(images);
  for (const name of procs.values()) {
    if (want.has(name)) return true;
  }
  return false;
}

/**
 * 宿主是否已退出(纯函数,便于测试):
 *   链上进程全死 **且** 本会话所属的宿主应用一个都不在了。
 * 单看某个宿主 PID 会误判(短命 helper 先死 → 应用还开着就卸模型);
 * 也不看别的编辑器(关了 ZCode 但开着 Cursor 时,ZCode 的模型仍要卸干净)。
 * ⚠️ images 为空表示"没认出宿主应用",此时**只按链判**——绝不能回退成"机器上还有任意
 * zcode.exe 就算活着"(那会让看护永不退出,实测堆积 63 个看护/2.8GB)。
 */
export function hostGone({ chain = [], hosts = [], images = [], procs = new Map() } = {}) {
  const chainAlive = chain.some((p) => procs.has(Number(p)));
  const hostAlive = hosts.some((p) => procs.has(Number(p))) || hostImageAlive(procs, images);
  return !chainAlive && !hostAlive;
}

/** 从看护进程的命令行解析它盯的参数(--chain/--hosts/--images)。空参数在命令行里是 `""`,要去引号。 */
export function parseWatcherArgs(cmd = '') {
  const pick = (name) => {
    const m = String(cmd).match(new RegExp(`--${name}\\s+([^\\s]*)`));
    if (!m) return '';
    return m[1].replace(/^"(.*)"$/, '$1').trim();
  };
  const nums = (raw) => String(raw).split(',').map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
  return {
    chain: nums(pick('chain')),
    hosts: nums(pick('hosts')),
    images: String(pick('images')).split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && s !== '""'),
  };
}

/** 本模块在跑的看护进程(进程表是真相,登记表可能因并发写丢条目)。 */
export function liveWatchers(moduleDir = path.dirname(fileURLToPath(import.meta.url))) {
  return findNodeScriptProcesses({ scriptNames: ['cleanupWatch.mjs'], moduleDir });
}

/** 这个看护还盯着活的东西吗(链或宿主仍在 → 还在值班;全死 → 马上要退)。 */
export function watcherStillWatching(args = {}, procs = aliveProcesses()) {
  if (!args || !args.chain?.length) return false;
  return !hostGone({ chain: args.chain, hosts: args.hosts || [], images: args.images || [], procs });
}

/** 看护是否还"有主"(宿主或链上还有活进程)。 */
export function watcherAlive(w, procs = aliveProcesses()) {
  if (!w) return false;
  if (Number(w.hostPid) && procs.has(Number(w.hostPid))) return true;
  return (w.chain || []).some((p) => procs.has(Number(p)));
}

/**
 * 拉起看护(会话开始时调用)。已有看护在盯同一个宿主就不重复拉。
 * 返回 { started, pid, hostPid, reason }。
 */
export function startWatcher({ onInfo = () => {}, logPath = path.join(DATA_DIR, 'cleanup-watch.log') } = {}) {
  const procs = aliveProcesses();
  // 进程表是真相(登记表会因并发写丢条目):已有**还在值班**的看护就不重复拉。
  // 值班判定 = 它盯的链/宿主还活着;链已死的看护马上要自退,此时必须拉新的接上,
  // 否则旧看护卸模型时会把新会话的模型一起卸掉。
  const running = liveWatchers();
  const onDuty = running.filter((w) => watcherStillWatching(parseWatcherArgs(w.cmd), procs));
  // 已该退的看护(链死)直接扫杀:旧版看护因全局兜底永不退出,只能手动清(实测堆 63 个/2.8GB)
  for (const w of running) {
    if (onDuty.some((d) => d.pid === w.pid)) continue;
    try { process.kill(w.pid); onInfo(`[cleanup] 已清退失效看护 ${w.pid}`); } catch { /* 已退出 */ }
  }
  if (onDuty.length) {
    return { started: false, reason: '已有看护在盯' };
  }
  // 剪掉已死的登记条目(留着只会挡路)
  for (const w of readWatchers()) {
    if (!procs.has(Number(w.pid))) removeWatcher(w.pid);
  }
  const tree = procTree();
  const chain = ancestorChain(process.pid, tree);
  if (!chain.length) {
    onInfo('[cleanup] 认不出宿主进程链,本会话不拉看护(退出后模型靠空闲时限自退)');
    return { started: false, reason: '无进程链' };
  }
  const hosts = findHostPids(chain);
  const images = findHostImages(chain);
  const pids = chain.map((c) => c.pid);
  const child = spawnLogged(path.join(here, 'cleanupWatch.mjs'), logPath, here, [
    '--chain', pids.join(','),
    '--hosts', hosts.join(','),
    '--images', images.join(','),
  ]);
  addWatcher({ pid: child.pid, hostPid: hosts[hosts.length - 1] || 0, chain: pids });
  onInfo(`[cleanup] 已拉起关闭看护(pid ${child.pid}${hosts.length ? `,宿主 ${images.join('/')} ${hosts.join('/')}` : ''}),宿主退出即卸本地模型`);
  return { started: true, pid: child.pid, hostPid: hosts[hosts.length - 1] || 0, reason: '' };
}

/** 看护主体:宿主退出即卸本地模型(没有别的会话在看护时才卸)。 */
async function watch({ chain = [], hosts = [], images = [], maxMs = 30 * 24 * 3600 * 1000 } = {}) {
  const { releaseAllModels } = await import('./cleanup.mjs');
  const t0 = Date.now();
  let streak = 0;
  while (Date.now() - t0 < maxMs) {
    const procs = aliveProcesses();
    if (hostGone({ chain, hosts, images, procs })) {
      streak += 1;
      if (streak >= DEAD_STREAK) break;
    } else {
      streak = 0;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  removeWatcher(process.pid);
  // 还有别的看护在值班 → 它们负责收尾,本次不卸(模型是共享资源)
  const procs = aliveProcesses();
  const others = liveWatchers().filter((w) => Number(w.pid) !== process.pid);
  const onDuty = others.filter((w) => watcherStillWatching(parseWatcherArgs(w.cmd), procs));
  if (onDuty.length) {
    console.error('[cleanup] 宿主已退出,但还有别的会话在用本地模型,本次不卸');
    return;
  }
  const r = await releaseAllModels({ onInfo: console.error });
  console.error(`[cleanup] 宿主已退出:卸载 ${r.unloaded.length} 个 Ollama 模型${r.stoppedResident ? ' + 停常驻进程' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const argOf = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : '';
  };
  const nums = (raw) => String(raw).split(',').map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
  const unquote = (raw) => String(raw).replace(/^"(.*)"$/, '$1').trim();
  const chain = nums(unquote(argOf('--chain')));
  const hosts = nums(unquote(argOf('--hosts')));
  const images = unquote(argOf('--images')).split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && s !== '""');
  const maxHours = Number(argOf('--max-hours')) || 30 * 24;
  // ⚠️ images 空就是空,**不回退 HOST_IMAGES**(2026-11-08 实弹修):回退等于把"机器上还有
  // 任意 zcode.exe 就算宿主活着"的全局兜底又请回来 → 看护在宿主已退时永不退出,
  // 每次会话再拉一个 → 实测堆积 63 个看护、2.8GB 内存(空转 600+ CPU 秒)。
  await watch({ chain, hosts, images, maxMs: maxHours * 3600 * 1000 });
  process.exit(0);
}
