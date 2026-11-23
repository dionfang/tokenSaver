/**
 * Electron 壳主进程(tray 方案 §7/§16.1/§18-A2/A4,2026-11-15 M1):
 * 单实例锁(二次启动唤起首实例面板)、托盘+菜单(全汉字)、双击状态面板(contextBridge 白名单通道,
 * 渲染进程零 Node 权限)、powerMonitor resume 即刷、开机自启(A2 默认开,HKCU Run「TokenSaver」)。
 * import 禁令(§18-E1):除本文件 spawn 与 util/statusFile 纯读外,不 import code-index/**;
 * 路径一律经 util/paths.mjs spawn `node code-index/paths.mjs` 获取。
 */
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, powerMonitor, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCmdRunner } from './cmdRunner.mjs';
import { createPoller } from './poller.mjs';
import { resolvePaths, hfWeightCached, localWeightCached } from './util/paths.mjs';
import { createWeightsAuto } from './wizard/weightsAuto.mjs';
import { downloadWeights } from './wizard/weightsOnline.mjs';
import { appTooltip } from './util/lamps.mjs';
import { createWizardController } from './wizard/controller.mjs';
import { createUpdateBase } from './updateBase.mjs';
import { createUploadKnn } from './uploadKnn.mjs';
import { checkAppUpdate } from './appUpdater.mjs';
import { createDownloader, httpRequest } from './downloader.mjs';
import { createDownloadRegistry } from './util/downloadRegistry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, '..', 'assets', 'tray.png');
const PANEL_PRELOAD = path.join(here, '..', 'panel', 'preload.cjs');
const PANEL_HTML = path.join(here, '..', 'panel', 'index.html');
const ROOTS_HTML = path.join(here, '..', 'panel', 'roots.html');
const WIZARD_HTML = path.join(here, '..', 'panel', 'wizard.html');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'TokenSaver';

const runner = createCmdRunner();
let tray = null;
let panel = null;
let rootsWin = null;
let poller = null;
let ctx = { paths: null, snapshot: null, autorunOn: false };
let quitting = false; // 2026-11-15:退出握手——真退出时放行 close,X 按钮 close 一律改藏托盘(不退出)
let wizardOnly = false; // 2026-11-17 用户裁决:未完成向导时双击只跑向导(无托盘/轮询/自启);DONE 后转托盘模式

const sh = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, encoding: 'utf8' }, (e, stdout) => resolve({ ok: !e, stdout: String(stdout || '') }));
});

// ---------- 托盘自身状态(§16.7 data/tray-state.json,最小字段;记录用户对自启的选择) ----------
function readTrayState() {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.paths?.dataDir || '', 'tray-state.json'), 'utf8')); } catch { return {}; }
}
function writeTrayState(patch) {
  try {
    const dir = ctx.paths?.dataDir;
    if (!dir) return;
    const file = path.join(dir, 'tray-state.json');
    // S14-F7(20261118):原子写(tmp+rename,同文件 writeConfig 模板)——该文件承载上传游标,
    // 崩溃留半文件会丢游标致重传(服务端 pkey dedup 兜底,但仍白付带宽)。
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...readTrayState(), ...patch }, null, 1));
    try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
  } catch { /* 状态写失败不影响主流程 */ }
}

// ---------- 开机自启(A2 默认开:首跑无键值即写入;用户取消勾选即删除) ----------
async function queryAutorun() { const r = await sh('reg', ['query', RUN_KEY, '/v', RUN_NAME]); return r.ok && r.stdout.includes(RUN_NAME); }
function autorunCommand() {
  const exe = process.execPath;
  // 打包后 execPath 就是 TokenSaver.exe;开发态 execPath 是裸 electron.exe,必须带上 tray 目录否则登录只打开空 Electron
  if (app.isPackaged) return `"${exe}"`;
  return `"${exe}" "${path.resolve(here, '..')}"`;
}
async function setAutorun(on) {
  const r = on
    ? await sh('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', autorunCommand(), '/f'])
    : await sh('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
  return r.ok;
}

