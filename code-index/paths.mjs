#!/usr/bin/env node
/**
 * 路径真源微 CLI(tray 方案 §16.12-3/§17.1-6,2026-11-15):托盘侧唯一路径获取通道,
 * 与钩子/CLI 永远同源(config.mjs resolveLayout 单一实现),禁止托盘自行复述布局规则。
 *   node paths.mjs          # stdout JSON: { dataDir, hfCacheDir, codeIndexRoot, packed, version }
 * 纯只读;无参数。npm 镜像形态下 here=npm/、version=npm 包版本,resolveLayout 自动走 packed 分支。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, HF_CACHE_DIR, PACKED_INSTALL } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 纯函数(供单测):收集路径真源。 */
export function collectPaths({ moduleDir = here } = {}) {
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8')).version || null; } catch { /* 无 package.json 不致命 */ }
  return {
    dataDir: DATA_DIR,
    hfCacheDir: HF_CACHE_DIR,
    codeIndexRoot: moduleDir,
    packed: !!PACKED_INSTALL,
    version,
  };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (directRun) console.log(JSON.stringify(collectPaths(), null, 1));
