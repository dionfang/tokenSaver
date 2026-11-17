/**
 * 向导控制器(tray 方案 §5.5/§16.4/§17.2,2026-11-15 M2):渲染进程动作 ↔ fsm/manifest/downloader/consent
 * 的总编排。electron 对象(dialog/shell)与 spawn 一律依赖注入(本模块零 electron import,node 可测);
 * 不 import code-index/**(§18-E1,init/hooksStatus 全走 spawn)。
 * Ollama 三分支(§17.2):MODE 步硬门禁(gpu 须服务在听);未装→代下官方安装包(recheck-ollama-setup,
 * 用户手动执行,「我已装好,重新检测」=recheck-ollama);不想装→改选 cpu。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// manifest/downloader 保留给 M4 base 包更新复用(2026-11-16 拍板 B:向导不再走清单下载);
import { probeOllama, createDownloader, httpRequest } from '../downloader.mjs';
import { createWizard } from './fsm.mjs';
import { detectNodeQualification, pickNodeBin } from './nodeSetup.mjs';
import { hfWeightCached } from '../util/paths.mjs';

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
  let envelope = { wizard: null, progress: null, hooks: null, nodeForm: null, installLog: [], installing: null }; // 发往渲染层的整体状态
  const downloader = createDownloader({ onProgress: (p) => { envelope.progress = p; sendState(envelope); sendProgress(p); } });

  /** 软项自动安装(2026-11-16 用户需求:检测到缺失即页面自动激活,CMD 滚动+进度条):
   *  spawn 长任务,stdout/stderr 逐行推 envelope.installLog(尾部 50 行),完成后重跑 envProbe 刷新自检。
   *  deps=npm install(npmmirror;需 node 就绪);weights=localResident 常驻(HuggingFace 懒下载,
   *  cpu 模式下常驻本就保留,完成判定=hfWeightCached 全 true 轮询)。 */

  function pushInstallLine(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      envelope.installLog.push(line);
    }
    if (envelope.installLog.length > 50) envelope.installLog = envelope.installLog.slice(-50);
    sendState({ ...envelope });
  }
  function startInstall(id, cmd, args, { cwd, pollWeights = false, shell = false } = {}) {
    if (envelope.installing) return { ok: false, reason: 'in-flight', message: `正在安装:${envelope.installing}` };
    envelope.installing = id;
    envelope.installLog = [];
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell, env: { ...process.env } });
    child.stdout?.on('data', pushInstallLine);
    child.stderr?.on('data', pushInstallLine);
    child.on('error', async (e) => { envelope.installing = null; envelope.installLog.push(`[fail] 启动失败:${e.message}`); await machine.runEnvChecks().catch(() => {}); sendState({ ...envelope }); });
    const finish = async (note) => {
      envelope.installing = null;
      if (note) envelope.installLog.push(note);
      await machine.runEnvChecks().catch(() => {}); // 重跑自检刷新 envChecks(缺失项转绿)
      sendState({ ...envelope });
    };
    if (pollWeights) {
      // 权重=localResident 常驻进程不退出;轮询 hf-cache 三项全缓存即判定完成(10min 兜底)
      const W = ['Xenova/jina-embeddings-v2-base-zh', 'Xenova/bge-reranker-base', 'strands:strands-decider-2B-hobson-v19:q4f16'];
      const t0 = Date.now();
      const timer = setInterval(() => {
        const all = W.every((mid) => hfWeightCached(paths.hfCacheDir, mid) === true);
        if (all) { clearInterval(timer); finish('[ok] 权重全部缓存完成(hf-cache)'); }
        else if (Date.now() - t0 > 10 * 60_000) { clearInterval(timer); finish('[warn] 下载超时——可点「重新自检」重试,或由首次使用懒下载补齐'); }
      }, 5000);
    } else {
      child.on('exit', (code) => finish(code === 0 ? '[ok] 依赖安装完成' : `[fail] npm 退出码 ${code}(可点「重新自检」重试)`));
    }
    sendState({ ...envelope });
    return { ok: true };
  }

  const nodeBinForWizard = () => pickNodeBin({ dataDir: paths.dataDir, qualified: nodeQualification });

  const machine = createWizard({
    dataDir: paths.dataDir,
    // 现有配置的 roots(2026-11-16 用户需求:第 1 步自动载入当前 roots,可增删后重新接线)
    readConfigRoots: () => {
      // 2026-11-16:返回数组但附带 modelIn(Array 是数组,附加属性仅在同源对象上可读;fsm 侧 cur.modelIn)
      try {
        const j = JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'code-index.config.json'), 'utf8'));
        const arr = Array.isArray(j.roots) ? j.roots.filter((r) => typeof r === 'string' && r) : [];
        arr.modelIn = typeof j.modelIn === 'string' ? j.modelIn : null;
        return arr;
      } catch { return []; }
    },
    checkOllama: () => probeOllama(ollamaBase ? { base: ollamaBase } : {}),
    // 环境自检(2026-11-16 拍板 B,替代清单下载):node=硬项(缺=接线跑不了,用户自行装);
    // deps=软项(init 接线时 npm install 自动补);权重=软项,真实检测 hf-cache 缓存。软项不阻断接线。
    envProbe: async () => {
      const nq = nodeQualification ?? await detectNodeQualification({ execFile });
      const depsOk = fs.existsSync(path.join(paths.codeIndexRoot, 'node_modules', '@huggingface', 'transformers'));
      const mode = machine.getState().runMode;
      const cfgModels = (() => { try { return JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'code-index.config.json'), 'utf8')).models ?? {}; } catch { return {}; } })();
      const checks = [
        { id: 'node', label: 'Node 运行时(≥20)', ok: nq?.ok === true, hard: true,
          hint: nq?.ok ? `已就绪${nq.version ? `(${nq.version})` : ''}` : '未检测到达标 Node——请自行安装 Node.js 20+ 后点「重新自检」' },
      ];
      // 2026-11-16 用户裁决:推理依赖(transformers/onnxruntime)仅 cpu 模式显示——gpu 推理走 Ollama,不需要它
      if (mode !== 'gpu') {
        checks.push({ id: 'deps', label: '推理依赖(transformers/onnxruntime)', ok: depsOk, hard: false,
          hint: depsOk ? '已安装' : '尚未安装——将自动安装(npmmirror),或接线时由 init 自动安装' });
      }
      // 三个模型的安装状态(2026-11-16 用户需求:始终显示,按模式分源):
      // gpu=Ollama /api/tags 已安装检测(未安装→检索/预热懒拉取或手动 pull);cpu=hf-cache 权重缓存。
      // 模型名 fallback 与 code-index/config.mjs models 同步(勿漂移)。
      const EMB = cfgModels.embedding || 'qwen3-embedding:0.6b';
      const RRK = cfgModels.reranker || 'sam860/qwen3-reranker:0.6b-F16';
      const DEC = cfgModels.decision || 'tev1:0.8b';
      const embId = cfgModels.localEmbedding || 'Xenova/jina-embeddings-v2-base-zh';
      const rrkId = cfgModels.localReranker || 'Xenova/bge-reranker-base';
      const decId = cfgModels.localDecision || 'strands:strands-decider-2B-hobson-v19:q4f16';
      if (mode === 'gpu') {
        let installed = null;
        try {
          const { status, res } = await httpRequest(`${ollamaBase || 'http://127.0.0.1:11434'}/api/tags`, { timeoutMs: 3000 });
          if (status === 200) { let txt = ''; res.setEncoding('utf8'); for await (const c of res) txt += c; installed = (JSON.parse(txt).models || []).map((m) => m.name); }
        } catch { /* 服务不在听 → 三项显示未知(不判红,MODE 门禁已过) */ }
        for (const [label, name] of [['嵌入模型', EMB], ['精排模型', RRK], ['决策模型', DEC]]) {
          const ok = installed == null ? false : installed.includes(name);
          // 2026-11-16 用户裁决:gpu 三模型行收紧为硬项——自动 pull 有出路(拉完自动放行),缺模型不放行
          checks.push({ id: `m-${name}`, label: `Ollama ${label} ${name}`, ok, hard: true, tag: name,
            hint: installed == null ? 'Ollama 未响应,无法确认' : ok ? '已安装' : '未安装——正在自动 ollama pull(或手动执行)' });
        }
      } else {
        // strands 权重:目录名含前缀、文件名带档位后缀(model_<quant>.onnx,实测 model_q4f16.onnx),不走 hfWeightCached 的 org/name 分支
        const cached = (id) => {
          if (!String(id).startsWith('strands:')) return hfWeightCached(paths.hfCacheDir ?? '', id) === true;
          const parts = String(id).split(':'); // [strands, dir, quant?]
          const dir = parts[1] ?? '';
          const quant = parts[2] ?? 'quantized';
          return fs.existsSync(path.join(paths.hfCacheDir ?? '', dir, `model_${quant}.onnx`))
            || fs.existsSync(path.join(paths.hfCacheDir ?? '', dir, 'model_quantized.onnx'));
        };
        // 2026-11-16 用户裁决:cpu 三行与 gpu 同格式显示具体模型名(本地 嵌入模型/精排模型/决策模型 <id>)
        for (const [label, id, pretty] of [
          ['嵌入模型', embId, embId],
          ['精排模型', rrkId, rrkId],
          ['决策模型', decId, `strands-${(decId.split(':')[1] || '').replace(/^strands-/, '')}(${decId.split(':')[2] || 'quantized'})`],
        ]) {
          const ok = cached(id);
          checks.push({ id: `w-${label}`, label: `本地${label} ${pretty}`, ok, hard: false,
            hint: ok ? '已缓存(hf-cache)' : '未缓存——首次使用时自动下载(HuggingFace)' });
        }
      }
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
   *  原分支①(代下官方安装包)整体移除;probe 短路逻辑保留在 MODE 步 UI 文案层(§17.2 口径修订)。
   *  2026-11-16 新增(B2/M3 能力提前落自检页):gpu 模式检出模型未安装 → 自动 /api/pull 流式拉取(真百分比)。 */

  /** 串行 pull 缺失模型:/api/pull NDJSON 流(status/completed/total→进度),失败继续下一个(单模型失败不阻断)。 */
  async function pullModels(models) {
    const base = ollamaBase || 'http://127.0.0.1:11434';
    for (const name of models) {
      envelope.installing = `pull:${name}`;
      envelope.installLog.push(`[pull] ollama pull ${name}`);
      sendState({ ...envelope });
      try {
        // S14-F1(2026-11-17):pull 加超时/取消——Ollama 挂死时不再无限等;120s 无进度即 abort(有进度续命)
        const ac = new AbortController();
        let pullTimer = setTimeout(() => ac.abort(new Error('pull 超时(120s 无进度)')), 120_000);
        const resp = await fetch(`${base}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal: ac.signal });
        if (!resp.ok || !resp.body) { clearTimeout(pullTimer); envelope.installLog.push(`[fail] HTTP ${resp.status}`); continue; }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = ''; let lastPct = -1; let okLine = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(pullTimer); pullTimer = setTimeout(() => ac.abort(new Error('pull 超时(120s 无进度)')), 120_000); // 收到数据=有进度,续命
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const j = JSON.parse(line);
              if (j.error) { envelope.installLog.push(`[fail] ${name}: ${j.error}`); continue; }
              if (j.total && j.completed != null) {
                const pct = Math.floor((j.completed / j.total) * 100);
                if (pct !== lastPct) { lastPct = pct; envelope.pullProgress = { model: name, pct }; envelope.installLog.push(`[pull] ${name} ${pct}%`); sendState({ ...envelope }); }
              } else if (j.status) {
                envelope.installLog.push(`[pull] ${name}: ${j.status}`);
                if (j.status === 'success') okLine = true;
                sendState({ ...envelope });
              }
            } catch { /* 半行,等下一段 */ }
          }
        }
        clearTimeout(pullTimer);
        envelope.installLog.push(okLine ? `[ok] ${name} 拉取完成` : `[fail] ${name} 拉取未确认成功`);
      } catch (e) {
        clearTimeout(pullTimer);
        envelope.installLog.push(`[fail] ${name}: ${e?.message || e}`);
      }
    }
    envelope.installing = null;
    envelope.pullProgress = null;
    await machine.runEnvChecks().catch(() => {}); // 重跑自检(tags 检测转绿)
    sendState({ ...envelope });
  }

  /** 统一自检入口:跑自检 → 缺失软项自动激活对应安装/pull(2026-11-16 用户需求)。
   *  load 复检与手动「重新自检」都必须走这里——此前激活逻辑只在 start-env-check case,
   *  load 复检发现缺模型后不激活(用户删模型进向导等不到自动拉取的根因)。 */
  async function refreshEnvChecks() {
    const r = await machine.runEnvChecks();
    const env = r.state?.envChecks ?? [];
    const mode = r.state?.runMode;
    const nodeOk = env.some((c) => c.id === 'node' && c.ok === true);
    // gpu 模式:缺模型 → 自动 /api/pull(不依赖 node,Ollama 服务已由 MODE 门禁保证)
    const missingModels = env.filter((c) => c.tag && c.ok !== true).map((c) => c.tag);
    if (!envelope.installing && mode === 'gpu' && missingModels.length) {
      pullModels(missingModels); // 异步串行,进度经 sendState 推送
      return { ...r, ok: true, message: `开始自动拉取 ${missingModels.length} 个 Ollama 模型` };
    }
    const depsBad = env.some((c) => c.id === 'deps' && c.ok !== true);
    const weightsBad = env.some((c) => c.id === 'weights' && c.ok !== true);
    if (!envelope.installing && nodeOk && (depsBad || weightsBad)) {
      const id = depsBad ? 'deps' : 'weights';
      startInstall(id,
        id === 'deps' ? 'npm install --ignore-scripts --registry=https://registry.npmmirror.com' : 'node',
        id === 'deps' ? [] : ['localResident.mjs'],
        { cwd: paths.codeIndexRoot, pollWeights: id === 'weights', shell: id === 'deps' });
    }
    return r;
  }

  async function dispatch(action, payload = {}) {
    switch (action) {
      case 'load': {
        const st = await machine.load();
        await refreshNodeForm();
        // 2026-11-16:重开向导=二次配置——done 态自动 reset 回第 1 步并打 secondRun 标志:
        // 该会话中途退出后草稿作废(load 见 secondRun+非 done → 从头),config 为真源重新加载。
        let base = st;
        if (st.status === 'DONE') { machine.reset({ secondRun: true }); base = await machine.load(); }
        const r = await refreshEnvChecks().catch(() => ({ state: { wizard: base } })); // load 复检同样自动激活(此前漏这条路径)
        return push({ wizard: r.state?.wizard ?? base, ...r });
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
        // 2026-11-16 拍板 B:环境自检替代清单下载;进行中重复调用给可见反馈(不再静默吞——用户实测「没反应」)
        if (envelope.checking) { sendState({ ...envelope }); return push({ ok: false, reason: 'in-flight', message: '自检进行中,请稍候…' }); }
        envelope.checking = true;
        sendState({ ...envelope }); // 立即推 checking 态(渲染层按钮禁用+「检测中…」)
        try {
          const r = await refreshEnvChecks();
          return push(r);
        } finally {
          envelope.checking = false;
          sendState({ ...envelope });
        }
      }
      case 'install-deps': return startInstall('deps', 'npm install --ignore-scripts --registry=https://registry.npmmirror.com', [], { cwd: paths.codeIndexRoot, shell: true });
      case 'install-weights': return startInstall('weights', 'node', ['localResident.mjs'], { cwd: paths.codeIndexRoot, pollWeights: true });
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
