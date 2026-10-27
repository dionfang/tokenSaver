/**
 * Ollama 守护模块:确认本地服务在位(**只探测与等待,绝不通过 cmd 拉起服务**)
 * - 探测 GET {base}/api/version
 * - 在 → 直接用(模型一律通过已运行服务的 API 加载,keep_alive 常驻)
 * - 不响应 → 查客户端进程(tasklist/pgrep):
 *     有进程(桌面版/serve 在跑,可能仍在启动)→ 只轮询等待就绪,不做任何拉起
 *     无进程 → 立即判定不可用。ollama 嵌入路径因此退 bm25;local 路径不调用本函数做向量检索。
 * 服务本身由使用者手动启动(桌面版 Ollama 或服务方式)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, loadConfig } from './config.mjs';
import { readVectorMeta } from './vectorStore.mjs';

export function resolveBase(explicit) {
  return explicit || loadConfig().ollamaBase;
}

async function probe(base, ms = 2000) {
  try {
    const r = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

/** 客户端进程是否已在运行(桌面版 ollama app.exe / CLI ollama.exe / serve 进程) */
export function ollamaProcessesRunning() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const out = (r.stdout || '').toLowerCase();
      return out.includes('"ollama app.exe"') || out.includes('"ollama.exe"');
    }
    const r = spawnSync('pgrep', ['-x', 'ollama'], { encoding: 'utf8' });
    return r.status === 0;
  } catch { return false; }
}

export async function ensureOllama({ base, timeoutMs = 30000, onInfo } = {}) {
  const b = resolveBase(base);
  if (await probe(b)) return { up: true, base: b };

  if (!ollamaProcessesRunning()) {
    onInfo?.(`[ollama] ${b} 不可达且无 Ollama 进程(不自动拉起服务,请手动启动 Ollama)`);
    return { up: false, base: b };
  }
  onInfo?.(`[ollama] 客户端进程已运行,等待服务就绪(${b})`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (await probe(b)) {
      onInfo?.(`[ollama] 服务就绪(${b})`);
      return { up: true, base: b };
    }
  }
  onInfo?.(`[ollama] 客户端在运行但 ${b} 不可达:核对 config.mjs 的 ollamaBase 与 Ollama 实际监听地址`);
  return { up: false, base: b };
}

// ---------- GPU/CPU 推理模式判定 ----------
// 双模型常驻实测约 3.2GB(嵌入 968MB@ctx2048 + 精排 2.2GB@ctx8192)。
// NVIDIA:nvidia-smi 读"空闲"显存判定(能感知其他程序占用);
// AMD/Intel:注册表 qwMemorySize 读"总"显存判定(WMI AdapterRAM 有 4GB 截断,不可用);
// 探测失败默认 GPU,Ollama 自身的自动分层/转 CPU 作为最终安全网。
// 通过每请求 options.num_gpu 生效(0=强制 CPU,-1=自动/GPU),无需动服务。
const GPU_NEED_FREE_MB = 3600;  // 空闲显存门槛(NVIDIA 按空闲判定)
const GPU_NEED_TOTAL_MB = 6144; // 总显存门槛(仅知总量时判定,给系统/其他程序留余量)
const GPU_CLASS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
let gpuModeCache;
export function resolveGpuMode() {
  if (gpuModeCache) return gpuModeCache;
  const mk = (mode, reason) => (gpuModeCache = { mode, numGpu: mode === 'cpu' ? 0 : -1, reason });
  const gpu = loadConfig().gpu;
  if (gpu === 'cpu') return mk('cpu', 'config.mjs gpu=cpu 强制 CPU');
  if (gpu === 'gpu') return mk('gpu', 'config.mjs gpu=gpu 强制 GPU');
  const gb = (mb) => (mb / 1024).toFixed(1);

  // 1) NVIDIA:按空闲显存
  for (const exe of ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe']) {
    try {
      const r = spawnSync(exe, ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status === 0 && r.stdout) {
        const freeMb = Number(r.stdout.trim().split(/\r?\n/)[0].replace(/[^0-9]/g, ''));
        if (Number.isFinite(freeMb) && freeMb > 0) {
          if (freeMb >= GPU_NEED_FREE_MB) return mk('gpu', `NVIDIA 显存空闲 ${gb(freeMb)}GB ≥ 需求 ${gb(GPU_NEED_FREE_MB)}GB`);
          return mk('cpu', `NVIDIA 显存空闲 ${gb(freeMb)}GB < 需求 ${gb(GPU_NEED_FREE_MB)}GB,改用 CPU`);
        }
      }
    } catch { /* 尝试下一路径 */ }
  }

  // 2) AMD/Intel(仅 Windows):注册表读总显存(REG_QWORD 十六进制 或 REG_BINARY 8字节小端)
  if (process.platform === 'win32') {
    try {
      let best = 0;
      for (let i = 0; i < 8; i++) {
        const r = spawnSync('reg', ['query', `${GPU_CLASS_KEY}\\${String(i).padStart(4, '0')}`, '/v', 'HardwareInformation.qwMemorySize'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
        if (r.status !== 0 || !r.stdout) continue;
        const m = r.stdout.match(/qwMemorySize\s+REG_(QWORD|BINARY)\s+(.+)/i);
        if (!m) continue;
        let bytes = 0;
        if (/QWORD/i.test(m[1])) bytes = Number(m[2].trim());
        else bytes = m[2].trim().split(/\s+/).slice(0, 8).reduce((s, h, idx) => s + parseInt(h, 16) * 256 ** idx, 0);
        if (Number.isFinite(bytes) && bytes > 0) best = Math.max(best, bytes / 1048576);
      }
      if (best > 0) {
        if (best >= GPU_NEED_TOTAL_MB) return mk('gpu', `显卡总显存 ${gb(best)}GB ≥ 门槛 ${gb(GPU_NEED_TOTAL_MB)}GB`);
        return mk('cpu', `显卡总显存 ${gb(best)}GB < 门槛 ${gb(GPU_NEED_TOTAL_MB)}GB,改用 CPU`);
      }
    } catch { /* 落入默认 */ }
  }

  // 3) 探测失败:默认 GPU,交由 Ollama 自动兜底
  return mk('gpu', '未能探测显存,默认 GPU(Ollama 放不下会自动分层)');
}

/** 注入到 Ollama 请求 options 的 GPU/CPU 开关(num_gpu;只在加载时生效) */
export function gpuOptions() {
  return resolveGpuMode().numGpu === 0 ? { num_gpu: 0 } : {};
}

const WARMED_PATH = path.join(DATA_DIR, '.last-warmed.json');

export function sameOllamaName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const parts = (s) => {
    const i = String(s).lastIndexOf(':');
    return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [String(s), 'latest'];
  };
  const [ba, ta] = parts(a);
  const [bb, tb] = parts(b);
  if (ba !== bb) return false;
  const latest = (t) => t === 'latest' || t === '';
  return ta === tb || (latest(ta) && latest(tb));
}

export function readLastWarmed() {
  try { return JSON.parse(fs.readFileSync(WARMED_PATH, 'utf8')); } catch { return null; }
}

export function rememberWarmedModels(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WARMED_PATH, JSON.stringify(state) + '\n');
}

