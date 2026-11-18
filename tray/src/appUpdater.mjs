/**
 * 应用自更新(C6=b,阶段6 2026-11-19):**零 npm 依赖**手写更新器(§18-E1 红线:tray 运行零依赖,
 * 不用 electron-updater——npm 包 import 违禁,门禁 importBan 拦下后按红线重写)。
 * 通道=crisvado.com/tokensaver/updates/(generic latest.yml,与 electron-builder publish 同形态)。
 *
 * 流(与 electron-updater 语义对齐,零件复用本仓):
 *   1. 拉 latest.yml(no-cache)→手写 YAML 微解析(只取 version/path/sha512/size/releaseDate,平 str 键值)
 *   2. compareVersions(manifest.mjs)比对:更新仅当 remote>local
 *   3. 下载安装包到 %LOCALAPPDATA%/TokenSaver/updates/<file>(utils downloader 不含 exe 场景,
 *      这里直接 httpRequest 流式写 .part→sha512 门通过原子改名;进度推面板 base 行)
 *   4. 就绪后提示;退出时装=spawn 安装包(NSIS /S 静默覆盖安装,继承用户级 env)
 *     ——runAfterFinish 语义在安装器内已有;此处「退出时装」由本模块在 app.quit 前 spawn。
 * 校验链:sha512(latest.yml 声明)→PASS 才认可文件;版本号非升不弹(防降级回滚攻击)。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, dialog } from 'electron';
import { compareVersions } from './manifest.mjs';
import { httpRequest } from './downloader.mjs';

const FEED = 'https://crisvado.com/tokensaver/updates/latest.yml';
let busy = false;
let readyInfo = null; // {version, file, size, releaseDate} 就绪态(退出时装消费)

/** 平面 YAML 微解析(latest.yml 实际形态:标量+单层 files 列表 url/sha512/size)。非通用 YAML,勿挪用。 */
function parseLatestYml(text) {
  const out = { files: [] };
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = raw.match(/^(\s*)-?\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, ind, k, v] = m;
    if (ind === '') { cur = null; if (v) out[k] = v.replace(/^['"]|['"]$/g, ''); continue; } // files: 之类无值行跳过,不覆盖数组
    if (k === 'url' && v) { cur = { url: v }; out.files.push(cur); }
    else if (cur && ['sha512', 'size'].includes(k)) cur[k] = v;
  }
  return out;
}

function updatesDir() {
  const dir = path.join(app.getPath('localData'), 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 下载+sha512 门。返回 {ok,file} 或 {ok:false,error}。 */
async function fetchInstaller(info, onEvent) {
  const final = path.join(updatesDir(), info.path);
  const part = final + '.part';
  fs.mkdirSync(path.dirname(final), { recursive: true });
  const { status, res } = await httpRequest(FEED.replace(/[^/]+$/, '') + info.path, {});
  if (status !== 200) return { ok: false, error: `安装包 HTTP ${status}` };
  const total = Number(info.size) || null;
  const h = crypto.createHash('sha512');
  let done = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    res.on('data', (c) => {
      h.update(c); done += c.length; out.write(c);
      if (total) onEvent?.({ phase: 'download', pct: Math.min(100, Math.round((done / total) * 100)), bytesDone: done, bytesTotal: total });
    });
    res.on('end', () => out.end(resolve));
    res.on('error', reject);
    out.on('error', reject);
  });
  const b64 = h.digest('base64');
  if (info.sha512 && b64 !== info.sha512) {
    try { fs.unlinkSync(part); } catch { /* 尽力 */ }
    return { ok: false, error: `sha512 校验失败(期望 ${String(info.sha512).slice(0, 12)}… 实得 ${b64.slice(0, 12)}…)` };
  }
  try { fs.renameSync(part, final); } catch (e) { return { ok: false, error: `安装包落盘失败:${e.message}` }; }
  return { ok: true, file: final };
}

/** 检查+下载。fromMenu=true 时结果弹窗;静默模式错误只推面板。 */
export async function checkAppUpdate({ onEvent, fromMenu = false } = {}) {
  if (busy) return { outcome: 'busy', message: '已有应用更新检查在跑' };
  busy = true;
  try {
    onEvent?.({ phase: 'manifest', message: '检查应用更新…' });
    const { status, res } = await httpRequest(FEED, {});
    let text = '';
    res.setEncoding('utf8');
    for await (const c of res) text += c;
    if (status !== 200) throw new Error(`latest.yml HTTP ${status}`);
    const info = parseLatestYml(text);
    const local = app.getVersion();
    if (!info.version || compareVersions(info.version, local) <= 0) {
      onEvent?.({ phase: 'result', outcome: 'already-latest', message: `应用已是最新版本(${local})` });
      if (fromMenu) dialog.showMessageBox({ message: `应用已是最新版本(${local})。`, buttons: ['知道了'] });
      return { outcome: 'already-latest', version: local };
    }
    onEvent?.({ phase: 'manifest', message: `发现新版本 ${info.version},下载中…` });
    const f = await fetchInstaller({ ...info, path: info.path || info.files[0]?.url }, onEvent);
    if (!f.ok) throw new Error(f.error);
    readyInfo = { version: info.version, file: f.file, size: info.size, releaseDate: info.releaseDate };
    const msg = `新版本 ${info.version} 已就绪,退出时自动安装`;
    onEvent?.({ phase: 'result', outcome: 'updated', message: msg });
    if (fromMenu) dialog.showMessageBox({ message: msg + '。', buttons: ['知道了'] });
    return { outcome: 'updated', version: info.version };
  } catch (e) {
    const msg = `应用更新检查失败:${String(e?.message || e).slice(0, 120)}`;
    onEvent?.({ phase: 'result', outcome: 'error', message: msg });
    if (fromMenu) dialog.showErrorBox('检查应用更新', String(e?.message || e).slice(0, 200));
    return { outcome: 'error', message: msg };
  } finally { busy = false; }
}

/** 托盘就绪后 30s 静默检查(避开启动高峰;失败不打扰)。 */
export function scheduleBackgroundCheck(onEvent) {
  setTimeout(() => { checkAppUpdate({ onEvent }).catch(() => {}); }, 30_000).unref?.();
}

/** 退出时装(主进程 before-quit 调):就绪态才 spawn;NSIS 静默 /S 继承当前用户 env。 */
import { execFile } from 'node:child_process';
export function installOnQuit() {
  if (!readyInfo) return false;
  try {
    execFile(readyInfo.file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch { return false; }
}
