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

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_CODE_INDEX = path.resolve(here, '..', '..', '..', 'code-index'); // 开发布局兜底(tray/src/util → 仓根/code-index)
// 2026-11-17 发行链:packed 布局=resources/node_modules/code-index(electron-builder extraResources);
// config.mjs isInsideNodeModules=true → hf-cache 归 ~/.tokensaver/hf-cache;data 由安装器 env 指 %LOCALAPPDATA%。
const PACKED_CODE_INDEX = process.resourcesPath ? path.join(process.resourcesPath, 'node_modules', 'code-index') : null;
const CODE_INDEX_ROOT = (PACKED_CODE_INDEX && fs.existsSync(path.join(PACKED_CODE_INDEX, 'paths.mjs'))) ? PACKED_CODE_INDEX : DEV_CODE_INDEX;

let cached = null;

/** 探测 PATH 上的 node(C7 接入已有分支);探不到返回 'node'(让 spawn 自行解析 PATH)。 */
export function detectNodeBin() {
  return new Promise((resolve) => {
    try {
      const p = spawn('node', ['-v'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => resolve('node'));
      p.on('close', (c) => resolve(c === 0 && /^v\d/.test(out.trim()) ? 'node' : 'node'));
    } catch { resolve('node'); }
  });
}

/** spawn paths.mjs(30s 超时,失败时开发布局兜底并标 degraded)。幂等缓存。 */
export async function resolvePaths({ force = false } = {}) {
  if (cached && !force) return cached;
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
    // paths.mjs 不可达(部署形态异常):以当前布局兜底,标 degraded 供 UI 提示
    cached = { dataDir: null, hfCacheDir: null, codeIndexRoot: CODE_INDEX_ROOT, packed: CODE_INDEX_ROOT === PACKED_CODE_INDEX, version: null, nodeBin, degraded: true };
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
export function hfWeightCached(hfCacheDir, modelId) {
  if (!hfCacheDir || typeof modelId !== 'string' || !modelId.includes('/')) return null;
  const [org, name] = modelId.split('/');
  try {
    return fs.existsSync(path.join(hfCacheDir, org, name)) || fs.existsSync(path.join(hfCacheDir, `${org}--${name}`));
  } catch { return null; }
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
  const quant = parts[2] ?? 'quantized';
  try {
    return fs.existsSync(path.join(hfCacheDir, dir, `model_${quant}.onnx`))
      || fs.existsSync(path.join(hfCacheDir, dir, 'model_quantized.onnx'));
  } catch { return null; }
}
