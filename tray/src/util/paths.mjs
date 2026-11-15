/**
 * 托盘侧路径解析(tray 方案 §16.1/§18-E1):路径获取唯一通道=spawn `node code-index/paths.mjs`
 * 解析 stdout JSON;禁止托盘 import code-index/config 自行复述布局规则(单源铁律)。
 * NODE_BIN 检测准入制(§18-C7「接入已有」分支):取 PATH 上已有 node;探不到回退字面 'node'。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_CODE_INDEX = path.resolve(here, '..', '..', '..', 'code-index'); // 开发布局兜底(tray/src/util → 仓根/code-index)

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
    try { child = spawn(nodeBin, [path.join(DEV_CODE_INDEX, 'paths.mjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
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
    // paths.mjs 不可达(部署形态异常):以开发布局兜底,标 degraded 供 UI 提示
    cached = { dataDir: null, hfCacheDir: null, codeIndexRoot: DEV_CODE_INDEX, packed: false, version: null, nodeBin, degraded: true };
  } else {
    cached = { ...j, nodeBin, degraded: false };
  }
  return cached;
}

/** hf-cache 权重目录存在性(local 模式模型灯红/黄分界,§5.3.1):
 *  transformers.js 缓存布局 <hfCacheDir>/<org>--<name>/;hfCacheDir 未知时返回 null(不判红)。 */
export function hfWeightCached(hfCacheDir, modelId) {
  if (!hfCacheDir || typeof modelId !== 'string' || !modelId.includes('/')) return null;
  try { return fs.existsSync(path.join(hfCacheDir, modelId.replace(/\//g, '--'))); } catch { return null; }
}