// ---------- 面板(§18-A4 一期必做;渲染进程零 Node,只走 preload 白名单通道) ----------
function openPanel() {
  // 2026-11-15 用户裁决:打开面板=要实况——触发一次慢刷(低频事件,一次 spawn status 换真实时)
  if (poller) poller.slowRefresh('panel-open').catch(() => {});
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  panel = new BrowserWindow({
    title: 'TokenSaver 状态面板',
    width: 460, height: 620, resizable: false, maximizable: false, fullscreenable: false, show: false, // 2026-11-18 用户裁决:加高,三端钩子三行完整显示
    autoHideMenuBar: true,
    webPreferences: { preload: PANEL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  panel.setMenu(null);
  panel.loadFile(PANEL_HTML);
  panel.once('ready-to-show', () => panel.show());
  // 2026-11-15 用户定:X=最小化到托盘(非退出);仅「退出」菜单真退。禁 F11 全屏。
  panel.on('close', (e) => { if (!quitting) { e.preventDefault(); panel.hide(); } });
  panel.webContents.on('before-input-event', (_e, input) => { if (input.key === 'F11') _e.preventDefault(); });
  panel.on('closed', () => { panel = null; });
  if (ctx.snapshot) panel.webContents.once('did-finish-load', () => panel?.webContents.send('tray:snapshot', ctx.snapshot));
}

// ---------- 安装向导(M2,§5.5/§16.4):启动无 done 记录即弹;未完成=继续引导 ----------
let wizardWin = null;
let wizardCtl = null;

function wizardController() {
  if (wizardCtl) return wizardCtl;
  wizardCtl = createWizardController({
    paths: ctx.paths,
    cmdRun: runner.run.bind(runner),
    weightRegistry,
    sendState: (st) => {
      if (wizardWin && !wizardWin.isDestroyed()) wizardWin.webContents.send('wizard:state', st);
      // 2026-11-17:向导-only 模式下向导完成 → 立即转托盘模式(同会话无缝衔接)
      if (wizardOnly && st?.wizard?.status === 'DONE') { wizardOnly = false; activateTray(); }
    },
    pickDirectories: async () => {
      const r = await dialog.showOpenDialog(wizardWin, { title: '选择要语义索引的目录', properties: ['openDirectory', 'multiSelections'] });
      return r.canceled ? null : r.filePaths;
    },
    execFile,
    openPath: (p) => shell.openPath(p),
    // 2026-11-20 修复「嵌入模型反复下载无法完成」:向导在线下载开跑前停掉托盘自动补权重
    // (两条下载链并发写同一 .part → 互相删件/字节交错 → 校验永不过)。取消保留 .part,向导续传;
    // 返回是否真停了在途任务(供向导日志提示)。等 inFlight 清零再放行,避免 Windows 文件占用 EBUSY。
    cancelAutoWeights: async () => {
      if (!autoDownloader || !weightsAuto?._state?.inFlight) return false;
      autoDownloader.cancel();
      const t0 = Date.now();
      while (weightsAuto._state.inFlight && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 200));
      return true;
    },
  });
  ipcMain.handle('wizard:action', async (_e, name, payload) => {
    try {
      return await wizardCtl.dispatch(name, payload);
    } catch (e) {
      // 2026-11-15 修复:主进程异常回传渲染层浮条展示,不再静默(「按钮没反应」无从排查的根源之一)
      console.error(`[wizard] action=${name} threw: ${e.stack || e}`);
      return { ok: false, error: 'handler-throw', message: String(e?.message || e).slice(0, 200) };
    }
  });
  return wizardCtl;
}

function wizardDone() {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.paths?.dataDir || '', 'tray-wizard-state.json'), 'utf8'))?.status === 'done'; } catch { return false; }
}

