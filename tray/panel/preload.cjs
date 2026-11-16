/**
 * 面板/向导 preload(§18-A4,2026-11-15 M1/M2;2026-11-15 修复:沙箱 preload 不支持 ESM,改 CJS):
 * contextBridge 白名单通道,渲染进程零 Node 权限(main 侧 contextIsolation+sandbox 已锁死)。
 * 沙箱 preload 唯一可用 require='electron'(Electron 官方限制);.mjs+import 形态会整段加载失败
 * (SyntaxError: Cannot use import statement outside a module)→ window.trayPanel undefined → 面板恒「检测中」。
 * M1:面板只读快照;M2 增向导白名单动作通道(onState 单向推送 + action 白名单 invoke,无自由 IPC)。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayPanel', {
  onSnapshot: (cb) => ipcRenderer.on('tray:snapshot', (_e, snapshot) => cb(snapshot)),
  refresh: () => ipcRenderer.invoke('tray:refresh'),
  repairHooks: () => ipcRenderer.invoke('tray:repair-hooks'),
  syncEmbed: () => ipcRenderer.invoke('tray:sync-embed'),
  syncVectors: () => ipcRenderer.invoke('tray:sync-vectors'),
});

contextBridge.exposeInMainWorld('trayRoots', {
  list: () => ipcRenderer.invoke('tray:roots-list'),
  add: () => ipcRenderer.invoke('tray:roots-add'),
  remove: (target) => ipcRenderer.invoke('tray:roots-remove', target),
});

// 向导白名单动作(§5.5 五步向导):动作名固定枚举,payload 为纯数据;渲染层不得直接触网/触盘。
const WIZARD_ACTIONS = new Set([
  'load', 'next', 'back', 'pick-roots', 'set-roots', 'remove-root', 'set-mode',
  'recheck-ollama', 'set-consent', 'start-env-check', 'install-deps', 'install-weights',
  'run-init', 'reset', 'reset-reload',
]);

contextBridge.exposeInMainWorld('trayWizard', {
  onState: (cb) => ipcRenderer.on('wizard:state', (_e, state) => cb(state)),
  action: (name, payload) => (WIZARD_ACTIONS.has(name) ? ipcRenderer.invoke('wizard:action', name, payload ?? {}) : Promise.resolve({ ok: false, error: 'unknown-action' })),
});
