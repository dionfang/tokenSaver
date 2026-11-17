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
import { resolvePaths, hfWeightCached } from './util/paths.mjs';
import { modelTooltip } from './util/lamps.mjs';
import { createWizardController } from './wizard/controller.mjs';
import { createUpdateBase } from './updateBase.mjs';
import { createUploadKnn } from './uploadKnn.mjs';
import { createDownloader, httpRequest } from './downloader.mjs';
import { readConsent, writeConsent, t4Allowed } from './consent.mjs';

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
    fs.writeFileSync(path.join(dir, 'tray-state.json'), JSON.stringify({ ...readTrayState(), ...patch }, null, 1));
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
    width: 460, height: 560, resizable: false, maximizable: false, fullscreenable: false, show: false,
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
      hfWeightCached,
    });
    poller.fastTick();
    const loop = () => {
      const d = poller.nextDelayMs();
      setTimeout(() => { poller.fastTick(); loop(); }, d);
    };
    loop();
    powerMonitor.on('resume', () => poller.slowRefresh('resume'));
    tray = new Tray(nativeImage.createFromPath(ICON));
    tray.setToolTip('TokenSaver');
    tray.setContextMenu(buildMenu());
    tray.on('double-click', () => openPanel());
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
  let r;
  try { r = await getBaseUpdater().run(); }
  catch (e) { r = { outcome: 'handler-throw', message: String(e?.message || e).slice(0, 200) }; } // 菜单路径兜底:意外异常不再裸抛(未处理 rejection)
  pushBase({ phase: 'result', ...r });
  if (r.outcome === 'updated' || r.outcome === 'already-latest') await poller?.slowRefresh('update-base').catch(() => {});
  if (fromMenu) {
    if (r.outcome === 'updated' || r.outcome === 'already-latest' || r.outcome === 'consent-required' || r.outcome === 'busy') dialog.showMessageBox({ message: r.message, buttons: ['知道了'] });
    else dialog.showErrorBox('更新公共决策包', r.message || r.outcome);
  }
  return r;
}
// ---------- T6 上传本地向量(M5,§5.6/§19.6):面板入口,进度/回执经 tray:upload-event 推面板 ----------
let uploadKnn = null;
function pushUpload(ev) { if (panel && !panel.isDestroyed()) panel.webContents.send('tray:upload-event', ev); }
function getUploadKnn() {
  if (uploadKnn) return uploadKnn;
  uploadKnn = createUploadKnn({
    paths: ctx.paths,
    cmdRun: runner.run.bind(runner),
    readState: readTrayState,
    writeState: writeTrayState,
    onEvent: pushUpload,
  });
  return uploadKnn;
}
async function runUploadKnn(fromMenu) {
  let r;
  try { r = await getUploadKnn().run(); }
  catch (e) { r = { outcome: 'handler-throw', message: String(e?.message || e).slice(0, 200) }; } // 菜单路径兜底:意外异常不再裸抛
  pushUpload({ phase: 'result', ...r });
  if (r.outcome === 'updated') await poller?.slowRefresh('upload-knn').catch(() => {});
  if (fromMenu) {
    if (['updated', 'nothing-new', 'consent-required', 'busy'].includes(r.outcome)) dialog.showMessageBox({ message: r.message, buttons: ['知道了'] });
    else dialog.showErrorBox('上传本地向量', r.message || r.outcome);
  }
  return r;
}

/** 同意开关(D5 撤回/补同意解锁 T4):写 consent 文件→重建菜单(门禁联动)→推面板→快刷快照。 */
function setConsent(on) {
  const dataDir = ctx.paths?.dataDir;
  if (!dataDir) return { ok: false, error: 'no-paths' };
  writeConsent(dataDir, on === true);
  ctx.consent = readConsent(dataDir);
  if (tray) tray.setContextMenu(buildMenu());
  pushBase({ phase: 'consent', consent: ctx.consent });
  poller?.fastTick();
  return { ok: true, consent: ctx.consent };
}