function openWizard() {
  if (wizardWin && !wizardWin.isDestroyed()) { wizardWin.show(); wizardWin.focus(); return; }
  if (!ctx.paths?.dataDir) { dialog.showErrorBox('安装向导', '无法定位 code-index 数据目录(paths.mjs 无响应),暂无法运行向导'); return; }
  wizardWin = new BrowserWindow({
    title: 'TokenSaver 安装向导',
    width: 640, height: 560, resizable: false, maximizable: false, fullscreenable: false, show: false, // 2026-11-17 用户裁决:降高度,中间信息框固定高+内滚,按钮位置恒定
    autoHideMenuBar: true,
    webPreferences: { preload: PANEL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  wizardWin.setMenu(null);
  wizardWin.loadFile(WIZARD_HTML);
  wizardWin.once('ready-to-show', () => wizardWin.show());
  wizardWin.on('close', (e) => {
    // 向导-only 模式:无托盘可藏,关向导=退出程序;托盘模式:藏向导不退出
    if (!quitting && !wizardOnly) { e.preventDefault(); wizardWin.hide(); }
  });
  wizardWin.webContents.on('before-input-event', (_e, input) => { if (input.key === 'F11') _e.preventDefault(); });
  wizardWin.on('closed', () => { wizardWin = null; if (wizardOnly) app.quit(); });
  wizardController(); // IPC 注册与控制器就绪先于渲染层首问
}

/** 20261123 修复(用户令「修」):装完即用闭环——首轮索引自动建立(顶层助手,activateTray 首次激活调)。
 *  纯托盘机无编辑器钩子触发面(SessionStart→auto.mjs 的 build→embed 链只在编辑器会话内跑),
 *  chunks.jsonl 缺失且 roots 非空 → 后台自动 build→embed(与「立即同步」按钮同链:embed 族 6h 死线、
 *  runner 互斥自带防重;embed.mjs 内部 cpu 线程限速慢跑不打扰用户)。失败静默——原因已进 embed.log,
 *  面板「立即同步」按钮兜底可重试,不打扰首次使用体验(不弹错误框)。 */
async function autoFirstIndex() {
  const dataDir = ctx.paths?.dataDir;
  if (dataDir == null) return;
  if (fs.existsSync(path.join(dataDir, 'chunks.jsonl'))) return; // 已有索引(含向导后手动同步过)
  if (!listRoots().length) return; // 未录目录:无内容可建,静默等用户进向导补
  if (ctx.snapshot?.embedPid != null) return; // 已有嵌入在跑(编辑器钩子链先启动了)
  const { nodeBin, codeIndexRoot } = ctx.paths || {};
  if (!nodeBin || !codeIndexRoot) return;
  const res = await runner.run('embed', nodeBin, [`${codeIndexRoot}/build.mjs`], { cwd: codeIndexRoot, label: '首次自动建索引 build.mjs' });
  if (res.code !== 0 || res.timedOut) return; // build 失败即停(半截索引无意义);embed.log 有因
  await runner.run('embed', nodeBin, [`${codeIndexRoot}/embed.mjs`], { cwd: codeIndexRoot, label: '首次自动嵌入 embed.mjs' });
  try { await poller?.slowRefresh('auto-first-index'); } catch { /* 刷新失败不影响建链 */ }
}

/** 托盘模式激活(幂等):自启+轮询+托盘图标。仅向导完成后调用(2026-11-17 用户裁决)。 */
function activateTray() {
  if (tray) return;
  (async () => {
    ctx.autorunOn = await queryAutorun();
    const choice = readTrayState().autoLaunch; // A2 默认开;用户显式关过(off)才保持关
    const choiceOff = choice === 'off';
    if (!choiceOff) {
      ctx.autorunOn = await setAutorun(true);
      if (choice == null) writeTrayState({ autoLaunch: ctx.autorunOn ? 'on' : 'off' });
    }
    poller = createPoller({
      paths: ctx.paths,
      cmdRun: runner.run.bind(runner),
      onSnapshot: applySnapshot,
      hfWeightCached: localWeightCached, // 2026-11-18:strands 决策权重须用 localWeightCached(hfWeightCached 对 strands 恒 null)
    });
    poller.fastTick();
    const loop = () => {
      const d = poller.nextDelayMs();
      setTimeout(() => { poller.fastTick(); loop(); }, d);
    };
    loop();
    // 20261123 修复(用户令「修」):装完即用闭环——首轮索引无自动触发面(编辑器机靠 SessionStart 钩子
    // 跑 auto.mjs,纯托盘机无钩子),首次激活时若 chunks.jsonl 缺失且 roots 非空 → 后台自动 build→embed
    // (autoFirstIndex 顶层助手:cpu 线程限速慢跑不打扰;失败静默,原因在 embed.log,「立即同步」按钮兜底)。
    autoFirstIndex().catch(() => {});
    // S14-F8(20261118):slowRefresh 是 async,fire-and-forget 未接 catch → 内部抛错即未处理 rejection
    powerMonitor.on('resume', () => { poller.slowRefresh('resume').catch(() => {}); });
    tray = new Tray(nativeImage.createFromPath(ICON));
    tray.setToolTip('TokenSaver');
    tray.setContextMenu(buildMenu());
    tray.on('double-click', () => openPanel());
    // 20261120 用户裁定(撤销 C6=b 自动检查):不启动静默自更新——更新唯一入口=托盘右键「检查应用更新」(菜单 :358)。
    // 20261120 用户裁定(再改口径):下载完成弹「立即安装(推荐)/稍后」→ 立即=退出并拉起**可见安装向导**;
    // 退出装机/开机静默装机全线取消(不同客户端环境静默行为异常);installOnQuit 已废为 no-op。
    // 代理死亡重拉看护(20261120 用户裁定立项):prompt-guard 钩子链断(如 hook-relay 缺件)时
    // ensureProxyRunning 无人触发,8117 断了没人拉(实测代理死后静默停摆)——托盘 60s 周期兜底调
    // code-index 微 CLI --ensure(pid+端口双判据+30s 冷却,fail-open),钩子链健康与否都不依赖。
    const proxyWatchdog = () => {
      const { nodeBin, codeIndexRoot } = ctx.paths || {};
      if (!nodeBin || !codeIndexRoot) return;
      runner.run('proxy-watchdog', nodeBin, [path.join(codeIndexRoot, 'proxyKeepalive.mjs'), '--ensure'], { cwd: codeIndexRoot, timeoutMs: 20000 })
        .then((r) => { if (r.code !== 0) console.error('[proxy-watchdog] 非零退出', r.code, (r.stderr || '').slice(-160)); })
        .catch(() => {});
    };
    proxyWatchdog(); // 启动即保活一轮(钩子断的窗口期也能把 8117 拉起来)
    setInterval(proxyWatchdog, 60_000).unref?.();
  })();
}

// ---------- 菜单动作 ----------
function configFile() {
  const dataDir = ctx.paths?.dataDir;
  return dataDir ? path.join(dataDir, 'code-index.config.json') : null;
}

function readConfig() {
  const file = configFile();
  if (!file) throw new Error('无法定位数据目录');
  return { file, cfg: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function writeConfig(file, cfg) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}

function rootNorm(p) {
  return path.resolve(String(p)).split(path.sep).join('/');
}

function rootKey(p) {
  const n = rootNorm(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function currentRoots(cfg) {
  return Array.isArray(cfg.roots) ? cfg.roots.map((r) => rootNorm(r)) : [];
}

function checkRoot(p) {
  if (typeof p !== 'string' || !p.trim()) return '目录路径为空';
  if (p.includes(',')) return '路径含逗号,不能加入';
  if (!path.isAbsolute(p)) return '须选择绝对路径目录';
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(p)) return '须选择绝对路径目录';
  if (!fs.existsSync(p)) return '目录不存在';
  return null;
}

function listRoots() {
  const { cfg } = readConfig();
  return currentRoots(cfg);
}

function saveRoots(next) {
  const { file, cfg } = readConfig();
  cfg.roots = next;
  writeConfig(file, cfg);
  return next;
}

function openRoots() {
  if (rootsWin && !rootsWin.isDestroyed()) { rootsWin.show(); rootsWin.focus(); return; }
  rootsWin = new BrowserWindow({
    title: '管理代码目录',
    width: 560, height: 420, resizable: false, maximizable: false, fullscreenable: false, show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: PANEL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  rootsWin.setMenu(null);
  rootsWin.loadFile(ROOTS_HTML);
  rootsWin.once('ready-to-show', () => rootsWin.show());
  rootsWin.webContents.on('before-input-event', (_e, input) => { if (input.key === 'F11') _e.preventDefault(); });
  rootsWin.on('closed', () => { rootsWin = null; });
}

async function runRepairHooks(host) {
  const { nodeBin, codeIndexRoot } = ctx.paths || {};
  if (!nodeBin || !codeIndexRoot) return { ok: false, error: '无法定位 code-index(paths.mjs 无响应)' };
  const res = await runner.run('init', nodeBin, [`${codeIndexRoot}/init.mjs`, '--hooks', host], { cwd: codeIndexRoot, label: `修复钩子 ${host}` });
  if (res.skipped) return { ok: false, skipped: true, error: `有任务在跑(${res.busyFamily || '互斥任务'}),稍后再试` };
  if (res.code !== 0) return { ok: false, error: `${res.timedOut ? '超时被终止\n' : ''}${(res.stderr || res.stdout || `exit ${res.code}`).slice(-400)}` };
  await poller?.slowRefresh('repair-hooks'); // 修完重跑 hooksStatus 刷新灯(§5.3.4)
  return { ok: true };
}

async function repairHooks(host) {
  const r = await runRepairHooks(host);
  if (r.ok) dialog.showMessageBox({ message: '钩子修复完成', buttons: ['知道了'] });
  else if (r.skipped) dialog.showMessageBox({ message: r.error, buttons: ['知道了'] });
  else dialog.showErrorBox(String(r.error || '').includes('无法定位') ? '修复钩子' : '修复钩子失败', r.error || '失败');
}

// ---------- T4 更新公共决策包(M4,§5.4/§16.3):菜单+面板双入口,进度/结果经 tray:base-update 推面板 ----------
let baseUpdater = null;
function pushBase(ev) { if (panel && !panel.isDestroyed()) panel.webContents.send('tray:base-update', ev); }
function getBaseUpdater() {
  if (baseUpdater) return baseUpdater;
  const dl = createDownloader({ onProgress: (p) => pushBase({ phase: 'download', pct: p.pct, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal }) });
  baseUpdater = createUpdateBase({
    paths: ctx.paths,
    cmdRun: runner.run.bind(runner),
    fetchText: async (url, { timeoutMs } = {}) => {
      const { status, res } = await httpRequest(url, { timeoutMs });
      let txt = '';
      res.setEncoding('utf8');
      for await (const c of res) txt += c;
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return txt;
    },
    downloader: dl,
    readState: readTrayState,
    writeState: writeTrayState,
    onEvent: pushBase,
  });
  return baseUpdater;
}
async function runUpdateBase(fromMenu) {
  // 互惠口径(2026-11-18 用户裁决修订):**先下载公共决策包 → 再上传本地向量**——
  // 初始安装本地还没有向量文件,先上传会失败导致无法下载;下载后上传为尽力而为:
  // 无本地向量文件/无新增 → 忽略跳过;其余上传失败仅提示,不回滚已完成的下载。
  // 上传不再是独立入口,菜单项未同意时整个隐藏(撤回/补同意唯一入口=重开向导数据上传步)。
  let r;
  try { r = await getBaseUpdater().run(); }
  catch (e) { r = { outcome: 'handler-throw', message: String(e?.message || e).slice(0, 200) }; } // 菜单路径兜底:意外异常不再裸抛(未处理 rejection)
  pushBase({ phase: 'result', ...r });
  const dlOk = r.outcome === 'updated' || r.outcome === 'already-latest';
  if (dlOk) await poller?.slowRefresh('update-base').catch(() => {});
  if (!dlOk) {
    if (fromMenu) {
      if (['consent-required', 'busy'].includes(r.outcome)) dialog.showMessageBox({ message: r.message, buttons: ['知道了'] });
      else dialog.showErrorBox('更新公共决策包', r.message || r.outcome);
    }
    return r;
  }
  let up;
  try { up = await getUploadKnn().run(); }
  catch (e) { up = { outcome: 'handler-throw', message: String(e?.message || e).slice(0, 200) }; }
  if (up.outcome === 'updated') await poller?.slowRefresh('upload-knn').catch(() => {});
  // 20261120 用户裁定:绿色提示只报下载结果;上传跳过类(no-local-layer/nothing-new/consent 等)静默不显示,
  // 仅「上传成功」与「上传失败」才追加——失败必须可见,跳过不制造噪音。
  const skipUpload = ['no-local-layer', 'nothing-new', 'consent-required', 'no-paths', 'busy'].includes(up.outcome);
  const upMsg = up.outcome === 'updated'
    ? `;已上传 ${up.accepted ?? 0} 条`
    : skipUpload ? '' : `;上传本地向量失败:${up.message || up.outcome}`;
  const summary = `${r.outcome === 'updated' ? `公共决策包已更新(${r.accepted ?? '?'} 条)` : '公共决策包已是最新'}${upMsg}`;
  pushBase({ phase: 'result', outcome: up.outcome === 'updated' ? 'updated' : r.outcome, message: summary });
  if (fromMenu) dialog.showMessageBox({ message: summary, buttons: ['知道了'] });
  return { ...r, upload: up, message: summary };
}
// ---------- T6 上传本地向量(M5,§5.6/§19.6;2026-11-18 交互裁决:不再独立入口,仅作互惠前置) ----------
let uploadKnn = null;
function getUploadKnn() {
  if (uploadKnn) return uploadKnn;
  uploadKnn = createUploadKnn({
    paths: ctx.paths,
    cmdRun: runner.run.bind(runner),
    readState: readTrayState,
    writeState: writeTrayState,
    onEvent: (ev) => pushBase({ ...ev, phase: ev.phase === 'facts' || ev.phase === 'upload' ? 'manifest' : ev.phase }), // 复用面板 base 进度行
  });
  return uploadKnn;
}

// ---------- 菜单 ----------
// 2026-11-17 用户裁决:删菜单一键「切换运行模式」(M3 流水线整体移除)——切模式可能需自检安装
// 依赖项与手工安装项,无法一键完成;模式切换统一走安装向导(菜单名改为「切换运行模式」,
// 向导 secondRun 以 config 为真源,ENVCHECK 自动补装软项、硬项给手工指引)。
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '切换运行模式', click: () => { openWizard(); } },
    { label: '管理代码目录', click: () => { openRoots(); } },
    // 20261123 修复(用户报「更新下载进度占用公共决策包进度条」):应用更新的进度/结果事件打 kind:'app'
    // 标再进面板——面板 onBaseEvent 按分流写【专属 app 进度行】,不再写 knn-base-bar/pct(那是公共决策包的)。
    { label: '检查应用更新', click: () => { openPanel(); checkAppUpdate({ onEvent: (ev) => pushBase({ ...ev, kind: 'app' }), fromMenu: true }); } },
    { label: '打开数据目录', click: () => { if (ctx.paths?.dataDir) shell.openPath(ctx.paths.dataDir); } },
    { label: `开机自启    ${ctx.autorunOn ? '✓' : '✗'}`, click: async () => {
      const next = !ctx.autorunOn;
      const ok = await setAutorun(next);
      if (ok) { ctx.autorunOn = next; writeTrayState({ autoLaunch: next ? 'on' : 'off' }); }
      if (tray) tray.setContextMenu(buildMenu());
    } },
    { label: '退出', click: () => { runner.killAll(); app.quit(); } },
  ]);
}

let weightsAuto = null, autoDownloader = null; // 2026-11-18 托盘自动补权重
// 模型下载进度登记簿(2026-11-18 交互同步):wizard 权重下载/托盘自动补/gpu pull 三路共用;
// 面板模型行「下载中 pct%」+ 自检行/下一步门禁(下载中可跳过)。
const weightRegistry = createDownloadRegistry({ onChange: (snap) => { if (panel && !panel.isDestroyed()) panel.webContents.send('tray:weight-download', snap); } });
function applySnapshot(snapshot) {
  ctx.snapshot = snapshot;
  // 2026-11-18:local 权重缺失且向导已完成时,托盘自动发起补下载(节流+防与向导并发)
  if (!weightsAuto && ctx.paths?.hfCacheDir) {
    autoDownloader = createDownloader({ onProgress: (p) => weightRegistry.update(p) });
    weightsAuto = createWeightsAuto({ downloadWeights, downloader: autoDownloader, getBaseDir: () => ctx.paths?.hfCacheDir, log: (l) => { try { fs.appendFileSync(path.join(ctx.paths.dataDir, 'weights-auto.log'), l + '\n'); } catch { /* 日志失败不阻断 */ } } });
  }
  if (weightsAuto) {
    const busy = wizardCtl ? wizardCtl.machine.getState().status !== 'DONE' : false;
    weightsAuto.maybe(snapshot.localWeights, snapshot.modelIn, { busy }).catch(() => {});
  }
  ctx.consent = snapshot.consent;
  if (panel && !panel.isDestroyed()) panel.webContents.send('tray:snapshot', { ...snapshot, weightDownload: weightRegistry.snapshot() });
  if (tray) {
    tray.setContextMenu(buildMenu());
    // 2026-11-17 旧裁决(模型状态悬浮)已被 20261120 裁定取代:模型状态整块移去面板,悬浮只留身份三行
    // 20261120 用户裁定(火绒式三行):悬浮=TokenSaver/版本/公共决策包 builtAt;模型状态看面板。
    tray.setToolTip(appTooltip(snapshot, app.getVersion()));
  }
}

// ---------- 启动 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { // 二次启动:托盘模式唤面板;向导-only 模式唤向导
    if (tray) openPanel();
    else if (wizardWin && !wizardWin.isDestroyed()) { wizardWin.show(); wizardWin.focus(); }
    else openWizard();
  });
  app.whenReady().then(async () => {
    // 待装新版提示(20261120 用户裁定改口径):启动自检发现已下载+已校验的 pending 新版 ⇒ **只弹提示**,
    // 由用户选择「立即安装(可见向导)/稍后」;静默装机(启动自装/退出装)已全线取消,不再自动拉安装器。
    try {
      const { consumePendingAtStartup, __internal } = await import('./appUpdater.mjs');
      const p = await consumePendingAtStartup();
      if (p && p.prompt) {
        const { response } = await dialog.showMessageBox({
          type: 'info', title: '应用更新',
          message: `检测到已下载的新版本 ${p.version} 尚未安装`,
          detail: '选择「立即安装」将退出 TokenSaver 并打开新版安装向导,按向导完成即可升级。',
          buttons: ['立即安装(推荐)', '稍后'], defaultId: 0, cancelId: 1,
        });
        if (response === 0) {
          if (!__internal.spawnInstaller(p.file)) {
            dialog.showErrorBox('应用更新', '安装程序启动失败;下次启动会再次提示,或到安装包目录手动运行。');
          }
          app.quit(); return;
        }
      }
    } catch { /* 自检失败不阻断正常启动 */ }
    Menu.setApplicationMenu(null); // 不显示 Electron 默认窗口菜单栏
    ipcMain.handle('tray:refresh', async () => {
      if (!poller) return { ok: false, error: 'not-ready' };
      try {
        const r = await poller.slowRefresh('panel-manual');
        return { ok: !r?.skipped, skipped: !!r?.skipped };
      } catch (e) {
        return { ok: false, error: String(e?.message || e).slice(0, 200) };
      }
    });
    let syncBusy = false;
    function explainSyncResult(res) {
      if (res.skipped) {
        dialog.showMessageBox({ message: `有任务在跑(${res.busyFamily || '互斥任务'}),稍后再试`, buttons: ['知道了'] });
        return { ok: false, skipped: true };
      }
      if (res.timedOut) {
        dialog.showErrorBox('立即同步', '同步超过 1 小时被终止');
        return { ok: false, timedOut: true };
      }
      if (res.code !== 0) {
        // 20261120(测试机静默死亡修复):退出码恒显——旧 `stderr||stdout` 把 code 遮住,
        // 而原生崩溃的退出码(0xC000001D 缺 AVX / 0xC0000005 原生崩 / 被杀)正是定罪钥匙。
        const body = (res.stderr || res.stdout || '').slice(-400);
        const tail = `${body}\n[exit] code=${res.code}`;
        dialog.showErrorBox('立即同步失败', tail);
        return { ok: false, code: res.code };
      }
      return { ok: true };
    }
    // 代码索引与决策向量共用 data/.embed.pid，且都打同一嵌入服务，必须串行。
    async function runSyncJob(args, label) {
      if (syncBusy || ctx.snapshot?.embedPid != null) return { ok: true, busy: true };
      const { nodeBin, codeIndexRoot } = ctx.paths || {};
      if (!nodeBin || !codeIndexRoot) {
        dialog.showErrorBox('立即同步', '无法定位 code-index(paths.mjs 无响应)');
        return { ok: false, error: 'no-paths' };
      }
      syncBusy = true;
      try {
        // 20261122 修复:不传 timeoutMs,回落 TIMEOUTS.embed=6h(表已按测试机 CPU 全量 >1.2h 定 6h;
        // 旧 1h 覆盖点把表修复打回 1h → CPU 机全量嵌准点树杀,显示层进度掉回持久层水位)
        const res = await runner.run('embed', nodeBin, args, { cwd: codeIndexRoot, label });
        await poller?.slowRefresh('sync-embed');
        return explainSyncResult(res);
      } catch (e) {
        const error = String(e?.message || e).slice(0, 200);
        dialog.showErrorBox('立即同步失败', error);
        return { ok: false, error };
      } finally {
        syncBusy = false;
      }
    }
    // 20261123 修复(用户问「进度条空,点立即同步才有」的第二层):按钮链只跑 embed.mjs,
    // chunks.jsonl 不存在时 embed 直退 1(「请先运行 node build.mjs」)——纯托盘机(无编辑器
    // 钩子链的 auto.mjs 触发面)一个按钮无法从零建全索引。补 build 前置(与 auto.mjs 同链):
    // chunks 缺失时先跑 build.mjs 再 embed;build 失败即停并弹错(不给半截索引)。
    ipcMain.handle('tray:sync-embed', async () => {
      const dataDir = ctx.paths?.dataDir;
      let needBuild = true;
      try { needBuild = !fs.existsSync(path.join(dataDir || '', 'chunks.jsonl')); } catch { needBuild = true; }
      if (needBuild) {
        const pre = await runSyncJob(
          [`${ctx.paths?.codeIndexRoot || ''}/build.mjs`],
          '立即同步 build.mjs(索引缺失,先建块)',
        );
        if (!pre.ok) return pre; // build 失败即停(半截索引无意义,错误已在 runSyncJob 弹出)
      }
      return runSyncJob(
        [`${ctx.paths?.codeIndexRoot || ''}/embed.mjs`],
        '立即同步 embed.mjs',
      );
    });
    // 先重写样本库并立刻刷新进度条(旧向量/新样本数),再后台嵌入;嵌入中靠进度文件推进分子。
    ipcMain.handle('tray:sync-vectors', async () => {
      if (syncBusy || ctx.snapshot?.embedPid != null) return { ok: true, busy: true };
      const { nodeBin, codeIndexRoot } = ctx.paths || {};
      if (!nodeBin || !codeIndexRoot) {
        dialog.showErrorBox('立即同步', '无法定位 code-index(paths.mjs 无响应)');
        return { ok: false, error: 'no-paths' };
      }
      syncBusy = true;
      // 同上(20261122):回落 embed 族 6h 默认;grow-now/--build-vectors 同族,正常分钟级,死线只兜挂死
      const run = (args, label) => runner.run('embed', nodeBin, args, { cwd: codeIndexRoot, label });
      try {
        const grown = await run([`${codeIndexRoot}/autoExemplars.mjs`, '--grow-now'], '立即同步 更新样本库');
        const growOut = explainSyncResult(grown);
        if (!growOut.ok) return growOut;
        await poller?.fastTick(false);
        const embedded = await run([`${codeIndexRoot}/modelRoute.mjs`, '--build-vectors'], '立即同步 重嵌决策向量');
        const embedOut = explainSyncResult(embedded);
        await poller?.fastTick(false);
        return embedOut;
      } catch (e) {
        const error = String(e?.message || e).slice(0, 200);
        dialog.showErrorBox('立即同步失败', error);
        return { ok: false, error };
      } finally {
        syncBusy = false;
      }
    });
    ipcMain.handle('tray:update-base', async () => {
      try { return await runUpdateBase(false); }
      catch (e) { return { ok: false, outcome: 'handler-throw', message: String(e?.message || e).slice(0, 200) }; }
    });
    ipcMain.handle('tray:roots-list', () => {
      try { return { ok: true, roots: listRoots() }; }
      catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200), roots: [] }; }
    });
    ipcMain.handle('tray:roots-add', async () => {
      try {
        const picked = await dialog.showOpenDialog(rootsWin && !rootsWin.isDestroyed() ? rootsWin : undefined, {
          title: '添加代码目录', properties: ['openDirectory', 'multiSelections'],
        });
        const roots = listRoots();
        if (picked.canceled) return { ok: true, roots, messages: [] };
        const have = new Set(roots.map(rootKey));
        const messages = [];
        const next = roots.slice();
        for (const raw of picked.filePaths || []) {
          const err = checkRoot(raw);
          if (err) { messages.push(`${raw}: ${err}`); continue; }
          const norm = rootNorm(raw);
          if (have.has(rootKey(norm))) { messages.push(`${norm} 已在列表中`); continue; }
          have.add(rootKey(norm));
          next.push(norm);
        }
        const saved = next.length === roots.length ? roots : saveRoots(next);
        return { ok: true, roots: saved, messages };
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200), roots: [] }; }
    });
    ipcMain.handle('tray:roots-remove', (_e, target) => {
      try {
        const key = rootKey(String(target || ''));
        const roots = listRoots().filter((r) => rootKey(r) !== key);
        return { ok: true, roots: saveRoots(roots), messages: [] };
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200), roots: [] }; }
    });
    ipcMain.handle('tray:repair-hooks', async () => {
      try {
        const r = await runRepairHooks('all');
        if (!r.ok) {
          if (r.skipped) dialog.showMessageBox({ message: r.error, buttons: ['知道了'] });
          else dialog.showErrorBox(String(r.error || '').includes('无法定位') ? '修复钩子' : '修复钩子失败', r.error || '失败');
        }
        return { ok: !!r.ok, skipped: !!r.skipped };
      } catch (e) {
        const error = String(e?.message || e).slice(0, 200);
        dialog.showErrorBox('修复钩子失败', error);
        return { ok: false, error };
      }
    });
    ctx.paths = await resolvePaths();
    if (ctx.paths.degraded) dialog.showErrorBox('TokenSaver', '无法定位 code-index 数据目录(paths.mjs 无响应),状态展示可能不完整');
    // 2026-11-17 用户裁决:未完成向导 → 只启动安装向导(无托盘/轮询/自启,关向导=退出);
    // 已完成 → 直接托盘模式。向导 DONE 时 sendState 钩子自动 activateTray 衔接。
    if (wizardDone()) activateTray();
    else { wizardOnly = true; openWizard(); }
  });
  app.on('window-all-closed', (e) => { /* 托盘常驻:面板关了不退 */ });
  // 2026-11-15 退出握手:菜单「退出」→ app.quit() 触发 before-quit 置真,close 拦截放行(hide 兜底不拦真退)
  // 20261120 用户裁定:退出不再触装(静默装机全线取消,installOnQuit 已废 no-op;仅保留退出握手置位)
  app.on('before-quit', () => { quitting = true; });
}
