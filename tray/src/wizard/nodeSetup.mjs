/**
 * Node 运行时检测准入制(tray 方案 §17.1-7 终案/§18-C7,2026-11-15 M2):
 * PATH 上能解析 node 且版本 ≥ 下限 → 直接接入不碰 PATH;缺失/过低/nvm 未切 alias 一律视同缺失
 * → 走清单下载官方 Node zip 落 data/runtime 并「追加」用户 PATH(HKCU Environment,追加不前置,
 * PowerShell SetEnvironmentVariable 自带 WM_SETTINGCHANGE 广播;披露「可随时在设置移除」由 UI 承担)。
 * 钩子 command 恒为裸 node(两分支都靠 PATH 解析);托盘自身 spawn 用绝对路径(pickNodeBin)。
 * execFile 依赖注入(单测零真实注册表写入);不 import code-index/**。
 */
import fs from 'node:fs';
import path from 'node:path';

export const MIN_NODE_MAJOR = 20;

const sh = (execFile, cmd, args) => new Promise((resolve) => {
  // S14-3(20261119 夜审):15s 超时——refreshPathForNodeDiscovery 经它连发两次 powershell,AV 扫描/重载挂死时"重新自检"不得无上限同步等待
  execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 15_000 }, (e, stdout, stderr) => resolve({ ok: !e, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

/** node -v 输出解析(纯):'v22.11.0\n' → '22.11.0'。 */
export function parseNodeVersion(out) {
  const m = String(out || '').trim().match(/^v(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** PATH node 达标检测(§17.1-7 前半):返回 {ok, version, bin};探不到/版本低 → ok:false。 */
export async function detectNodeQualification({ execFile, minMajor = MIN_NODE_MAJOR } = {}) {
  const r = await sh(execFile, 'node', ['-v']);
  const version = parseNodeVersion(r.stdout);
  if (!r.ok || !version) return { ok: false, version: null, reason: 'not-on-path', bin: 'node' };
  const ok = Number(version.split('.')[0]) >= minMajor;
  return { ok, version, reason: ok ? null : 'below-minimum', bin: 'node' };
}

/** 用户 PATH 是否已含目录(纯,分号分段忽略大小写比较;支持 %VAR% 引用不做展开判断)。 */
export function pathContainsDir(userPath, dir) {
  const segs = String(userPath || '').split(';').map((s) => s.trim().replace(/[\\/]+$/, '')).filter(Boolean);
  const want = String(dir || '').trim().replace(/[\\/]+$/, '');
  return segs.some((s) => s.toLowerCase() === want.toLowerCase());
}

/** 追加用户 PATH(§17.1-7 后半):已含则跳过;未含则 PowerShell SetEnvironmentVariable(...,'User')
 *  ——写 HKCU Environment 并广播 WM_SETTINGCHANGE;追加不前置。返回 {changed, userPath}。 */
export async function appendDirToUserPath(dir, { execFile } = {}) {
  const cur = (await sh(execFile, 'powershell', ['-NoProfile', '-Command', '[Environment]::GetEnvironmentVariable("PATH","User")'])).stdout.trim();
  if (pathContainsDir(cur, dir)) return { changed: false, userPath: cur };
  const next = cur ? `${cur};${dir}` : dir;
  const esc = (s) => s.replace(/'/g, "''");
  const set = await sh(execFile, 'powershell', ['-NoProfile', '-Command',
    `[Environment]::SetEnvironmentVariable('PATH','${esc(next)}','User');[Environment]::GetEnvironmentVariable('PATH','User')`]);
  if (!set.ok) return { changed: false, error: set.stderr.slice(-200) || 'SetEnvironmentVariable 失败' };
  return { changed: true, userPath: set.stdout.trim() };
}

/** 展开 %VAR%(纯):查注入 env;未定义原样保留(死段对 PATH 无害)。 */
export function expandEnvRefs(v, env = process.env) {
  return String(v || '').replace(/%([^%;]+)%/g, (m, k) => { const val = env[k]; return val != null ? String(val) : m; });
}

/** 合并 PATH 段(纯):fresh 段在前、current 段补尾;忽略大小写去重、去空、去尾斜杠。 */
export function mergePathSegments(fresh, current) {
  const out = []; const seen = new Set();
  for (const seg of [...(Array.isArray(fresh) ? fresh : []), ...(Array.isArray(current) ? current : [])]) {
    const s = String(seg || '').trim().replace(/[\\/]+$/, '');
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

/** 标准 Node 安装目录候选(MSI 默认位:Program Files(x64/x86)+每用户 LOCALAPPDATA\Programs\nodejs)。 */
export function standardNodeDirs(env = process.env) {
  const raw = [];
  if (env.ProgramFiles) raw.push(path.join(env.ProgramFiles, 'nodejs'));
  if (env['ProgramFiles(x86)']) raw.push(path.join(env['ProgramFiles(x86)'], 'nodejs'));
  if (env.LOCALAPPDATA) raw.push(path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'));
  return [...new Set(raw.map((d) => { try { return path.resolve(d); } catch { return d; } }))];
}

/** 复检前刷新 node 可见性(2026-11-19 修「装完 Node 点重新自检仍红」的 env 快照层):
 *  进程 PATH 是启动时快照,安装器写注册表+广播 WM_SETTINGCHANGE 进不了已运行进程——重读
 *  Machine/User PATH(PowerShell;UTF-8 输出防中文用户名 mojibake,.NET 读注册表已展开 %VAR%,
 *  再过 expandEnvRefs 兜底)+ 直探标准安装目录(装了但 PATH 没接上的形态)。
 *  追加进 env.PATH(不删,幂等);非 win32 no-op;任何失败只返回不抛。 */
export async function refreshPathForNodeDiscovery({ execFile, env = process.env, existsSync = fs.existsSync } = {}) {
  if (process.platform !== 'win32') return { ok: true, changed: false, skipped: 'non-win32' };
  try {
    const read = async (scope) => {
      const r = await sh(execFile, 'powershell', ['-NoProfile', '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Environment]::GetEnvironmentVariable('Path','${scope}')`]);
      if (!r.ok) return null;
      const v = expandEnvRefs(r.stdout.trim(), env);
      return v ? v.split(';') : null;
    };
    const machine = await read('Machine');
    const user = await read('User');
    const fresh = [];
    for (const segs of [machine, user]) if (segs) fresh.push(...segs);
    for (const d of standardNodeDirs(env)) {
      try { if (existsSync(path.join(d, 'node.exe'))) fresh.push(d); } catch { /* 尽力 */ }
    }
    if (!fresh.length) return { ok: false, changed: false, error: '注册表与标准目录均未取到 PATH 增量' };
    const cur = String(env.PATH || env.Path || '');
    const next = mergePathSegments(fresh, cur.split(';')).join(';');
    if (next === cur) return { ok: true, changed: false };
    env.PATH = next;
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, changed: false, error: String(e?.message || e) };
  }
}

/** 托盘自身 spawn 用的 node(§17.1-7:检测胜出者优先,不依赖 PATH):达标 node → 'node';
 *  否则若 data/runtime/node/node.exe 在(下载解压后)用绝对路径;再退 'node'。 */
export function pickNodeBin({ dataDir, qualified, exists = fs.existsSync }) {
  if (qualified?.ok) return 'node';
  const managed = path.join(dataDir || '', 'runtime', 'node', 'node.exe');
  try { if (exists(managed)) return managed; } catch { /* 尽力 */ }
  return 'node';
}

/** 在目录树中找 node.exe(官方 zip 顶层常为 node-vXX-win-x64/)。 */
export function findNodeExe(dir, { readdirSync = fs.readdirSync } = {}) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isFile() && ent.name.toLowerCase() === 'node.exe') return p;
    if (ent.isDirectory()) {
      const hit = findNodeExe(p, { readdirSync });
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 把官方 Node zip 解到 data/runtime/node/(内含 node.exe)。
 * Windows 用 Expand-Archive;解压后若 exe 在子目录则把该子目录挪成 destDir。
 * 无 zip / 无 exe → ok:false(禁止「只改 PATH、实际没有 node.exe」假就绪)。
 */
export async function extractNodeZip(zipPath, destDir, {
  execFile,
  existsSync = fs.existsSync,
  mkdirSync = fs.mkdirSync,
  rmSync = fs.rmSync,
  renameSync = fs.renameSync,
  readdirSync = fs.readdirSync,
} = {}) {
  if (!existsSync(zipPath)) return { ok: false, error: `缺少 Node zip:${zipPath}` };
  const staging = `${destDir}.extracting`;
  try { rmSync(staging, { recursive: true, force: true }); } catch { /* 尽力 */ }
  mkdirSync(staging, { recursive: true });
  const esc = (s) => String(s).replace(/'/g, "''");
  const exp = await sh(execFile, 'powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(staging)}' -Force`]);
  if (!exp.ok) return { ok: false, error: exp.stderr.slice(-200) || 'Expand-Archive 失败' };
  const exe = findNodeExe(staging, { readdirSync });
  if (!exe) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* 尽力 */ }
    return { ok: false, error: 'Node zip 内未找到 node.exe' };
  }
  const root = path.dirname(exe);
  try { rmSync(destDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
  try {
    renameSync(root, destDir);
  } catch (e) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* 尽力 */ }
    return { ok: false, error: `解压落位失败:${String(e.message || e).slice(0, 120)}` };
  }
  try { rmSync(staging, { recursive: true, force: true }); } catch { /* 尽力 */ }
  const finalExe = path.join(destDir, 'node.exe');
  if (!existsSync(finalExe)) return { ok: false, error: '解压后 runtime/node/node.exe 仍不存在' };
  return { ok: true, bin: finalExe };
}

/** 确保托管 Node 可用:已有 node.exe → 追加 PATH;仅有 zip → 先解压;都没有 → 失败。 */
export async function ensureManagedNodeRuntime({ dataDir, execFile, zipRel = path.join('runtime', 'node.zip') } = {}) {
  const dir = path.join(dataDir || '', 'runtime', 'node');
  const exe = path.join(dir, 'node.exe');
  if (!fs.existsSync(exe)) {
    const zip = path.join(dataDir || '', zipRel);
    const er = await extractNodeZip(zip, dir, { execFile });
    if (!er.ok) return er;
  }
  if (!fs.existsSync(exe)) return { ok: false, error: '托管 Node 未就绪(无 node.exe)' };
  const r = await appendDirToUserPath(dir, { execFile });
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, changed: r.changed, bin: exe };
}