// ---------- 菜单 ----------
// 2026-11-17 用户裁决:删菜单一键「切换运行模式」(M3 流水线整体移除)——切模式可能需自检安装
// 依赖项与手工安装项,无法一键完成;模式切换统一走安装向导(菜单名改为「切换运行模式」,
// 向导 secondRun 以 config 为真源,ENVCHECK 自动补装软项、硬项给手工指引)。
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '切换运行模式', click: () => { openWizard(); } },
    { label: '管理代码目录', click: () => { openRoots(); } },
    { label: '更新公共决策包', enabled: t4Allowed(ctx.consent), click: () => { openPanel(); runUpdateBase(true); } },
    { label: '上传本地向量', enabled: t4Allowed(ctx.consent), click: () => { openPanel(); runUploadKnn(true); } },
    { label: `上传本地向量(互惠)    ${t4Allowed(ctx.consent) ? '━●' : '○━'}`, click: () => { setConsent(!t4Allowed(ctx.consent)); } },
    { label: '修复钩子', click: () => { repairHooks('all'); } },
    { label: '打开数据目录', click: () => { if (ctx.paths?.dataDir) shell.openPath(ctx.paths.dataDir); } },
    { label: `开机自启    ${ctx.autorunOn ? '━●' : '○━'}`, click: async () => {
      const next = !ctx.autorunOn;
      const ok = await setAutorun(next);
      if (ok) { ctx.autorunOn = next; writeTrayState({ autoLaunch: next ? 'on' : 'off' }); }
      if (tray) tray.setContextMenu(buildMenu());
    } },
    { label: '退出', click: () => { runner.killAll(); app.quit(); } },
  ]);
}

function applySnapshot(snapshot) {
  ctx.snapshot = snapshot;
  ctx.consent = snapshot.consent;
  if (tray) {
    tray.setContextMenu(buildMenu());
    // 2026-11-17 用户裁决:悬浮提示改模型拉起状态(灯+类型+名,一行一模型),不再显示 ⚙ 状态句
    tray.setToolTip(modelTooltip(snapshot));
  }
  if (panel && !panel.isDestroyed()) panel.webContents.send('tray:snapshot', snapshot);
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
        const tail = (res.stderr || res.stdout || `exit ${res.code}`).slice(-400);
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
        const res = await runner.run('embed', nodeBin, args, {
          cwd: codeIndexRoot, label, timeoutMs: 60 * 60 * 1000,
        });
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
    ipcMain.handle('tray:sync-embed', () => runSyncJob(
      [`${ctx.paths?.codeIndexRoot || ''}/embed.mjs`],
      '立即同步 embed.mjs',
    ));
    // 先重写样本库并立刻刷新进度条(旧向量/新样本数),再后台嵌入;嵌入中靠进度文件推进分子。
    ipcMain.handle('tray:sync-vectors', async () => {
      if (syncBusy || ctx.snapshot?.embedPid != null) return { ok: true, busy: true };
      const { nodeBin, codeIndexRoot } = ctx.paths || {};
      if (!nodeBin || !codeIndexRoot) {
        dialog.showErrorBox('立即同步', '无法定位 code-index(paths.mjs 无响应)');
        return { ok: false, error: 'no-paths' };
      }
      syncBusy = true;
      const run = (args, label) => runner.run('embed', nodeBin, args, {
        cwd: codeIndexRoot, label, timeoutMs: 60 * 60 * 1000,
      });
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
    ipcMain.handle('tray:upload-knn', async () => {
      try { return await runUploadKnn(false); }
      catch (e) { return { ok: false, outcome: 'handler-throw', message: String(e?.message || e).slice(0, 200) }; }
    });
    ipcMain.handle('tray:set-consent', (_e, on) => {
      try { return setConsent(on); }
      catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
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
  app.on('before-quit', () => { quitting = true; });
}