/** 驻留名单里、既不是 keep 又对得上 extras 的,视为被替换的模型。不碰聊天模型。 */
export function replacedOllamaNames(runningNames, keep, extras) {
  const keepList = (keep || []).filter(Boolean);
  const extraList = (extras || []).filter(Boolean);
  const drop = [];
  for (const name of runningNames || []) {
    if (!name || keepList.some((k) => sameOllamaName(k, name))) continue;
    if (extraList.some((e) => sameOllamaName(e, name))) drop.push(name);
  }
  return drop;
}

export async function unloadOllamaModel(name, onInfo) {
  if (!name) return false;
  const base = resolveBase();
  try {
    await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, keep_alive: 0 }),
      signal: AbortSignal.timeout(15000),
    });
    onInfo?.(`[ollama] 已卸载 ${name}`);
    return true;
  } catch (e) {
    onInfo?.(`[warn] 卸载 ${name} 失败(${e.message})`);
    return false;
  }
}

function replacedExtras() {
  const prev = readLastWarmed() || {};
  return [prev.embedding, prev.reranker, readVectorMeta('ollama')?.model];
}

async function listPsModels() {
  const ps = await (await fetch(`${resolveBase()}/api/ps`, { signal: AbortSignal.timeout(3000) })).json();
  return ps.models || [];
}

/** 卸掉本工具上次驻留、现已不在 keep 里的 Ollama 模型。不卸载 keep 与无关模型。 */
export async function releaseReplacedOllamaModels(keep, onInfo) {
  try {
    const running = (await listPsModels()).map((m) => m.name || m.model);
    for (const name of replacedOllamaNames(running, keep, replacedExtras())) {
      await unloadOllamaModel(name, onInfo);
    }
  } catch { /* /api/ps 不可用则跳过 */ }
}

/**
 * 模型驻留位置同步:num_gpu 仅在加载时生效,若模型已按另一种模式驻留,
 * 后续请求只会复用旧实例。此函数查 /api/ps,位置与判定不符时先卸载
 * (keep_alive:0),让下一次带 num_gpu 的请求按目标模式重新加载。
 */
export async function ensureModelPlacement(models, onInfo) {
  const g = resolveGpuMode();
  const wantCpu = g.mode === 'cpu';
  try {
    const listed = await listPsModels();
    for (const m of listed) {
      const name = m.name || m.model;
      if (!models?.some((want) => sameOllamaName(want, name)) || !m.size) continue;
      const onGpu = m.size_vram / m.size > 0.9;
      const onCpu = m.size_vram / m.size < 0.1;
      if ((wantCpu && onGpu) || (!wantCpu && onCpu)) {
        await unloadOllamaModel(name, onInfo);
        onInfo?.(`[gpu] ${name} 当前在 ${wantCpu ? 'GPU' : 'CPU'},与判定不符,已卸载待按${wantCpu ? 'CPU' : 'GPU'}重载`);
      }
    }
  } catch { /* /api/ps 不可用则跳过同步 */ }
}
