/**
 * 应用自更新(C6=b,阶段6 2026-11-19):**零 npm 依赖**手写更新器(§18-E1 红线:tray 运行零依赖,
 * 不用 electron-updater——npm 包 import 违禁,门禁 importBan 拦下后按红线重写)。
 * 通道=crisvado.com/tokensaver/updates/(generic latest.yml,与 electron-builder publish 同形态)。
 *
 * 流(与 electron-updater 语义对齐,零件复用本仓):
 *   1. 拉 latest.yml(no-cache)→手写 YAML 微解析(只取 version/path/sha512/size/releaseDate,平 str 键值)
 *   2. compareVersions(manifest.mjs)比对:更新仅当 remote>local
 *   3. 下载安装包到 %LOCALAPPDATA%/TokenSaver/updates/<file>:
 *      **差量优先(2026-11-19 补)**:本地缓存有上一版安装包+其 blockmap 时,拉新 blockmap 逐块比对
 *      (electron-builder v2:checksums+sizes 铺满全文件),复用块从旧包读、新块按 HTTP Range 拉段,
 *      按序重组出完整新包;任何一步失败(旧件缺失/Range 不生效/长度不符/重组 sha 不符)自动退回整包下载。
 *      差量省的是传输量(实测 0.1.0→0.2.0 新块 0.9MB、约占 0.4%,37 块/9 个 Range 段),完整性门与全量完全一致。
 *   4. sha512(latest.yml 声明)→PASS 才认可文件(fail-closed);版本号非升不弹(防降级回滚攻击)。
 *   5. 就绪后提示;退出时装=spawn 安装包(NSIS /S 静默覆盖安装,继承用户级 env)
 *     ——runAfterFinish 语义在安装器内已有;此处「退出时装」由本模块在 app.quit 前 spawn。
 * 缓存策略:每次成功下载后缓存该版 blockmap(下次差量的旧侧);安装包与 blockmap 都留最新 2 个(当前+上一版=差量源/回滚)。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { app, dialog } from 'electron';
import { compareVersions } from './manifest.mjs';
import { httpRequest } from './downloader.mjs';

const FEED = 'https://crisvado.com/tokensaver/updates/latest.yml';
// 差量新块占比超过此值时直接全量(请求数/复杂度不划算;也封顶重组内存缓冲)
const DELTA_MAX_RATIO = 0.7;
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
  // S14-1③(20261119 夜审):归位 TokenSaver 专属目录(与头注/安装器布局对齐,不污染 LOCALAPPDATA 根)。
  // 20261120 修复(测试机实弹「Failed to get 'localData' path」):app.getPath('localData') 不是 Electron
  // 合法 key(合法=userData/appData/sessionData/logs/temp…),真实环境直接抛错⇒检查更新整链瘫痪。
  // 改与 packedFallbackLayout 同口径:win32 取 %LOCALAPPDATA%(env 缺省回退 homedir 拼接),非 win32 归 ~/.tokensaver。
  const dir = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TokenSaver', 'updates')
    : path.join(os.homedir(), '.tokensaver', 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- 开机自激活(20261120 用户裁定):托盘常驻不退出+关机型用户的升级闭环 ----------
// readyInfo 原只活内存⇒重启即忘;pending.json 把「已下载+已校验」落盘,托盘启动自检自装。
const pendingPath = (dir = null) => path.join(dir || updatesDir(), 'pending.json');
export function writePending(info, dir = null) {
  // S14-F2(20261120 夜审):原子单行 JSON 写(同目录 tmp+rename)——直写崩溃窗撕文件丢「已下载未安装」启动提示;
  // 自包含不抽公共函数(测试 grab-eval 按函数源码隔离验证,tray 红线零 code-index import 不破)。
  const file = pendingPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...info, at: new Date().toISOString() }) + '\n');
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 尽力 */ } throw e; }
}
export function clearPending(dir = null) {
  try { fs.unlinkSync(pendingPath(dir)); } catch { /* 本就不在 */ }
}
export function readPending(dir = null) {
  try { return JSON.parse(fs.readFileSync(pendingPath(dir), 'utf8')); } catch { return null; }
}
/** 纯判定(可测):pending 是否值得进入 sha 复验+安装。版本非升=clear(防降级/防重复装);缺字段=none。 */
export function pendingGate(pending, currentVersion, cmp = compareVersions) {
  if (!pending || !pending.version || !pending.file) return { action: 'none', reason: 'no-pending' };
  if (cmp(String(pending.version), String(currentVersion)) <= 0) return { action: 'clear', reason: 'version-not-newer' };
  return { action: 'check', reason: 'newer' };
}

