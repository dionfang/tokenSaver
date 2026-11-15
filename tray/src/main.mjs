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
import { resolvePaths } from './util/paths.mjs';
import { createWizardController } from './wizard/controller.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, '..', 'assets', 'tray.png');
const PANEL_PRELOAD = path.join(here, '..', 'panel', 'preload.cjs');
const PANEL_HTML = path.join(here, '..', 'panel', 'index.html');
const WIZARD_HTML = path.join(here, '..', 'panel', 'wizard.html');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'TokenSaver';

const runner = createCmdRunner();
let tray = null;
let panel = null;
let poller = null;
let ctx = { paths: null, snapshot: null, autorunOn: false };

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
async function setAutorun(on) {
  const exe = process.execPath.replace(/electron\.exe$/i, 'electron.exe');
  const r = on
    ? await sh('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', `"${exe}"`, '/f'])
    : await sh('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
  return r.ok;
}

// ---------- 面板(§18-A4 一期必做;渲染进程零 Node,只走 preload 白名单通道) ----------
function openPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  panel = new BrowserWindow({
    title: 'TokenSaver 状态面板',
    width: 460, height: 560, resizable: true, show: false,
    webPreferences: { preload: PANEL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  panel.loadFile(PANEL_HTML);
  panel.once('ready-to-show', () => panel.show());
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
    sendState: (st) => { if (wizardWin && !wizardWin.isDestroyed()) wizardWin.webContents.send('wizard:state', st); },
    pickDirectories: async () => {
      const r = await dialog.showOpenDialog(wizardWin, { title: '选择要语义索引的目录', properties: ['openDirectory', 'multiSelections'] });
      return r.canceled ? null : r.filePaths;
    },
    execFile,
  });
  ipcMain.handle('wizard:action', (_e, name, payload) => wizardCtl.dispatch(name, payload));
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
    width: 640, height: 720, resizable: true, show: false,
    webPreferences: { preload: PANEL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  wizardWin.loadFile(WIZARD_HTML);
  wizardWin.once('ready-to-show', () => wizardWin.show());
  wizardWin.on('closed', () => { wizardWin = null; });
  wizardController(); // IPC 注册与控制器就绪先于渲染层首问
}

// ---------- 菜单动作 ----------
async function runKeepFresh() {
  const { nodeBin, codeIndexRoot } = ctx.paths || {};
  if (!nodeBin || !codeIndexRoot) return dialog.showErrorBox('立即保鲜', '无法定位 code-index(paths.mjs 无响应)');
  const res = await runner.run('auto', nodeBin, [`${codeIndexRoot}/auto.mjs`], { cwd: codeIndexRoot, label: '立即保鲜 auto.mjs' });
  if (res.skipped) return dialog.showMessageBox({ message: `有任务在跑(${res.busyFamily || '互斥任务'}),稍后再试`, buttons: ['知道了'] });
  const tail = (res.stderr || '').trim().split('\n').slice(-3).join('\n');
  if (res.code === 0) dialog.showMessageBox({ message: '保鲜完成', detail: tail || undefined, buttons: ['知道了'] });
  else dialog.showErrorBox('立即保鲜失败', `${res.timedOut ? '超时被终止\n' : ''}${tail || `exit ${res.code}`}`);
  poller?.slowRefresh('keep-fresh');
}

async function repairHooks(host) {
  const { nodeBin, codeIndexRoot } = ctx.paths || {};
  if (!nodeBin || !codeIndexRoot) return dialog.showErrorBox('修复钩子', '无法定位 code-index(paths.mjs 无响应)');
  const res = await runner.run('init', nodeBin, [`${codeIndexRoot}/init.mjs`, '--hooks', host], { cwd: codeIndexRoot, label: `修复钩子 ${host}` });
  if (res.skipped) return dialog.showMessageBox({ message: `有任务在跑(${res.busyFamily || '互斥任务'}),稍后再试`, buttons: ['知道了'] });
  if (res.code !== 0) {
    dialog.showErrorBox(`修复钩子失败(${host})`, `${res.timedOut ? '超时被终止\n' : ''}${(res.stderr || res.stdout || `exit ${res.code}`).slice(-400)}`);
    return;
  }
  dialog.showMessageBox({ message: `钩子修复完成(${host})`, buttons: ['知道了'] });
  poller?.slowRefresh('repair-hooks'); // 修完重跑 hooksStatus 刷新灯(§5.3.4)
}

function onUpdateBase() {
  // M1 壳:consent 门禁在本菜单生效;更新编排属 M4(§16.3),上线前点按只作说明,不发任何网络请求
  dialog.showMessageBox({ message: '更新 base 向量将在后续版本解锁(更新源服务尚未上线)', buttons: ['知道了'] });
}

// ---------- 菜单 ----------
const lampMark = { green: '🟢', yellow: '🟡', red: '🔴', absent: '⚪', empty: '⚪' };
const hookText = { green: '接线正确', red: '接线错误', absent: '未安装' };

function buildMenu() {
  const s = ctx.snapshot;
  const lamps = s?.lamps;
  const consent = s?.consent ?? { uploadLocalKnn: false };
  const mode = s?.modelIn === 'local' ? 'cpu模型' : s?.modelIn ? 'gpu模型' : '运行模式:未知';
  const summary = (s?.statusLine || '状态获取中…').slice(0, 80);
  return Menu.buildFromTemplate([
    { label: summary, enabled: false },
    { type: 'separator' },
    { label: `运行模式:${mode}`, enabled: false }, // B1 受控切换属 M3,一期只读
    { label: '立即保鲜', click: () => { runKeepFresh(); } },
    {
      label: consent.uploadLocalKnn ? '更新 base 向量' : '更新 base 向量（未同意上传，仅使用本机 KNN）',
      enabled: consent.uploadLocalKnn,
      click: onUpdateBase,
    },
    { type: 'separator' },
    { label: `ZCode 钩子:${lampMark[lamps?.hooks?.zcode] || '⚪'}${hookText[lamps?.hooks?.zcode] || '未检测'}`, enabled: false },
    { label: `Cursor 钩子:${lampMark[lamps?.hooks?.cursor] || '⚪'}${hookText[lamps?.hooks?.cursor] || '未检测'}`, enabled: false },
    { label: `Qoder 钩子:${lampMark[lamps?.hooks?.qoder] || '⚪'}${hookText[lamps?.hooks?.qoder] || '未检测'}`, enabled: false },
    {
      label: '修复钩子',
      submenu: [
        { label: 'ZCode', click: () => repairHooks('zcode') },
        { label: 'Cursor', click: () => repairHooks('cursor') },
        { label: 'Qoder', click: () => repairHooks('qoder') },
        { label: '全部', click: () => repairHooks('all') },
      ],
    },
    { type: 'separator' },
    { label: wizardDone() ? '重新运行安装向导' : '继续安装向导', click: () => openWizard() },
    { label: '打开 data 目录', click: () => { if (ctx.paths?.dataDir) shell.openPath(ctx.paths.dataDir); } },
    { type: 'checkbox', label: '开机自启', checked: ctx.autorunOn, click: async (item) => { ctx.autorunOn = await setAutorun(item.checked); writeTrayState({ autoLaunch: ctx.autorunOn ? 'on' : 'off' }); item.checked = ctx.autorunOn; } },
    { label: '退出', click: () => { runner.killAll(); app.quit(); } },
  ]);
}

function applySnapshot(snapshot) {
  ctx.snapshot = snapshot;
  ctx.consent = snapshot.consent;
  if (tray) {
    tray.setContextMenu(buildMenu());
    const age = snapshot.healthAt ? Math.max(0, Math.round((snapshot.at - snapshot.healthAt) / 1000)) : null;
    tray.setToolTip(`${(snapshot.statusLine || '状态获取中…').slice(0, 120)}${age != null ? `\n(${age} 秒前)` : ''}`);
  }
  if (panel && !panel.isDestroyed()) panel.webContents.send('tray:snapshot', snapshot);
}

// ---------- 启动 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => openPanel()); // 二次启动唤起首实例面板
  app.whenReady().then(async () => {
    ctx.paths = await resolvePaths();
    if (ctx.paths.degraded) dialog.showErrorBox('TokenSaver', '无法定位 code-index 数据目录(paths.mjs 无响应),状态展示可能不完整');
    ctx.autorunOn = await queryAutorun();
    const choice = readTrayState().autoLaunch; // A2 默认开:仅首跑(用户未做过选择)自动写入;用户关过就尊重
    if (choice == null) { if (!ctx.autorunOn) ctx.autorunOn = await setAutorun(true); writeTrayState({ autoLaunch: ctx.autorunOn ? 'on' : 'off' }); }
    poller = createPoller({
      paths: ctx.paths,
      cmdRun: runner.run.bind(runner),
      onSnapshot: applySnapshot,
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
    if (ctx.paths?.dataDir && !wizardDone()) openWizard(); // M2:无 done 记录=未完成向导,自动弹窗续引导(§5.5)
  });
  app.on('window-all-closed', (e) => { /* 托盘常驻:面板关了不退 */ });
}
