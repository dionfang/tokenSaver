#!/usr/bin/env node
/**
 * 本地模型清理(2026-11-08):把"本工具拉起的模型"在不该留着的时候卸干净。
 *
 * 两条路径:
 *   ollama —— keep_alive:0 卸载(Ollama 立刻释放显存);只卸登记表 + 当前配置 + 向量元数据里那几个,
 *             用户自己 pull 的聊天模型不碰。
 *   local  —— 停常驻进程(transformers.js 的嵌入/精排/决策三件套随之释放显存与内存);
 *             常驻装的模型与当前配置对不上(切过模型)时先停掉,由预热按新配置重拉。
 *
 * 两个入口:
 *   releaseStaleModels() 会话开始时跑 —— 切换模型/切换路径后,把切换前拉起的模型卸掉。
 *   releaseAllModels()  最后一个会话结束时跑 —— 宿主(ZCode 等)关闭后全部及时清理。
 *
 * 独立运行:node cleanup.mjs [--all|--stale|--status](默认 --stale)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, MODULE_DIR, loadConfig, decisionLocalWanted } from './config.mjs';
import { readRegistry, clearRegistry } from './warmedRegistry.mjs';
import { sameOllamaName, unloadOllamaModel, resolveBase, readLastWarmed } from './ollamaGuard.mjs';
import { stopLocalResident } from './localResident.mjs';
import { readVectorMeta } from './vectorStore.mjs';

/** 当前配置下"应该继续驻留"的 Ollama 模型名。local 路径不占 Ollama ⇒ 空表。 */
export function keepOllamaNames(cfg = null) {
  const c = cfg || loadConfig();
  if (c.modelIn !== 'ollama') return [];
  const m = c.models || {};
  const names = [m.embedding, m.reranker];
  if (decisionLocalWanted(c)) names.push(m.decision);
  return [...new Set(names.filter(Boolean).map(String))];
}

/** 本工具可能拉起过的 Ollama 模型名:登记表 ∪ 上次预热记录 ∪ 当前配置 ∪ 向量元数据里的嵌入模型。 */
export function knownOllamaNames(cfg = null) {
  const c = cfg || loadConfig();
  const reg = readRegistry();
  const prev = readLastWarmed() || {};
  const m = c.models || {};
  const vec = readVectorMeta('ollama');
  return [...new Set([
    ...reg.ollama,
    prev.embedding, prev.reranker, prev.decision,
    m.embedding, m.reranker, m.decision,
    vec?.model,
  ].filter(Boolean).map(String))];
}

/**
 * 该卸哪些(纯函数,便于测试):
 *   known ∩ running,再扣掉 keep 里还需要的 —— 只卸"我们拉起过的、且现在不需要的"。
 */
export function staleOllamaNames({ known = [], running = [], keep = [] } = {}) {
  const out = [];
  for (const name of running) {
    if (!name) continue;
    if (!known.some((k) => sameOllamaName(k, name))) continue;
    if (keep.some((k) => sameOllamaName(k, name))) continue;
    out.push(name);
  }
  return out;
}

/** Ollama 当前驻留的模型名(/api/ps);服务不可达时当空表(没有要卸的)。 */
export async function runningOllamaNames() {
  try {
    const resp = await fetch(`${resolveBase()}/api/ps`, { signal: AbortSignal.timeout(3000) });
    const j = await resp.json();
    return (j.models || []).map((m) => m.name || m.model).filter(Boolean);
  } catch {
    return [];
  }
}

/** 常驻进程状态文件(本地 transformers.js 三件套的加载记录)。 */
export function residentState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.local-resident.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 常驻进程装的模型与当前配置是否一致(切换过模型就不一致)。没有常驻进程 ⇒ 视为一致。
 *  state 可注入(测试密闭):真实机器上常驻可能正在跑,直读 DATA_DIR 会让密闭测试随环境漂移。 */
export function residentMatchesConfig(cfg = null, state = residentState()) {
  const c = cfg || loadConfig();
  const st = state;
  if (!st) return true;
  const m = c.models || {};
  const wantDecision = decisionLocalWanted(c) ? m.localDecision : null;
  return st.embedding === m.localEmbedding && st.reranker === m.localReranker && st.decision === wantDecision;
}

/** 停常驻进程(有才停);返回是否真的停了。 */
export async function stopResident(onInfo = () => {}) {
  if (!residentState()) return false;
  await stopLocalResident();
  onInfo('[cleanup] 本地常驻进程已停(transformers.js 模型随之释放)');
  return true;
}

/**
 * 扫杀本模块脚本的孤儿进程(2026-11-08 实测修缺):
 * 状态文件只记最后一个 pid——反复切换模型/路径后,先前拉起的常驻/看护若状态被覆盖或删除
 * 就再没人杀(实测 33 个常驻孤儿吃掉 ~22GB 内存)。按"命令行含本模块路径 + 目标脚本名"扫杀,
 * keepPid 之外全杀。匹配用 includes(命令行反斜杠归一为斜杠),不用正则(转义坑,实测踩过)。
 */