/** 20261120 用户裁定:取消全部静默安装(退出装机/开机自装机),改为「下载完成→弹窗确认→拉起可见安装向导」。
 *  可见向导(无 /S)由用户走完/确认,不依赖各客户端环境的静默行为。
 *  3 秒延时放 detached cmd 内(ping -n 3),不放 Node setTimeout:宿主 app.quit() 会把待发定时器吞掉
 *  (20261121 测试机实锤:点时退出但向导永不拉起),而 detached 子进程独立存活——该延时同时覆盖退出窗口,
 *  避免覆盖安装的 NSIS 文件替换与仍在退出中的 TokenSaver.exe 竞态。 */
function spawnInstaller(exe, { silent = false } = {}) {
  try {
    if (!exe || !fs.existsSync(exe)) return false; // 安装包被清/缺件时显式失败,调用方给用户可见错误
    const safe = String(exe).replaceAll('"', '""');
    const command = `ping 127.0.0.1 -n 3 >nul & start "" /wait "${safe}"${silent ? ' /S' : ''}`;
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    return true;
  } catch { return false; }
}

/** 启动自检(20261120 改口径):pending 存在且版本更新且文件在且 sha512 复验通过 ⇒ **不自动装**,
 *  返回 {prompt:true,...} 由调用方弹窗提示「有已下载未安装的新版」引导用户主动安装(可见向导);
 *  旧的「启动即静默装+退出本进程」已废(静默装在不同客户端环境异常,用户裁定取消)。
 *  任一不满足⇒false(含 clear 场景)。 */
export async function consumePendingAtStartup() {
  const pending = readPending();
  const gate = pendingGate(pending, app.getVersion());
  if (gate.action === 'clear') { clearPending(); return false; }
  if (gate.action !== 'check') return false;
  if (!fs.existsSync(pending.file)) { clearPending(); return false; }
  let shaOk = false;
  try { shaOk = !!pending.sha512 && (await sha512File(pending.file)) === pending.sha512; } catch { shaOk = false; }
  if (!shaOk) { clearPending(); return false; }
  return { prompt: true, version: pending.version, file: pending.file };
}

/** sha512(流式文件)→base64。差量重组与整包下载共用同一完整性门。 */
function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('base64')));
    s.on('error', reject);
  });
}

/** GET 整件收进 Buffer(blockmap 等小件用;非 200 抛错)。 */
async function httpGetBuffer(url, httpReq) {
  const { status, res } = await httpReq(url, { timeoutMs: 30_000 });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const cs = [];
  for await (const c of res) cs.push(c);
  return Buffer.concat(cs);
}

/**
 * blockmap 解析(electron-builder v2:gzip JSON {version,files:[{name,offset,checksums[],sizes[]}]})。
 * 块从 offset 起按 sizes 顺序铺满文件(实测 sum(sizes)===exe 字节数);checksums 为厂商摘要
 * (非 sha512,算法无需知晓——差量只做新旧清单字符串比对,完整性由整包 sha512 门兜底)。
 * 归一为 {version, base, blocks:[{checksum,size,offset}], total}。结构不符即抛(调用方退全量)。
 */
function parseBlockmap(buf) {
  const j = JSON.parse(zlib.gunzipSync(Buffer.from(buf)).toString('utf8'));
  const f = (j.files || [])[0];
  if (!f || !Array.isArray(f.checksums) || !Array.isArray(f.sizes)
    || f.checksums.length !== f.sizes.length || !f.checksums.length) throw new Error('blockmap 结构不符(缺 checksums/sizes)');
  const base = Number(f.offset) || 0;
  let off = base;
  const blocks = f.checksums.map((c, i) => {
    const size = Number(f.sizes[i]);
    if (!(size > 0)) throw new Error('blockmap 块大小非法');
    const b = { checksum: String(c), size, offset: off };
    off += size;
    return b;
  });
  return { version: Number(j.version) || 0, base, blocks, total: off - base };
}

