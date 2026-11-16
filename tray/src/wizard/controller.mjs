/**
 * 向导控制器(tray 方案 §5.5/§16.4/§17.2,2026-11-15 M2):渲染进程动作 ↔ fsm/manifest/downloader/consent
 * 的总编排。electron 对象(dialog/shell)与 spawn 一律依赖注入(本模块零 electron import,node 可测);
 * 不 import code-index/**(§18-E1,init/hooksStatus 全走 spawn)。
 * Ollama 三分支(§17.2):MODE 步硬门禁(gpu 须服务在听);未装→代下官方安装包(recheck-ollama-setup,
 * 用户手动执行,「我已装好,重新检测」=recheck-ollama);不想装→改选 cpu。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchComponentsManifest, selectItems, MANIFEST_URL, PINS } from '../manifest.mjs';
import { createDownloader, probeOllama, sha256File, httpRequest } from '../downloader.mjs';
import { createWizard } from './fsm.mjs';
import { detectNodeQualification, pickNodeBin, ensureManagedNodeRuntime } from './nodeSetup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 生产 fetchText:http GET → 文本(清单拉取)。 */
export async function fetchTextViaHttp(url, { timeoutMs = 15_000 } = {}) {
  const { status, res } = await httpRequest(url, { timeoutMs });
  let txt = '';
  res.setEncoding('utf8');
  for await (const c of res) txt += c;
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return txt;
}

function defaultClientVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

