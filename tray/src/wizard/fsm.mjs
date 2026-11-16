/**
 * 首次安装向导状态机(tray 方案 §16.4/§18-A1/B1/D1/E4,2026-11-15 M2;**2026-11-16 拍板 B:撤清单下载**):
 * 六态 INIT→ROOTS→MODE→ENVCHECK→CONSENT→INIT_RUN→DONE(2026-11-16 用户裁决:自检在数据上传前),断点持久化 data/tray-wizard-state.json,
 * 任意非 DONE 态退出下次续跑。守卫全内联拍板口径:
 *   ROOTS→MODE      目录数不限(0=只装工具与钩子不索引,A1)
 *   MODE→CONSENT    选过 cpu|gpu;gpu 须 Ollama 服务在听(§17.2 硬门禁,未就绪禁用下一步)
 *   CONSENT→ENVCHECK 总是可过(D1=c 可跳过;跳过=consent false+T4 禁用 local-only)
 *   ENVCHECK→INIT_RUN 环境自检全部硬项通过(node 缺失=硬阻断;deps/权重缺失=软项,由接线/懒加载自动补)
 *   INIT_RUN→DONE   init --set-roots 逐目录 + --model-in 成功;失败停步显示 stderr
 * B 案理由:Node/deps/权重在 init 现场组装已走通(npm install+懒下载),清单下载=重复建设;
 * downloader/manifest 模块保留给 M4 base 包更新复用。全 IO 依赖注入;不 import code-index/**(§18-E1)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeConsent } from '../consent.mjs';

export const STEP_ORDER = ['INIT', 'ROOTS', 'MODE', 'ENVCHECK', 'CONSENT', 'INIT_RUN', 'DONE'];
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

/** ENVCHECK→INIT_RUN(2026-11-16 拍板 B:环境自检替代清单下载):
 *  硬项=node 就绪(缺失=接线也跑不了,用户自行安装 Node≥20);
 *  软项=deps/权重(缺失由 init npm install/首次使用懒下载自动补,不阻断);
 *  ollama 项 gpu 模式必绿(MODE 门禁已保证),此处仅展示。 */
export function isEnvReady(checks) {
  const list = checks ?? [];
  if (!list.length) return { ok: false, reason: 'not-checked', message: '尚未执行环境自检' };
  const hardFail = list.filter((c) => c.hard && c.ok !== true);
  return hardFail.length
    ? { ok: false, reason: 'env-incomplete', message: `环境未就绪:${hardFail.map((c) => c.label).join(', ')}` }
    : { ok: true };
}

/** INIT_RUN 命令序列(纯,§16.4/§17.4):roots 非空→逐目录 `--roots <单个绝对路径>`;再 `--model-in <local|ollama>`。
 *  roots=0 只跑 --model-in(A1:只装工具与钩子,不索引)。等号写法 init 也认,这里统一空格写法。 */
export function initCommands({ roots = [], runMode }) {
  const cmds = [];
  // 2026-11-16 修复:替换语义下逐目录多次 spawn=每次整表覆盖,最后一次赢(只接入最后一个目录的根因)。
  // 改单次 spawn 携带多个 --set-roots 参数——init 单进程内解析累积后整表替换一次,无逗号陷阱(R4)。
  if (roots.length) {
    const args = [];
    for (const r of roots) args.push('--set-roots', r);
    cmds.push({ args, label: `接线目录 ×${roots.length}` });
  } else {
    cmds.push({ args: ['--set-roots', ''], label: '清空索引目录(不索引任何项目)' });
  }
  cmds.push({ args: ['--model-in', runMode === 'gpu' ? 'ollama' : 'local'], label: '设置运行模式' });
  return cmds;
}