/**
 * 差量计划:旧块按 (checksum,size) 建索引,新块逐块判「复用/下载」;连续下载块合并成一个 Range 段
 * (相邻改动常聚簇,合并后请求数从数百降到数十)。返回 {items,runs,deltaBytes,totalBytes} 或 null(不可差量)。
 * items 按新包块序:{from:旧包偏移|null, size};from=null 的块按序消费 runs 下载结果。
 */
function computeDeltaPlan(oldBm, newBm) {
  if (!oldBm || !newBm || oldBm.version !== newBm.version) return null;
  if (oldBm.base !== 0 || newBm.base !== 0) return null; // 块未铺满全文件时重组不成立,退全量
  const idx = new Map();
  for (const b of oldBm.blocks) { const k = b.checksum + '|' + b.size; if (!idx.has(k)) idx.set(k, b); }
  const items = []; const runs = []; let deltaBytes = 0; let cur = null;
  for (const b of newBm.blocks) {
    const old = idx.get(b.checksum + '|' + b.size);
    if (old) { items.push({ from: old.offset, size: b.size }); cur = null; continue; }
    items.push({ from: null, size: b.size });
    deltaBytes += b.size;
    if (cur && cur.offset + cur.size === b.offset) cur.size += b.size;
    else { cur = { offset: b.offset, size: b.size }; runs.push(cur); }
  }
  return { items, runs, deltaBytes, totalBytes: newBm.total };
}

/**
 * 差量下载+重组:①按 runs 发 HTTP Range(必须 206 且长度精确,否则抛→上层退全量);
 * ②按新包块序写 part:复用块从旧安装包流式读,新块从已下载段顺序切片。
 * 进度 bytesDone 对 totalBytes 计(下载段+复用块各计一次,不重复)。
 */
async function downloadDelta({ oldExe, plan, newUrl, partPath, httpReq, onEvent }) {
  const total = plan.totalBytes;
  let done = 0;
  const emit = () => onEvent?.({
    phase: 'download', pct: Math.min(100, Math.round((done / total) * 100)),
    bytesDone: done, bytesTotal: total, mode: 'delta', reusedBytes: total - plan.deltaBytes,
  });
  // ① 拉新块段
  const runBufs = [];
  for (const r of plan.runs) {
    const { status, res } = await httpReq(newUrl, { headers: { Range: `bytes=${r.offset}-${r.offset + r.size - 1}` }, timeoutMs: 60_000 });
    if (status !== 206) throw new Error(`Range 未生效(HTTP ${status})`);
    const cs = []; let n = 0;
    for await (const c of res) { cs.push(c); n += c.length; }
    if (n !== r.size) throw new Error(`块段长度不符(${n}≠${r.size})`);
    runBufs.push(Buffer.concat(cs));
    done += n; emit();
  }
  // ② 按序重组
  const out = fs.createWriteStream(partPath);
  const writeOut = (chunk) => new Promise((res2, rej2) => out.write(chunk, (e) => (e ? rej2(e) : res2())));
  let ri = 0; let ro = 0;
  try {
    for (const it of plan.items) {
      if (it.from != null) {
        for await (const c of fs.createReadStream(oldExe, { start: it.from, end: it.from + it.size - 1 })) await writeOut(c);
        done += it.size; emit(); // 复用块字节在此计入(新块字节已在①计入)
      } else {
        const buf = runBufs[ri].subarray(ro, ro + it.size);
        ro += it.size;
        if (ro >= runBufs[ri].length) { ri++; ro = 0; }
        await writeOut(buf);
      }
    }
    await new Promise((res2, rej2) => out.end((e) => (e ? rej2(e) : res2())));
  } catch (e) { out.destroy(); throw e; }
}