export function sweepOrphanScripts({ scripts = ['localResident.mjs'], keepPid = 0, moduleDir = MODULE_DIR, onInfo = () => {} } = {}) {
  const dir = String(moduleDir || '').split(path.sep).join('/');
  const found = [];
  try {
    if (process.platform === 'win32') {
      const filters = scripts.map((s) => `CommandLine LIKE '%${s}%'`).join(' OR ');
      const q = `Get-CimInstance Win32_Process -Filter "Name='node.exe' AND (${filters})" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
      const r = spawnSync('powershell', ['-NoProfile', '-Command', q], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1 << 24 });
      const arr = JSON.parse(String(r.stdout || '[]').trim() || '[]');
      const list = Array.isArray(arr) ? arr : [arr];
      for (const p of list) {
        const pid = Number(p && p.ProcessId);
        if (!pid || pid === process.pid || pid === keepPid) continue;
        const cmd = String(p.CommandLine || '').split(path.sep).join('/');
        if (!cmd.includes(dir)) continue;
        if (!scripts.some((s) => cmd.includes(s))) continue;
        found.push(pid);
      }
    } else {
      const r = spawnSync('pgrep', ['-f', scripts.join('|')], { encoding: 'utf8', timeout: 5000 });
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (!pid || pid === process.pid || pid === keepPid) continue;
        let cmd = '';
        try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
        const norm = cmd.split(path.sep).join('/');
        if (!norm.includes(dir) || !scripts.some((s) => norm.includes(s))) continue;
        found.push(pid);
      }
    }
  } catch { /* 枚举失败就放弃(fail-open,下轮自愈) */ }
  let killed = 0;
  for (const pid of found) {
    try { process.kill(pid); killed += 1; onInfo(`[cleanup] 已扫杀孤儿进程 ${pid}`); } catch { /* 已退出 */ }
  }
  return { found, killed };
}

/**
 * 会话开始时清"切换前拉起的模型"(切换模型/切换路径后立即生效)。
 * 与预热解耦:即使预热随后失败(比如 Ollama 没起),旧驻留也已经卸掉了。
 */
export async function releaseStaleModels({ onInfo = () => {}, config = null } = {}) {
  const cfg = config ? { ...loadConfig(), ...config } : loadConfig();
  // 孤儿清扫(2026-11-08):状态文件外的常驻进程没有任何机制能杀到——这里统一扫。
  //   ollama 路径:常驻全都不该在,全扫;
  //   local 路径:保留状态文件里那个合法常驻,只扫它之外的孤儿。
  const keepPid = cfg.modelIn === 'local' ? (residentState()?.pid || 0) : 0;
  sweepOrphanScripts({ scripts: ['localResident.mjs'], keepPid, onInfo });
  const keep = keepOllamaNames(cfg);
  const known = knownOllamaNames(cfg);
  const running = await runningOllamaNames();
  const stale = staleOllamaNames({ known, running, keep });
  for (const name of stale) await unloadOllamaModel(name, onInfo);
  let stoppedResident = false;
  if (cfg.modelIn === 'local') {
    // local 路径:常驻装的是旧模型才停(装的是当前模型就留着复用)
    if (!residentMatchesConfig(cfg)) {
      stoppedResident = await stopResident(onInfo);
      onInfo('[cleanup] 常驻进程装的模型与当前配置不一致,已停掉待按新模型重拉');
    }
  } else {
    // 切到 ollama 路径:transformers.js 常驻没用了,停掉释放显存
    stoppedResident = await stopResident(onInfo);
  }
  return { unloaded: stale, stoppedResident, keep };
}

/**
 * 全部清理:宿主关闭(最后一个会话结束)时调用。
 * Ollama 驻留全卸 + 常驻进程停掉 + 登记表清空(下次预热重新登记)。
 */
export async function releaseAllModels({ onInfo = () => {}, config = null } = {}) {
  const cfg = config ? { ...loadConfig(), ...config } : loadConfig();
  const known = knownOllamaNames(cfg);
  const running = await runningOllamaNames();
  const targets = running.filter((name) => known.some((k) => sameOllamaName(k, name)));
  for (const name of targets) await unloadOllamaModel(name, onInfo);
  const stoppedResident = await stopResident(onInfo);
  // 全清时不留任何常驻孤儿(含状态文件已失效的那些)
  sweepOrphanScripts({ scripts: ['localResident.mjs'], keepPid: 0, onInfo });
  clearRegistry();
  return { unloaded: targets, stoppedResident };
}

/** 现状快照(给 --status / 排查用)。 */
export async function cleanupStatus({ config = null } = {}) {
  const cfg = config ? { ...loadConfig(), ...config } : loadConfig();
  const known = knownOllamaNames(cfg);
  const running = await runningOllamaNames();
  const st = residentState();
  return {
    backend: cfg.modelIn,
    keep: keepOllamaNames(cfg),
    known,
    running,
    stale: staleOllamaNames({ known, running, keep: keepOllamaNames(cfg) }),
    resident: st ? { pid: st.pid, embedding: st.embedding, reranker: st.reranker, decision: st.decision, matches: residentMatchesConfig(cfg) } : null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const mode = process.argv.slice(2).find((a) => ['--all', '--stale', '--status'].includes(a)) || '--stale';
  if (mode === '--status') {
    console.log(JSON.stringify(await cleanupStatus(), null, 2));
  } else if (mode === '--all') {
    const r = await releaseAllModels({ onInfo: console.error });
    console.error(`[cleanup] 全部清理完成:卸载 ${r.unloaded.length} 个 Ollama 模型${r.stoppedResident ? ' + 停常驻进程' : ''}`);
  } else {
    const r = await releaseStaleModels({ onInfo: console.error });
    console.error(`[cleanup] 切换前拉起的模型已卸:${r.unloaded.length ? r.unloaded.join(', ') : '无'}`);
  }
}
