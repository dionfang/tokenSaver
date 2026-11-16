/**
 * 首次安装向导状态机(tray 方案 §16.4/§18-A1/B1/D1/E4,2026-11-15 M2):
 * 六态 INIT→ROOTS→MODE→CONSENT→DOWNLOAD→INIT_RUN→DONE,断点持久化 data/tray-wizard-state.json,
 * 任意非 DONE 态退出下次续跑;重入跳过已校验下载项。守卫全内联拍板口径:
 *   ROOTS→MODE      目录数不限(0=只装工具与钩子不索引,A1)
 *   MODE→CONSENT    选过 cpu|gpu;gpu 须 Ollama 服务在听(§17.2 硬门禁,未就绪禁用下一步)
 *   CONSENT→DOWNLOAD 总是可过(D1=c 可跳过;跳过=consent false+T4 禁用 local-only)
 *   DOWNLOAD→INIT_RUN common+mode 全部项 sha256 通过且落盘(C2/C3/C4/C5 配套)
 *   INIT_RUN→DONE   逐目录 init --roots + 一次 init --model-in 成功;失败停步显示 stderr
 * §17.1-7 Node 检测准入制:node-runtime 项存在且 PATH 无达标 node → 下载后、INIT_RUN 之前追加用户 PATH。
 * 全 IO 走依赖注入(node 直跑单测,零 electron);不 import code-index/**(§18-E1)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeConsent } from '../consent.mjs';

export const STEP_ORDER = ['INIT', 'ROOTS', 'MODE', 'CONSENT', 'DOWNLOAD', 'INIT_RUN', 'DONE'];
export const STATE_FILE = 'tray-wizard-state.json';
export const MIN_NODE_MAJOR = 20;

// ---------- 纯守卫 ----------

/** roots 预检(R4 逗号陷阱):绝对路径、无逗号、非空。 */
export function validateRootPath(p, { platform = process.platform } = {}) {
  if (typeof p !== 'string' || !p.trim()) return { ok: false, reason: 'empty', message: '目录路径为空' };
  if (p.includes(',')) return { ok: false, reason: 'comma-in-path', message: '路径含逗号,无法安全传给 init --roots,请改用不含逗号的目录' };
  if (!path.isAbsolute(p)) return { ok: false, reason: 'not-absolute', message: '须选择绝对路径目录' };
  if (platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(p)) return { ok: false, reason: 'not-absolute', message: '须选择绝对路径目录' };
  return { ok: true };
}

/** ROOTS→MODE:A1 拍板,0 目录也放行(UI 负责提示「未选目录:语义检索暂不可用,可稍后添加」)。 */
export function canLeaveRoots() { return { ok: true }; }

/** MODE→CONSENT:B1 硬门禁,gpu 须 Ollama 服务在听(未就绪两条解困:代下官方安装包后重检 / 改选 cpu)。 */
export function canLeaveMode({ runMode, ollamaReady }) {
  if (runMode !== 'cpu' && runMode !== 'gpu') return { ok: false, reason: 'mode-missing', message: '请先选择运行模式' };
  if (runMode === 'gpu' && ollamaReady !== true) return { ok: false, reason: 'ollama-not-ready', message: 'gpu模型 需要本机 Ollama 服务在运行;请安装/启动 Ollama 后点「重新检测」,或返回改选 cpu模型' };
  return { ok: true };
}

/** CONSENT→DOWNLOAD:D1=c 总是可过(跳过=consent false+T4 禁用+决策 KNN 仅本机 local 层)。 */
export function canLeaveConsent() { return { ok: true }; }

/** DOWNLOAD→INIT_RUN:清单内全部项(含 common 与 mode 项)已下载校验通过。 */
export function isDownloadComplete(items, downloads) {
  const need = (items ?? []).map((it) => it.id);
  if (!need.length) return { ok: false, reason: 'no-items', message: '尚未取得下载清单' };
  const missing = need.filter((id) => downloads?.[id]?.ok !== true);
  return missing.length ? { ok: false, reason: 'download-incomplete', message: `组件未下载完成:${missing.join(', ')}` } : { ok: true };
}

/** INIT_RUN 命令序列(纯,§16.4/§17.4):roots 非空→逐目录 `--roots <单个绝对路径>`;再 `--model-in <local|ollama>`。
 *  roots=0 只跑 --model-in(A1:只装工具与钩子,不索引)。等号写法 init 也认,这里统一空格写法。 */
export function initCommands({ roots = [], runMode }) {
  const cmds = [];
  // 2026-11-16(用户需求:向导二次运行换目录):接线用 --set-roots 替换语义(整表替换,可移除旧目录);
  // 逐目录各传一次(规避逗号路径陷阱,R4)。roots 为空=清空(传一次空值)。
  if (roots.length) for (const r of roots) cmds.push({ args: ['--set-roots', r], label: `接线目录 ${r}` });
  else cmds.push({ args: ['--set-roots', ''], label: '清空索引目录(不索引任何项目)' });
  cmds.push({ args: ['--model-in', runMode === 'gpu' ? 'ollama' : 'local'], label: '设置运行模式' });
  return cmds;
}