export function createWizardController(deps) {
  const {
    paths,                          // {dataDir, codeIndexRoot, nodeBin}
    cmdRun,                         // runner.run(family, file, args, opts)(init/hooksStatus 互斥族)
    sendState = () => {},
    sendProgress = () => {},
    pickDirectories,                // async () => string[]|null(注入 dialog.showOpenDialog)
    fetchText = fetchTextViaHttp,
    execFile,                       // nodeSetup 用(注入 child_process.execFile)
    clientVersion = defaultClientVersion(),
    manifestUrl = MANIFEST_URL,
    pins = PINS,
    ollamaBase,
    openPath = async () => {},
  } = deps;

  const downloadBase = paths.dataDir; // dest 相对 data/(runtime/…、resources/…、weights/…,§16.6)
  let envelope = { wizard: null, progress: null, hooks: null, nodeForm: null }; // 发往渲染层的整体状态
  const downloader = createDownloader({ onProgress: (p) => { envelope.progress = p; sendState(envelope); sendProgress(p); } });

  const nodeBinForWizard = () => pickNodeBin({ dataDir: paths.dataDir, qualified: nodeQualification });

  const machine = createWizard({
    dataDir: paths.dataDir,
    // 现有配置的 roots(2026-11-16 用户需求:第 1 步自动载入当前 roots,可增删后重新接线)
    readConfigRoots: () => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'code-index.config.json'), 'utf8'));
        return Array.isArray(j.roots) ? j.roots.filter((r) => typeof r === 'string' && r) : [];
      } catch { return []; }
    },
    checkOllama: () => probeOllama(ollamaBase ? { base: ollamaBase } : {}),
    fetchManifest: async () => {
      const r = await fetchComponentsManifest(manifestUrl, { fetchText, clientVersion, pins });
      if (!r.ok) return r; // network/bad-signature/client-too-old(C5:解析即比对,锁向导提示升级)
      const sel = selectItems(r.manifest, { mode: machine.getState().runMode });
      if (!sel.ok) return sel;
      return { ok: true, items: sel.items };
    },
    downloadItems: (items, { onProgress }) => downloader.runQueue(items, {
      baseDir: downloadBase,
      ...(ollamaBase ? { ollamaBase } : {}),
      ...(onProgress ? { onProgress: (p) => { onProgress(p); } } : {}), // fsm 层转发(双通道冗余,渲染层只吃 controller 的)
    }),
    verifyDownloaded: async (item) => {
      if (item.type === 'ollama-pull') return true; // 模型在 Ollama 自管库,离线复验不可行,信任完成记录
      const dest = item.dest?.startsWith('/') || item.dest?.includes('..') ? null : path.join(downloadBase, item.dest);
      if (!dest || !fs.existsSync(dest)) return false;
      try { return (await sha256File(dest)) === String(item.sha256).toLowerCase(); } catch { return false; }
    },
    nodeQualified: () => nodeQualification,
    ensureNodeRuntime: async () => ensureManagedNodeRuntime({ dataDir: paths.dataDir, execFile }),
    runInitCommand: async (cmd) => {
      const nb = nodeBinForWizard();
      return cmdRun('init', nb, [path.join(paths.codeIndexRoot, 'init.mjs'), ...cmd.args], { cwd: paths.codeIndexRoot, timeoutMs: 300_000, label: cmd.label });
    },
  });

  let nodeQualification = { ok: false, version: null, reason: 'unchecked' };
  const refreshNodeForm = async () => { nodeQualification = await detectNodeQualification({ execFile }); envelope.nodeForm = nodeQualification; return nodeQualification; };

  const push = (extra = {}) => { envelope.wizard = machine.getState(); sendState({ ...envelope, ...extra }); return envelope; };

  /** init 完成后拉一次三端钩子灯(spawn hooksStatus,失败不阻断 DONE)。 */
  async function refreshHooks() {
    try {
      const r = await cmdRun('hooksStatus', nodeBinForWizard(), [path.join(paths.codeIndexRoot, 'hooksStatus.mjs')], { cwd: paths.codeIndexRoot });
      if (r.code === 0 && r.stdout.trim()) envelope.hooks = JSON.parse(r.stdout);
    } catch { /* 灯失败不阻断向导 */ }
  }

  /** §17.2 分支①:向导内代下 Ollama 官方安装包(钉版本+sha256,用户手动执行)。 */
  async function downloadOllamaSetup() {
    // 已检测到 Ollama 在跑 → 无需下载安装包(2026-11-16 用户反馈「点了没反应」后加的语义短路)
    try {
      const probe = await probeOllama(ollamaBase ? { base: ollamaBase } : {});
      if (probe?.ok) return { ok: true, message: `已检测到 Ollama 服务在运行${probe.version ? `(版本 ${probe.version})` : ''},无需下载官方安装包` };
    } catch { /* 探测失败继续走下载流程 */ }
    const r = await fetchComponentsManifest(manifestUrl, { fetchText, clientVersion, pins });
    if (!r.ok) return { ...r, message: r.message || `清单拉取失败(${r.error || 'unknown'})` };
    const item = r.manifest.items.find((it) => it.id === 'ollama-setup');
    if (!item) return { ok: false, error: 'no-item', message: '清单缺少 ollama-setup 项' };
    const res = await downloader.downloadFileItem(item, { baseDir: downloadBase });
    if (res.status === 'ok') return { ok: true, file: path.join(downloadBase, item.dest) };
    return { ok: false, error: res.status, message: res.error || 'Ollama 安装包下载失败' };
  }

  async function dispatch(action, payload = {}) {
    switch (action) {
      case 'load': {
        const st = await machine.load();
        await refreshNodeForm();
        return push({ wizard: st });
      }
      case 'next': { const r = machine.next(); return push(r); }
      case 'back': { const r = machine.back(); return push(r); }
      case 'pick-roots': {
        const dirs = await pickDirectories();
        if (dirs?.length) for (const d of dirs) machine.addRoot(d);
        return push();
      }
      case 'set-roots': return push(machine.setRoots(payload.list ?? []));
      case 'remove-root': return push(machine.removeRoot(payload.dir));
      case 'set-mode': { const r = machine.setRunMode(payload.mode); return push(r); }
      case 'recheck-ollama': { const r = await machine.recheckOllama(); envelope.ollamaVersion = r.version ?? null; return push(r); }
      case 'set-consent': return push(machine.setConsent(payload.checked === true));
      case 'start-download':
      case 'retry': {
        if (envelope.downloading) return push({ ok: false, reason: 'in-flight', message: '下载进行中' });
        envelope.downloading = true;
        sendState({ ...envelope });
        try {
          const r = await machine.startDownload({ onProgress: () => {} });
          return push(r);
        } finally {
          envelope.downloading = false;
          sendState({ ...envelope });
        }
      }
      case 'pause': downloader.pause(); return push();
      case 'cancel': downloader.cancel(); return push();
      case 'download-ollama-setup': {
        const r = await downloadOllamaSetup();
        if (r.ok && r.file) {
          envelope.ollamaSetup = r.file;
          await openPath(r.file);
        }
        return push(r);
      }
      case 'open-ollama-setup': {
        const file = envelope.ollamaSetup || path.join(downloadBase, 'runtime', 'OllamaSetup.exe');
        const ok = fs.existsSync(file);
        if (ok) await openPath(file);
        return { ok, file, message: ok ? '已打开安装包' : '安装包尚未下载,请先点「下载 Ollama 官方安装包」' };
      }
      case 'run-init': {
        const r = await machine.runInit();
        await refreshHooks();
        return push(r);
      }
      case 'reset': return push({ wizard: machine.reset() });
      // 2026-11-16:二次配置(换目录/换模式)——已完成过的向导重开时状态为 DONE,需重置回流程起点再载入现有配置
      case 'reset-reload': {
        machine.reset();
        const st = await machine.load();
        return push({ wizard: st });
      }
      default: return { ok: false, error: 'unknown-action', message: `未知向导动作:${action}` };
    }
  }

  return { dispatch, machine, downloader, refreshNodeForm };
}
