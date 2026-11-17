#!/usr/bin/env node
/** 全离线包权重 staging(2026-11-17 用户拍板「全离线包」):
 *  把 code-index/hf-cache 三模型权重拷进 tray/build/weights,供 installer.nsh 在安装时
 *  直解到 $PROFILE\.tokensaver\hf-cache(packed 布局 hfCacheDir 单源落点)。
 *  源缺失即报错(禁止静默产出缺权重的「全离线包」)。predist 自动跑。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', '..', 'code-index', 'hf-cache');
const DST = path.join(here, 'weights');
// 2026-11-17 用户终裁:维持完整包(三权重随包)。半离线懒下载提案被否——strands 无公开下载源,
// 懒下载会把「找源/上传/等待」难度转嫁给客户;完整包装完零下载零配置。
const ITEMS = [
  ['Xenova/jina-embeddings-v2-base-zh', 'Xenova/jina-embeddings-v2-base-zh'],
  ['Xenova/bge-reranker-base', 'Xenova/bge-reranker-base'],
  ['strands-decider-2B-hobson-v19', 'strands-decider-2B-hobson-v19'],
];
fs.mkdirSync(DST, { recursive: true });
let total = 0;
for (const [rel, out] of ITEMS) {
  const s = path.join(SRC, rel);
  if (!fs.existsSync(s)) { console.error(`[err] 权重源缺失:${s}(全离线包禁止缺权重)`); process.exit(1); }
  const d = path.join(DST, out);
  fs.cpSync(s, d, { recursive: true, force: true });
  const bytes = fs.readdirSync(d, { recursive: true }).reduce((a, f) => {
    try { const st = fs.statSync(path.join(d, f)); return a + (st.isFile() ? st.size : 0); } catch { return a; }
  }, 0);
  total += bytes;
  console.log(`[ok] staged ${out} ${(bytes / 1024 / 1024).toFixed(0)}MB`);
}
console.log(`[ok] weights staging 完成,共 ${(total / 1024 / 1024 / 1024).toFixed(2)}GB → build/weights`);