/** 待下载项(纯):已 ok 的跳过(重入不重下);其余保序。 */
export function pendingItems(items, downloads) {
  return (items ?? []).filter((it) => downloads?.[it.id]?.ok !== true);
}

// ---------- 状态机(全 IO 依赖注入) ----------

export function createWizard(deps) {
  const {
    dataDir,
    io = fs,
    now = () => Date.now(),
    persistConsent = (b) => writeConsent(dataDir, b),
    checkOllama,            // async () => ({ok:boolean, version?})
    fetchManifest,          // async () => ({ok:boolean, items?, error?, message?}) — 已按 mode 选好(common 项先行)
    downloadItems,          // async (items, {onProgress}) => ({results:[{itemId,status,error?}], stopped})
    verifyDownloaded,       // async (item) => boolean — 重入时逐项复验 sha(终名在且匹配)
    nodeQualified,          // () => ({ok:boolean, version?}) — PATH node ≥ MIN_NODE_MAJOR
    ensureNodeRuntime,      // async () => ({ok:boolean, error?}) — 下载 Node 后追加用户 PATH(HKCU 追加+广播)
    runInitCommand,         // async (cmd:{args,label}) => ({code, stdout, stderr, timedOut})
    readConfigRoots,        // () => string[] — 现有配置里的 roots(第 1 步初值;2026-11-16)
  } = deps;

  const file = path.join(dataDir, STATE_FILE);
  const blank = () => ({ status: 'INIT', roots: [], runMode: null, consent: null, ollamaReady: null, ollamaCheckedAt: null, items: null, downloads: {}, initLog: [], lastError: null, savedAt: null, doneAt: null });
  let state = blank();

  function save() {
    state.savedAt = now();
    const rec = state.status === 'DONE' ? { ...state, status: 'done' } : state; // 完成态契约:{status:'done',…}(§5.5/任务书)
    try { io.writeFileSync(file, JSON.stringify(rec, null, 1)); } catch { /* 状态写失败不阻断流程 */ }
    return state;
  }

  /** 断点恢复:读 tray-wizard-state.json;非 DONE 态对已记录 ok 的下载项逐项复验,坏项剔除待重下。 */
  async function load() {
    let j = null;
    try { j = JSON.parse(io.readFileSync(file, 'utf8')); } catch { j = null; }
    if (j?.status === 'done') j.status = 'DONE'; // 完成态文件小写 → 内部步骤名
    state = { ...blank(), ...(j || {}), items: Array.isArray(j?.items) ? j.items : null };
    // 2026-11-16(用户需求:向导二次调用换目录/换模式):首次进入且状态里没有目录时,
    // 自动载入「现有配置」的 roots(data/code-index.config.json),用户可在第 1 步增删后重新接线。
    if (!state.roots?.length && readConfigRoots) {
      try {
        const cur = readConfigRoots();
        if (Array.isArray(cur) && cur.length) { state.roots = cur.slice(); save(); }
      } catch { /* 读不到配置则保持空(首次安装路径) */ }
    }
    if (state.status !== 'DONE' && state.items && verifyDownloaded) {
      for (const it of state.items) {
        if (state.downloads?.[it.id]?.ok === true) {
          const still = await verifyDownloaded(it);
          if (!still) delete state.downloads[it.id];
        }
      }
      save();
    }
    return getState();
  }

  const getState = () => JSON.parse(JSON.stringify(state));

  function goto(step) { state.status = step; state.lastError = null; save(); return { ok: true, state: getState() }; }

  /** 前进一步(守卫拦截);DOWNLOAD 进入不自动开下(UI 调 startDownload),INIT_RUN 不经 next 完成。 */
  function next() {
    const s = state.status;
    if (s === 'INIT') return goto('ROOTS');
    if (s === 'ROOTS') { const g = canLeaveRoots(); return g.ok ? goto('MODE') : { ok: false, ...g }; }
    if (s === 'MODE') { const g = canLeaveMode(state); return g.ok ? goto('CONSENT') : { ok: false, ...g }; }
    if (s === 'CONSENT') { const g = canLeaveConsent(); return g.ok ? goto('DOWNLOAD') : { ok: false, ...g }; }
    if (s === 'DOWNLOAD') {
      const g = isDownloadComplete(state.items, state.downloads);
      return g.ok ? goto('INIT_RUN') : { ok: false, ...g };
    }
    if (s === 'INIT_RUN') return { ok: false, reason: 'init-not-run', message: '请先执行安装接线(init)' };
    return { ok: false, reason: 'already-done', message: '向导已完成' };
  }

  function back() {
    const i = STEP_ORDER.indexOf(state.status);
    if (i <= 0 || state.status === 'DONE') return { ok: false, reason: 'no-back' };
    state.status = STEP_ORDER[i - 1];
    state.lastError = null;
    save();
    return { ok: true, state: getState() };
  }

  // ---------- roots ----------
  function setRoots(list) {
    const bad = (list ?? []).find((p) => !validateRootPath(p).ok);
    if (bad) return { ok: false, ...validateRootPath(bad) };
    state.roots = [...new Set(list ?? [])];
    save();
    return { ok: true, state: getState() };
  }
  function addRoot(p) {
    const v = validateRootPath(p);
    if (!v.ok) return { ok: false, ...v };
    if (!state.roots.some((r) => r.toLowerCase() === p.toLowerCase())) state.roots.push(p);
    save();
    return { ok: true, state: getState() };
  }
  function removeRoot(p) { state.roots = state.roots.filter((r) => r !== p); save(); return { ok: true, state: getState() }; }

  // ---------- mode / ollama ----------
  function setRunMode(m) {
    if (m !== 'cpu' && m !== 'gpu') return { ok: false, reason: 'bad-mode', message: '运行模式只能是 cpu 或 gpu' };
    // 切模式必须作废已缓存清单/下载记录,否则 DOWNLOAD 会带着旧 mode 的 items 完成并 init 错后端
    if (state.runMode !== m) {
      state.runMode = m;
      state.items = null;
      state.downloads = {};
      state.lastError = null;
    } else {
      state.runMode = m;
    }
    save();
    return { ok: true, state: getState() };
  }
  async function recheckOllama() {
    const r = await checkOllama();
    state.ollamaReady = !!r.ok;
    state.ollamaCheckedAt = now();
    save();
    return { ok: r.ok, state: getState(), version: r.version ?? null };
  }

  // ---------- consent ----------
  function setConsent(b) {
    state.consent = b === true;
    persistConsent(state.consent);
    save();
    return { ok: true, state: getState() };
  }

  // ---------- download ----------
  async function prepareDownload() {
    if (state.items) return { ok: true, items: state.items };
    const r = await fetchManifest();
    if (!r.ok) { state.lastError = r.message || r.error || '清单拉取失败'; save(); return { ok: false, ...r }; }
    state.items = r.items;
    state.lastError = null;
    save();
    return { ok: true, items: r.items };
  }

  let downloading = false;
  async function startDownload({ onProgress = () => {} } = {}) {
    if (state.status !== 'DOWNLOAD') return { ok: false, reason: 'wrong-step', message: `当前不在下载步(${state.status})` };
    if (downloading) return { ok: false, reason: 'in-flight', message: '下载进行中,请勿重复开始' };
    downloading = true; // 必须在任何 await 之前置位,否则并发第二次调用会双写 .part
    try {
      const prep = await prepareDownload();
      if (!prep.ok) return prep;
      const todo = pendingItems(state.items, state.downloads);
      if (!todo.length) return { ok: true, results: [], complete: true };
      const { results } = await downloadItems(todo, { onProgress });
      for (const r of results) {
        if (r.status === 'ok') state.downloads[r.itemId] = { ok: true, at: now(), skipped: !!r.skipped };
        else if (r.status === 'failed') state.lastError = `${r.itemId}:${r.error || '下载失败'}`;
        save();
      }
      return { ok: !results.some((r) => r.status === 'failed'), results, complete: isDownloadComplete(state.items, state.downloads).ok };
    } finally { downloading = false; }
  }

  // ---------- init 接线 ----------
  async function runInit() {
    if (state.status !== 'INIT_RUN') return { ok: false, reason: 'wrong-step', message: `当前不在接线步(${state.status})` };
    const g = isDownloadComplete(state.items, state.downloads);
    if (!g.ok) return { ok: false, ...g };
    // §17.1-7:node-runtime 项在清单内且 PATH 无达标 node → 追加用户 PATH 必须发生在 init 之前
    const hasNodeRuntime = (state.items ?? []).some((it) => it.id === 'node-runtime' && state.downloads['node-runtime']?.ok === true);
    if (hasNodeRuntime && nodeQualified && !nodeQualified().ok) {
      const nr = await ensureNodeRuntime();
      if (!nr?.ok) {
        state.lastError = `Node 运行时接入失败:${nr?.error || '未知'}`;
        save();
        return { ok: false, reason: 'node-runtime', message: state.lastError };
      }
    }
    state.initLog = [];
    for (const cmd of initCommands({ roots: state.roots, runMode: state.runMode })) {
      const r = await runInitCommand(cmd);
      state.initLog.push({ label: cmd.label, args: cmd.args, code: r.code, stderrTail: String(r.stderr || '').slice(-500) });
      if (r.code !== 0) {
        state.lastError = `${cmd.label} 失败${r.timedOut ? '(超时)' : ''}:${String(r.stderr || r.stdout || `exit ${r.code}`).slice(-400)}`;
        save(); // 失败停在 INIT_RUN 显示 stderr(§16.4)
        return { ok: false, reason: 'init-failed', message: state.lastError, step: cmd.label };
      }
    }
    state.status = 'DONE';
    state.doneAt = now();
    state.lastError = null;
    save(); // 完成态:{status:'done',…}(托盘启动据此不再自动弹向导)
    return { ok: true, state: getState() };
  }

  /** 重跑向导(设置入口):清断点从头来;consent 文件不动。 */
  function reset() { state = blank(); save(); return getState(); }

  return { load, getState, next, back, setRoots, addRoot, removeRoot, setRunMode, recheckOllama, setConsent, prepareDownload, startDownload, runInit, reset };
}