/** 整包下载→part(流式写,write 回调背压;差量不可用时的兜底路径)。 */
async function downloadFull({ url, partPath, total, httpReq, onEvent }) {
  const { status, res } = await httpReq(url, {});
  if (status !== 200) { res.resume?.(); return { ok: false, error: `安装包 HTTP ${status}` }; }
  const out = fs.createWriteStream(partPath);
  const writeOut = (chunk) => new Promise((res2, rej2) => out.write(chunk, (e) => (e ? rej2(e) : res2())));
  let done = 0;
  try {
    for await (const c of res) {
      done += c.length;
      await writeOut(c);
      if (total) onEvent?.({ phase: 'download', pct: Math.min(100, Math.round((done / total) * 100)), bytesDone: done, bytesTotal: total, mode: 'full' });
    }
    await new Promise((res2, rej2) => out.end((e) => (e ? rej2(e) : res2())));
  } catch (e) { out.destroy(); throw e; }
  return { ok: true };
}

/** 安装包清理:留最新 2 个(当前+上一版=差量源/回滚资产),更旧的删(尽力,失败不阻断)。 */
function pruneOldInstallers(dir, keepFile) {
  try {
    const keep = path.basename(keepFile);
    const exes = fs.readdirSync(dir).filter((f) => f.endsWith('.exe') && f !== keep)
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of exes.slice(1)) { try { fs.unlinkSync(path.join(dir, x.f)); } catch { /* 尽力 */ } }
  } catch { /* 尽力 */ }
}

