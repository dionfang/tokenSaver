/**
 * 面板 preload(§18-A4):contextBridge 白名单通道,仅暴露 onSnapshot 一个入口,
 * 渲染进程零 Node 权限(main 侧 webPreferences: contextIsolation+sandbox 已锁死)。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('trayPanel', {
  onSnapshot: (cb) => ipcRenderer.on('tray:snapshot', (_e, snapshot) => cb(snapshot)),
});
