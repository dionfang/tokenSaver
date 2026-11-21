/**
 * onnxProbe.mjs — onnx 原生会话「崩溃隔离探针」(20261120 测试机静默死亡修复)。
 *
 * 背景(测试机实弹):embed.mjs 本进程加载 jina 时进程**静默死亡**——stderr 空、stdout 止于
 * 「改为本进程加载…threads=N」、退出码非 0。JS 级失败都有 console.error 兜底,stderr 空 ⇒
 * 死亡发生在 onnxruntime 原生会话创建/探针推理内(native crash / EDR 杀 / 非法指令),
 * 父进程任何 try/catch 都接不住,弹窗(stderr||stdout)只能显示三行 info,退出码还被遮住。
 *
 * 设计:把「创建 onnx session」这件会原生崩溃的事**先放进子进程**做一遍:
 *   - 子进程静默死(stderr 空+非 0)⇒ 崩溃被隔离在子进程,父进程回退 wasm EP(纯 wasm 不 dlopen 原生 .node);
 *   - 子进程带 [err] 死 ⇒ 原生错误文本原样 surfaced 定罪(不再静默);
 *   - 子进程活 ⇒ 本进程照旧 native(行为与现状逐字一致,零回归);
 *   - 结论按 ort+node+platform 版本缓存(dataDir/routing/onnx-native-probe.json),稳态零额外开销。
 * 探针子进程与主流程同 node 同 transformers 同 dtype/threads ⇒ 探针结论对主路径有效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const PROBE_MARKER = 'PROBE_OK';
const require_ = createRequire(import.meta.url);

/** 探针子进程脚本:只创建 session 不打推理批;活到结尾打 MARKER。device=wasm 时走 ort-web 不 dlopen 原生。 */
const PROBE_SCRIPT = `
const [,, modUrl] = process.argv;
const { env, pipeline } = await import(modUrl);
if (process.env.TS_HF_CACHE) env.cacheDir = process.env.TS_HF_CACHE;
env.allowLocalModels = true;
const t = Number(process.env.TS_THREADS || 0);
const sopt = t > 0 ? { session_options: { intraOpNumThreads: t, interOpNumThreads: 1 } } : {};
await pipeline('feature-extraction', process.env.TS_MODEL_ID, { dtype: process.env.TS_DTYPE || 'q8', ...sopt }); // 20261120 修:探针恒 native cpu 形态(不再传 device;'wasm' 非法值会抛 Unsupported device,回退语义改为不传=cpu 默认);20261120-S4-F3:dtype 从父进程参数传入(不再写死 q8)
console.log('${PROBE_MARKER}');
`;

/** 探针结论判定(纯函数):静默死⇒隔离回退 wasm;带错死⇒fail  surfaced;活⇒native。 */
export function decideProbeOutcome({ code = null, stdout = '', stderr = '', timedOut = false } = {}) {
  if (timedOut) return { action: 'wasm', reason: `onnx native 探针超时(疑似加载挂起,同 ollama idle-hang 类),回退 wasm` };
  if (code === 0 && String(stdout).includes(PROBE_MARKER)) return { action: 'native', reason: 'native 探针通过' };
  if (code === 0) return { action: 'fail', reason: `探针退出 0 但无 ${PROBE_MARKER} 标记(行为异常,拒绝猜测)` };
  if (String(stderr).trim()) return { action: 'fail', reason: `native 探针报错退出(code=${code}):${String(stderr).trim().slice(-300)}` };
  return { action: 'wasm', reason: `native 探针静默死亡(exit=${code},stderr 空)=原生级崩溃,已隔离在子进程,回退 wasm EP` };
}

/** 缓存键:平台+arch+ort 版本+node 版本+transformers 包版本+探针形态 dtype(任一变化重探;
 *  20261120-S4-F3:transformers 版本与 dtype 并入——包升级换加载形态或改 dtype 后旧缓存结论不再被引用;
 *  EDR 策略变化不在键内,可 --reprobe/删缓存文件强制)。 */
export function probeKey(dtype = 'q8') {
  let ort = 'none';
  try { ort = JSON.parse(fs.readFileSync(require_.resolve('onnxruntime-node/package.json'), 'utf8')).version; } catch { /* 无原生包 */ }
  let ts = 'none';
  try {
    // exports 子路径拦 package.json 直读——从主入口向上找包清单(同包目录即停)
    let d = path.dirname(require_.resolve('@huggingface/transformers'));
    for (let i = 0; i < 5 && d; i += 1) {
      const pj = path.join(d, 'package.json');
      if (fs.existsSync(pj)) { ts = JSON.parse(fs.readFileSync(pj, 'utf8')).version || 'none'; break; }
      d = path.dirname(d);
    }
  } catch { /* 解析失败按 none,与其他键段同容错 */ }
  return `${process.platform}-${process.arch}-ort${ort}-node${process.version}-ts${ts}-dtype${dtype}`;
}

export function probeCachePath(dataDir) { return path.join(dataDir, 'routing', 'onnx-native-probe.json'); }

export function readProbeCache(dataDir, key) {
  try {
    const j = JSON.parse(fs.readFileSync(probeCachePath(dataDir), 'utf8'));
    return j && j.key === key && (j.action === 'native' || j.action === 'wasm') ? j : null;
  } catch { return null; }
}

export function writeProbeCache(dataDir, key, action) {
  try {
    const p = probeCachePath(dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ key, action, at: Date.now() }) + '\n');
  } catch { /* 缓存写失败不影响主流程 */ }
}

/** transformers 入口 file URL(探针子进程按绝对 URL 导入,不依赖探针脚本落点)。可注入供测试。 */
export function transformersUrl() {
  return pathToFileURL(require_.resolve('@huggingface/transformers')).href;
}

/**
 * 跑一次崩溃隔离探针。返回 {code, stdout, stderr, timedOut}。
 * modUrl 可注入(测试用坏 URL 验 fail 路径);timeoutMs 到点树杀(同 cmdRunner 口径)。
 */
export function runOnnxProbe({ modelId, cacheDir, threads = 0, dtype = 'q8', device = 'cpu', timeoutMs = 180000, execPath = process.execPath, modUrl = null } = {}) {
  const url = modUrl || transformersUrl();
  const script = path.join(os.tmpdir(), `ts-onnx-probe-${process.pid}-${Date.now().toString(36)}.mjs`);
  fs.writeFileSync(script, PROBE_SCRIPT);
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; try { fs.unlinkSync(script); } catch { /* 已不在 */ } resolve(r); } };
    try {
      child = spawn(execPath, [script, url], {
        windowsHide: true,
        env: { ...process.env, TS_HF_CACHE: cacheDir || '', TS_MODEL_ID: modelId || '', TS_THREADS: String(threads || 0), TS_DTYPE: String(dtype || 'q8') },
      });
    } catch (e) { finish({ code: -1, stdout: '', stderr: String(e?.message || e), timedOut: false }); return; }
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { spawn(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32' ? ['/F', '/T', '/PID', String(child.pid)] : ['-9', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); } catch { /* 尽力 */ }
      setTimeout(() => finish({ code: child.exitCode, stdout, stderr, timedOut: true }), 1500);
    }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); finish({ code, stdout, stderr, timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); finish({ code: -1, stdout, stderr: stderr + String(e?.message || e), timedOut }); });
  });
}