/** blockmap 缓存与安装包同口径:留刚写入的这一版 + 上一版,更旧的删(尽力,失败不阻断)。 */
function pruneOldBlockmaps(bmDir, keepFile) {
  try {
    const keep = path.basename(keepFile);
    const files = fs.readdirSync(bmDir).filter((f) => f.endsWith('.json') && f !== keep)
      .map((f) => ({ f, t: fs.statSync(path.join(bmDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(1)) { try { fs.unlinkSync(path.join(bmDir, x.f)); } catch { /* 尽力 */ } }
  } catch { /* 尽力 */ }
}

/**
 * 差量上下文(检查更新时装配):旧安装包=updatesDir 里上一版 Setup exe(非已安装程序本体——
 * blockmap 覆盖的是安装包字节);旧 blockmap 取版本缓存,缺则向服务器要历史件(服务器不删旧版)。
 * 拿不到旧侧也返回 ctx(带 saveBmFile),让全量路径顺手缓存新 blockmap,下一次即可差量。
 */
async function prepareDeltaCtx(info, { appLike, httpReq, dir }) {
  if (!appLike.isPackaged) return null; // 开发态 exe 是 electron 本体,无差量语义
  const bmDir = path.join(dir, 'blockmaps');
  fs.mkdirSync(bmDir, { recursive: true });
  const oldVer = appLike.getVersion();
  const feedBase = FEED.replace(/[^/]+$/, '');
  // 上一版安装包名:用新 path 的版本段替换(自适应命名,不硬编码产品前缀)
  const oldName = path.basename(String(info.path || '').replace(info.version, oldVer));
  const oldExe = path.join(dir, oldName);
  const newBmUrl = feedBase + info.path + '.blockmap';
  const saveBmFile = path.join(bmDir, `${info.version}.json`);
  let oldBm = null;
  try { oldBm = JSON.parse(fs.readFileSync(path.join(bmDir, `${oldVer}.json`), 'utf8')); } catch { /* 无缓存 */ }
  if (!oldBm && fs.existsSync(oldExe)) {
    try {
      oldBm = parseBlockmap(await httpGetBuffer(feedBase + oldName + '.blockmap', httpReq));
      fs.writeFileSync(path.join(bmDir, `${oldVer}.json`), JSON.stringify(oldBm));
    } catch { /* 服务器无历史 blockmap → 本次全量 */ }
  }
  if (!oldBm || !fs.existsSync(oldExe)) return { oldBm: null, oldExe: null, newBmUrl, saveBmFile };
  return { oldBm, oldExe, newBmUrl, saveBmFile };
}

/** 下载+sha512 门(差量优先,全量兜底)。返回 {ok,file} 或 {ok:false,error}。 */
async function fetchInstaller(info, onEvent, deltaCtx) {
  // S14-1②(20261119 夜审):远端声明的文件名只取 basename,杜绝 ../ 逃逸(子目录形态本仓发布流程不产生)
  const base = path.basename(String(info.path || ''));
  if (!base) return { ok: false, error: 'latest.yml 缺 path 字段,拒绝安装' };
  const final = path.join(updatesDir(), base);
  const part = final + '.part';
  fs.mkdirSync(path.dirname(final), { recursive: true });
  const url = FEED.replace(/[^/]+$/, '') + info.path;

  // ---- 差量尝试(任何失败静默退全量;完整性门在下方单源兜底) ----
  let deltaDone = false;
  let newBm = null;
  if (deltaCtx && deltaCtx.oldBm && deltaCtx.oldExe) {
    try {
      if (!fs.existsSync(deltaCtx.oldExe)) throw new Error('旧安装包不在');
      const oldSize = fs.statSync(deltaCtx.oldExe).size;
      if (oldSize !== deltaCtx.oldBm.total + deltaCtx.oldBm.base) throw new Error('旧安装包与 blockmap 尺寸不符');
      newBm = parseBlockmap(await httpGetBuffer(deltaCtx.newBmUrl, httpRequest));
      if (Number(info.size) && newBm.total !== Number(info.size)) throw new Error('新 blockmap 与 yml 尺寸不符');
      const plan = computeDeltaPlan(deltaCtx.oldBm, newBm);
      if (!plan) throw new Error('blockmap 版本/布局不可差量');
      if (plan.deltaBytes > plan.totalBytes * DELTA_MAX_RATIO) throw new Error(`新块占比 ${(plan.deltaBytes / plan.totalBytes * 100).toFixed(0)}% 超阈值,直接全量`);
      await downloadDelta({ oldExe: deltaCtx.oldExe, plan, newUrl: url, partPath: part, httpReq: httpRequest, onEvent });
      deltaDone = true;
    } catch (e) {
      try { fs.unlinkSync(part); } catch { /* 尽力 */ }
      onEvent?.({ phase: 'download', message: `差量不可用转全量(${String(e?.message || e).slice(0, 80)})` });
    }
  }
  if (!deltaDone) {
    const r = await downloadFull({ url, partPath: part, total: Number(info.size) || null, httpReq: httpRequest, onEvent });
    if (!r.ok) return r;
  }

  // ---- 统一 sha512 门(fail-closed;差量重组件与整包件同门) ----
  let b64 = await sha512File(part);
  if (info.sha512 && b64 !== info.sha512 && deltaDone) {
    // 差量重组件不符(旧包损坏/块传输静默错/清单错位)→ 退全量重下一次,再过同一道门;
    // 仍不符才拒绝(fail-closed 不放松,只是多给一条自愈路径)
    try { fs.unlinkSync(part); } catch { /* 尽力 */ }
    onEvent?.({ phase: 'download', message: '差量重组校验不符,转全量重下' });
    const r = await downloadFull({ url, partPath: part, total: Number(info.size) || null, httpReq: httpRequest, onEvent });
    if (!r.ok) return r;
    deltaDone = false;
    b64 = await sha512File(part);
  }
  // S14-1①(20261119 夜审):sha512 缺声明=拒绝(fail-closed,与 manifest 验签同口径)——
  // 否则 latest.yml 被篡改去掉 sha512 即可免校验直达 NSIS /S 静默执行
  if (!info.sha512) {
    try { fs.unlinkSync(part); } catch { /* 尽力 */ }
    return { ok: false, error: 'latest.yml 未声明 sha512,拒绝安装(完整性门 fail-closed)' };
  }
  if (b64 !== info.sha512) {
    try { fs.unlinkSync(part); } catch { /* 尽力 */ }
    return { ok: false, error: `sha512 校验失败(期望 ${String(info.sha512).slice(0, 12)}… 实得 ${b64.slice(0, 12)}…)` };
  }
  // 20261119-2-S14-F5:225MB 落盘 rename 是 AV/索引器扫描高发面,瞬时 EPERM/EBUSY 退避重试
  // (b3-flake 同族——proc.mjs atomicWriteFileSync 的 rename 有限退避同口径,tray 红线自带实现)
  let renamed = false; let lastErr = null;
  for (let i = 0; i < 4 && !renamed; i++) {
    if (i) await new Promise(r => setTimeout(r, 50 * i));
    try { fs.renameSync(part, final); renamed = true; } catch (e) { lastErr = e; if (!/^(?:EPERM|EBUSY|EACCES)$/.test(String(e && e.code))) break; }
  }
  if (!renamed) return { ok: false, error: `安装包落盘失败:${lastErr && lastErr.message}` };

  // ---- 缓存新 blockmap(下一次差量的旧侧)+ 清理更旧安装包 ----
  if (deltaCtx && deltaCtx.saveBmFile) {
    try {
      if (!newBm) newBm = parseBlockmap(await httpGetBuffer(deltaCtx.newBmUrl, httpRequest));
      fs.mkdirSync(path.dirname(deltaCtx.saveBmFile), { recursive: true });
      fs.writeFileSync(deltaCtx.saveBmFile, JSON.stringify(newBm));
      pruneOldBlockmaps(path.dirname(deltaCtx.saveBmFile), deltaCtx.saveBmFile);
    } catch { /* 尽力:缓存失败只影响下次差量,不影响本次安装 */ }
  }
  pruneOldInstallers(updatesDir(), final);
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
      // 20261121 用户裁定:已是最新版不再弹窗——面板绿色提示文案即够(onEvent→tray:base-update→ok 绿)。
      onEvent?.({ phase: 'result', outcome: 'already-latest', message: `应用已是最新版本(${local})` });
      return { outcome: 'already-latest', version: local };
    }
    onEvent?.({ phase: 'manifest', message: `发现新版本 ${info.version},下载中…` });
    const instPath = info.path || info.files[0]?.url;
    const deltaCtx = await prepareDeltaCtx({ ...info, path: instPath }, { appLike: app, httpReq: httpRequest, dir: updatesDir() }).catch(() => null);
    const f = await fetchInstaller({ ...info, path: instPath }, onEvent, deltaCtx);
    if (!f.ok) throw new Error(f.error);
    readyInfo = { version: info.version, file: f.file, size: info.size, releaseDate: info.releaseDate };
    // pending 落盘保留:跨会话「有已下载未安装新版」提示用(启动自检只提示,不再静默装)。
    try { writePending({ version: info.version, file: f.file, sha512: info.sha512 }); } catch { /* 落盘失败=仅会话内引导 */ }
    const msg = `新版本 ${info.version} 下载完成`;
    onEvent?.({ phase: 'result', outcome: 'updated', message: msg });
    // 20261120 用户裁定:下载完成弹「立即安装(推荐)/稍后」——立即=退出本程序并拉起**可见安装向导**;
    // 稍后=pending 保留,下次启动提示。静默装机(退出装/开机装)已全面取消。
    if (fromMenu) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: '应用更新',
        message: `新版本 ${info.version} 已下载完成`,
        detail: '选择「立即安装」将退出 TokenSaver 并打开新版安装向导,按向导完成即可升级。\n选择「稍后」可下次启动时再安装。',
        buttons: ['立即安装(推荐)', '稍后'],
        defaultId: 0, cancelId: 1,
      });
      if (response === 0) {
        onEvent?.({ phase: 'result', outcome: 'installing', message: '正在退出并打开新版安装向导…' });
        // 同步拉起再退出(20261121 修):旧写法 setTimeout(…,800)+app.quit() 里定时器随主进程退出被吞,
        // 测试机实锤点「立即安装」托盘退掉但向导永不出现。3 秒延时本就应放 spawnInstaller 的 detached cmd
        // 内(ping -n 3,子进程独立存活不随宿主消亡,顺带覆盖退出窗口防 NSIS 文件占用竞态)。
        if (!spawnInstaller(readyInfo.file)) {
          dialog.showErrorBox('应用更新', '安装程序启动失败;下次启动会再次提示,或到安装包目录手动运行。');
        }
        app.quit();
        return { outcome: 'installing', version: info.version };
      }
    }
    return { outcome: 'updated', version: info.version };
  } catch (e) {
    const msg = `应用更新检查失败:${String(e?.message || e).slice(0, 120)}`;
    onEvent?.({ phase: 'result', outcome: 'error', message: msg });
    if (fromMenu) dialog.showErrorBox('检查应用更新', String(e?.message || e).slice(0, 200));
    return { outcome: 'error', message: msg };
  } finally { busy = false; }
}

/** 20261120 用户裁定:installOnQuit 废除——退出不再触装(静默装机全线取消),保留为 no-op 兼容旧调用点。 */
export const __internal = { spawnInstaller };
export function installOnQuit() {
  return false;
}
