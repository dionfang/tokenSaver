/**
 * 托盘侧路径解析(tray 方案 §16.1/§18-E1):路径获取唯一通道=spawn `node code-index/paths.mjs`
 * 解析 stdout JSON;禁止托盘 import code-index/config 自行复述布局规则(单源铁律)。
 * NODE_BIN 检测准入制(§18-C7「接入已有」分支):取 PATH 上已有 node;探不到回退字面 'node'。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEIGHT_MODELS } from '../wizard/weightsOnline.mjs'; // Bug2:完成判定单源(文件清单+字节数)

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_CODE_INDEX = path.resolve(here, '..', '..', '..', 'code-index'); // 开发布局兜底(tray/src/util → 仓根/code-index)
// 2026-11-17 发行链:packed 布局=resources/node_modules/code-index(electron-builder extraResources);
// config.mjs isInsideNodeModules=true → hf-cache 归 ~/.tokensaver/hf-cache;data 由安装器 env 指 %LOCALAPPDATA%。
const PACKED_CODE_INDEX = process.resourcesPath ? path.join(process.resourcesPath, 'node_modules', 'code-index') : null;
// 20261123 修复(0.2.13 测试机首启弹窗「paths.mjs 无响应」):覆盖安装收尾窗内 resources 可能瞬时未落齐,
// existsSync(paths.mjs)=false 会令 CODE_INDEX_ROOT 落回 DEV 布局 → 兜底分支条件永假 → 弹窗死胡同复现。
// 判定改为「resourcesPath 在即 packed 形态」(装机形态恒有 resourcesPath;dev 无);瞬时缺失时 root 仍指
// packed 位置,resolvePaths 的 j=null 分支据 CODE_INDEX_ROOT===PACKED_CODE_INDEX 走 packedFallbackLayout。
const IS_PACKED = !!PACKED_CODE_INDEX;
const CODE_INDEX_ROOT = IS_PACKED ? PACKED_CODE_INDEX : DEV_CODE_INDEX;

let cached = null;

/** 探测 PATH 上的 node(C7 接入已有分支);探不到返回 'node'(让 spawn 自行解析 PATH)。 */
export function detectNodeBin() {
  return new Promise((resolve) => {
    try {
      const p = spawn('node', ['-v'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => resolve('node'));
      // S14-F9(20261118):原表达式两分支同值('node'/'node')=死表达式,版本校验形同虚设。
      // 实况:本探测只确认 PATH 上有 node 可用,解析出的二进制恒为 'node'(PATH 解析交 spawn),故版本校验不影响返回值。
      p.on('close', () => resolve('node'));
    } catch { resolve('node'); }
  });
}

/** packed 规范布局兜底(纯,DI 可测):微 CLI 不可达(典型=机器未装 Node)时,
 *  dataDir/hfCacheDir 仍是静态已知的(与双保险/安装器 env 同源口径)——无 Node 机器上
 *  向导能打开并展示「请安装 Node」硬项,而不是双错误框死胡同(2026-11-18 用户实测)。 */
export function packedFallbackLayout({ localAppData, home = os.homedir(), platform = process.platform, mkdir = () => {} } = {}) {
  const dataDir = platform === 'win32'
    ? path.join(localAppData || path.join(home, 'AppData', 'Local'), 'TokenSaver', 'data')
    : path.join(home, '.tokensaver', 'data');
  try { mkdir(dataDir); } catch { /* 兜底 mkdir 尽力 */ }
  return { packed: true, dataDir, hfCacheDir: path.join(home, '.tokensaver', 'hf-cache') };
}

/** spawn paths.mjs(30s 超时,失败时 packed 布局静态兜底;开发布局 degraded)。
 *  20261123:幂等缓存补瞬时窗自愈——首启撞安装收尾窗(资源未落齐)曾把 degraded 结果缓存死,
 *  后续启动永弹窗;cached 命中带 degraded/dataDir=null 时放弃缓存重解析一次。 */
export async function resolvePaths({ force = false } = {}) {
  if (cached && !force && !(cached.degraded || cached.dataDir == null)) return cached;
  const nodeBin = await detectNodeBin();
  const out = await new Promise((resolve) => {
    let child;
    try { child = spawn(nodeBin, [path.join(CODE_INDEX_ROOT, 'paths.mjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve(null); return; }
    let so = '';
    let se = '';
    const t = setTimeout(() => { try { child.kill(); } catch { /* 已退 */ } resolve(null); }, 30_000);
    child.stdout?.on('data', (d) => { so += d; });
    child.stderr?.on('data', (d) => { se += d; });
    child.on('error', () => { clearTimeout(t); resolve(null); });
    child.on('close', () => { clearTimeout(t); resolve(so.trim() || null); });
  });
  let j = null;
  try { j = out ? JSON.parse(out) : null; } catch { j = null; }
  if (!j) {
    // paths.mjs 不可达(典型=机器未装 Node;20261123 新增=覆盖安装收尾窗资源瞬时未落齐):
    // packed 布局规范路径静态可知(与双保险同源),直接兜底+建目录+回填 env——向导可开、
    // 自检展示「请安装 Node」硬项,不再是死胡同;开发布局无规范兜底,维持 degraded(degraded=真异常)。
    if (IS_PACKED) {
      const fb = packedFallbackLayout({
        localAppData: process.env.LOCALAPPDATA, home: os.homedir(), platform: process.platform,
        mkdir: (d) => fs.mkdirSync(d, { recursive: true }),
      });
      process.env.CODE_INDEX_DATA_DIR = fb.dataDir;
      cached = { ...fb, codeIndexRoot: CODE_INDEX_ROOT, version: null, nodeBin, degraded: false };
    } else {
      cached = { dataDir: null, hfCacheDir: null, codeIndexRoot: CODE_INDEX_ROOT, packed: false, version: null, nodeBin, degraded: true };
    }
  } else {
    cached = { ...j, nodeBin, degraded: false };
    // R1 双保险:packed 形态数据必须在 %LOCALAPPDATA%\TokenSaver\data(升级不清);
    // 任何落回安装目录/resources 内的结果都强制改道并注入 spawn env(钩子侧靠安装器广播的用户级 env)
    const wantData = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TokenSaver', 'data');
    if (cached.packed && path.resolve(cached.dataDir || '') !== path.resolve(wantData)) {
      cached.dataDir = wantData;
      process.env.CODE_INDEX_DATA_DIR = wantData;
    }
  }
  return cached;
}

/** hf-cache 权重目录存在性(local 模式模型灯红/黄分界,§5.3.1):
 *  兼容两种缓存布局(2026-11-16 实测修正):<hfCacheDir>/<org>/<name>/ 或 <hfCacheDir>/<org>--<name>/;
 *  hfCacheDir 未知时返回 null(不判红)。 */
// Bug2(20261118):完成判定=该模型**全部**清单文件存在且字节数相符。
// 旧 hfWeightCached 只查目录存在(下载器先 mkdir)→中断也判已缓存;strands 只查小图文件→_data 未下完也判已缓存。
function weightFilesComplete(hfCacheDir, prefix) {
  const entry = WEIGHT_MODELS.find((m) => (m.files || []).some((f) => f.dest.startsWith(prefix)));
  if (!entry) return null;
  return entry.files.every((f) => {
    try { const st = fs.statSync(path.join(hfCacheDir, f.dest)); return f.bytes == null || st.size === f.bytes; } catch { return false; }
  });
}
export function hfWeightCached(hfCacheDir, modelId) {
  if (!hfCacheDir || typeof modelId !== 'string' || !modelId.includes('/')) return null;
  const [org, name] = modelId.split('/');
  const entry = WEIGHT_MODELS.find((m) => (m.files || []).some((f) => f.dest.startsWith(`${org}/${name}/`)));
  if (!entry) return null;
  const check = (map) => entry.files.every((f) => {
    try { const st = fs.statSync(path.join(hfCacheDir, map(f.dest))); return f.bytes == null || st.size === f.bytes; } catch { return false; }
  });
  // 嵌套(Xenova/<name>/)与扁平(Xenova--<name>/)两种 transformers.js 缓存布局都认
  return check((d) => d) || check((d) => d.replace(`${org}/${name}/`, `${org}--${name}/`));
}

/** 本地权重缓存判定(向导自检与下载完成轮询共用单源,2026-11-17):
 *  strands:<dir>[:<quant>] 无 '/',hfWeightCached 恒 null——曾致 pollWeights 永不判完成、
 *  权重下载好后向导仍卡「安装中」直到 10min 兜底。strands 走目录+model_<quant>.onnx
 *  (回退 model_quantized.onnx);其余 org/name 委托 hfWeightCached。 */
export function localWeightCached(hfCacheDir, modelId) {
  if (!hfCacheDir || typeof modelId !== 'string') return null;
  if (!modelId.startsWith('strands:')) return hfWeightCached(hfCacheDir, modelId);
  const parts = modelId.split(':'); // [strands, dir, quant?]
  const dir = parts[1] ?? '';
  return weightFilesComplete(hfCacheDir, `${dir}/`); // Bug2:图+_data+tokenizer 全齐且字节相符才判已缓存
}
