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
// manifest/downloader 保留给 M4 base 包更新复用(2026-11-16 拍板 B:向导不再走清单下载);
import { probeOllama, createDownloader } from '../downloader.mjs';
import { createWizard } from './fsm.mjs';
import { detectNodeQualification, pickNodeBin } from './nodeSetup.mjs';

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
    execFile,                       // nodeSetup 用(注入 child_process.execFile)
    ollamaBase,
    openPath = async () => {},
  } = deps;
  // fetchText/clientVersion/manifestUrl/pins 已随拍板 B 移除(清单下载撤,M4 base 包复用时再回);
  // downloader 实例保留(manifest+downloader 模块原样保留供 M4)。
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
    // 环境自检(2026-11-16 拍板 B,替代清单下载):node=硬项(缺=接线跑不了,用户自行装);
    // deps=软项(init 接线时 npm install 自动补);权重/ollama=按模式展示。软项不阻断接线。
    envProbe: async () => {
      const nq = nodeQualification ?? await detectNodeQualification({ execFile });
      const depsOk = fs.existsSync(path.join(paths.codeIndexRoot, 'node_modules', '@huggingface', 'transformers'));
      const mode = machine.getState().runMode;
      const checks = [
        { id: 'node', label: 'Node 运行时(≥20)', ok: nq?.ok === true, hard: true,
          hint: nq?.ok ? `已就绪${nq.version ? `(${nq.version})` : ''}` : '未检测到达标 Node——请自行安装 Node.js 20+ 后点「重新自检」' },
        { id: 'deps', label: '推理依赖(transformers/onnxruntime)', ok: depsOk, hard: false,
          hint: depsOk ? '已安装' : '尚未安装——点「下一步」接线时由 init 自动安装(npm install)' },
      ];
      if (mode === 'gpu') checks.push({ id: 'ollama', label: 'Ollama 服务', ok: true, hard: true, hint: '已在运行(MODE 步已验证)' });
      else checks.push({ id: 'weights', label: 'cpu 模式权重', ok: true, hard: false, hint: '首次使用时自动下载(HuggingFace)' });
      return { checks };
    },
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

  /** 2026-11-16 用户裁决:不再代下载 Ollama 官方安装包——用户自行下载安装启动后点「重新检测」。
   *  原分支①(代下官方安装包)整体移除;probe 短路逻辑保留在 MODE 步 UI 文案层(§17.2 口径修订)。 */

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
      case 'start-env-check': {
        // 2026-11-16 拍板 B:环境自检替代清单下载;进行中重复调用静默跳过(fsm 层 in-flight)
        if (envelope.checking) return push();
        envelope.checking = true;
        sendState({ ...envelope });
        try {
          const r = await machine.runEnvChecks();
          return push(r);
        } finally {
          envelope.checking = false;
          sendState({ ...envelope });
        }
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
