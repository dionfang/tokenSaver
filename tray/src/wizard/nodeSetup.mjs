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
  execFile(cmd, args, { windowsHide: true, encoding: 'utf8' }, (e, stdout, stderr) => resolve({ ok: !e, stdout: String(stdout || ''), stderr: String(stderr || '') }));
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

/** 托盘自身 spawn 用的 node(§17.1-7:检测胜出者优先,不依赖 PATH):达标 node → 'node';
 *  否则若 data/runtime/node/node.exe 在(下载解压后)用绝对路径;再退 'node'。 */
export function pickNodeBin({ dataDir, qualified, exists = fs.existsSync }) {
  if (qualified?.ok) return 'node';
  const managed = path.join(dataDir || '', 'runtime', 'node', 'node.exe');
  try { if (exists(managed)) return managed; } catch { /* 尽力 */ }
  return 'node';
}