/** 待重检项(纯):保留给 M4 base 包下载复用。 */
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
    runInitCommand,         // async (cmd:{args,label}) => ({code, stdout, stderr, timedOut})
    readConfigRoots,        // () => string[] — 现有配置里的 roots(第 1 步初值;2026-11-16)
    envProbe,               // async () => ({checks:[{id,label,ok,hard,hint}]}) — 环境自检(2026-11-16 拍板 B)
  } = deps;

  const file = path.join(dataDir, STATE_FILE);
  const blank = () => ({ status: 'INIT', roots: [], runMode: null, consent: null, ollamaReady: null, ollamaCheckedAt: null, envChecks: null, initLog: [], lastError: null, savedAt: null, doneAt: null });
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
    // 旧版状态名迁移(2026-11-16 拍板 B 后):DOWNLOAD 语义等价 ENVCHECK(都在接线前);
    // 其他未知状态(损坏/未来版本)→ 重置 INIT,防 死锁(不匹配任何分支,next/back 全失效)
    if (j?.status === 'DOWNLOAD') j.status = 'ENVCHECK';
    if (j?.status && !STEP_ORDER.includes(j.status) && j.status !== 'DONE') { j = { status: 'INIT' }; }
    state = { ...blank(), ...(j || {}) };
    // 旧版(清单下载)状态字段迁移:items/downloads 已废(2026-11-16 拍板 B),直接丢弃
    delete state.items; delete state.downloads;
    if (!Array.isArray(state.envChecks)) state.envChecks = null;
    // 2026-11-16(用户需求:向导二次调用换目录/换模式):首次进入且状态里没有目录时,
    // 自动载入「现有配置」的 roots(data/code-index.config.json),用户可在第 1 步增删后重新接线。
    if (!state.roots?.length && readConfigRoots) {
      try {
        const cur = readConfigRoots();
        if (Array.isArray(cur) && cur.length) { state.roots = cur.slice(); save(); }
      } catch { /* 读不到配置则保持空(首次安装路径) */ }
    }
    if (state.status !== 'DONE' && state.envChecks) {
      // 2026-11-16 修复:删掉此处的内部 envProbe 复检——controller 的 load case 统一走
      // refreshEnvChecks(持锁+自动激活)。此前 load 内 probe(不持 checking 锁)与 runEnvChecks
      // 并发竞态,双跑 5-10s 是「卡在检测中」与「重新自检没反应」的主因。
    }
    return getState();
  }

  const getState = () => JSON.parse(JSON.stringify(state));

  function goto(step) { state.status = step; state.lastError = null; save(); return { ok: true, state: getState() }; }

  /** 前进一步(守卫拦截);ENVCHECK 进入后 UI 调 start-env-check;INIT_RUN 不经 next 完成。
   *  2026-11-16 用户裁决:ENVCHECK 移到 CONSENT 之前(先确认环境能装,再谈数据上传)。 */
  function next() {
    const s = state.status;
    if (s === 'INIT') return goto('ROOTS');
    if (s === 'ROOTS') { const g = canLeaveRoots(); return g.ok ? goto('MODE') : { ok: false, ...g }; }
    if (s === 'MODE') { const g = canLeaveMode(state); return g.ok ? goto('ENVCHECK') : { ok: false, ...g }; }
    if (s === 'ENVCHECK') {
      const g = isEnvReady(state.envChecks);
      return g.ok ? goto('CONSENT') : { ok: false, ...g };
    }
    if (s === 'CONSENT') { const g = canLeaveConsent(); return g.ok ? goto('INIT_RUN') : { ok: false, ...g }; }
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
    // 切模式作废自检结果(不同模式检查项不同:cpu 看权重,gpu 看 Ollama)
    if (state.runMode !== m) {
      state.runMode = m;
      state.envChecks = null;
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

  // ---------- 环境自检(2026-11-16 拍板 B,替代清单下载) ----------
  let checking = false;
  async function runEnvChecks() {
    if (state.status !== 'ENVCHECK') return { ok: false, reason: 'wrong-step', message: `当前不在自检步(${state.status})` };
    if (checking) return { ok: false, reason: 'in-flight', message: '自检进行中' };
    if (!envProbe) return { ok: false, reason: 'no-probe', message: '自检探针未注入' };
    checking = true;
    try {
      const r = await envProbe();
      state.envChecks = r.checks ?? r;
      state.lastError = null;
      save();
      return { ok: true, state: getState() };
    } catch (e) {
      state.lastError = String(e?.message || e);
      save();
      return { ok: false, reason: 'probe-failed', message: state.lastError };
    } finally { checking = false; }
  }

  // ---------- init 接线 ----------
  async function runInit() {
    if (state.status !== 'INIT_RUN') return { ok: false, reason: 'wrong-step', message: `当前不在接线步(${state.status})` };
    const g = isEnvReady(state.envChecks);
    if (!g.ok) return { ok: false, ...g };
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

  return { load, getState, next, back, setRoots, addRoot, removeRoot, setRunMode, recheckOllama, setConsent, runEnvChecks, runInit, reset };
}
