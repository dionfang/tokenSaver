#!/usr/bin/env node
/**
 * 生成 CODE_DETAILS.md —— 各 root 代码的符号级细节清单
 * 数据源:data/chunks.jsonl(每块的 file:行区间+函数符号)+ data/index.json(行数)
 * 输出:按 项目 → 目录 → 文件 组织,每个文件列出全部符号及首次出现行号;
 *       已深挖过的关键文件附带一句用途注解(KNOWN)。
 * 用法:node details.mjs   (需先 node build.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chunks = fs.readFileSync(path.join(DATA_DIR, 'chunks.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const idx = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8'));

// 关键文件用途注解:来自 code-index.config.json 的 knownAnnotations(随项目配置迁移)
const KNOWN = loadConfig().knownAnnotations;

// 聚合:file → 排序去重符号
const byFile = new Map();
const chunkCount = new Map();
for (const c of chunks) {
  if (!byFile.has(c.p)) { byFile.set(c.p, new Map()); chunkCount.set(c.p, 0); }
  chunkCount.set(c.p, chunkCount.get(c.p) + 1);
  if (c.y) {
    const syms = byFile.get(c.p);
    if (!syms.has(c.y)) syms.set(c.y, c.s); // 首次出现行
  }
}
const lineMap = new Map(idx.files.map(f => [f.p, f.lines]));

// 组织:项目 → 目录 → 文件
const tree = new Map();
for (const file of byFile.keys()) {
  const parts = file.split('/');
  const proj = parts[0];
  const dir = parts.slice(0, -1).join('/') || '(根目录)';
  if (!tree.has(proj)) tree.set(proj, new Map());
  if (!tree.get(proj).has(dir)) tree.get(proj).set(dir, []);
  tree.get(proj).get(dir).push(file);
}

const out = [];
out.push('# CODE_DETAILS —— 代码符号级细节清单');
out.push('');
out.push(`> 自动生成自索引数据,勿手改。生成时间:${idx.builtAt};代码变更后重跑 \`node details.mjs\`。`);
out.push(`> 覆盖:${idx.files.length} 文件 / ${idx.totalLines.toLocaleString()} 行 / ${idx.totalChunks} 块。`);
out.push('> 符号后数字 = 该符号所在起始行(由切块推断,近似值);带 ※ 的文件附已知用途注解。');
out.push('> 检索建议:先 CODE_MAP.md 看架构,再本清单找符号,或直接 search.mjs 语义定位。');
out.push('');

const projOrder = ['foodFocus', 'Node.js', 'foodfocusAdmin'];
for (const proj of [...tree.keys()].sort((a, b) => {
  const ia = projOrder.indexOf(a);
  const ib = projOrder.indexOf(b);
  return (ia < 0 ? projOrder.length : ia) - (ib < 0 ? projOrder.length : ib);
})) {
  const dirs = tree.get(proj);
  const pFiles = [...dirs.values()].flat();
  const pLines = pFiles.reduce((s, f) => s + (lineMap.get(f) || 0), 0);
  out.push(`# ${proj}(${pFiles.length} 文件 / ${pLines.toLocaleString()} 行)`);
  out.push('');
  for (const dir of [...dirs.keys()].sort()) {
    const files = dirs.get(dir);
    const dLines = files.reduce((s, f) => s + (lineMap.get(f) || 0), 0);
    out.push(`## ${dir}(${files.length} 文件 / ${dLines.toLocaleString()} 行)`);
    out.push('');
    for (const f of files.sort((a, b) => (lineMap.get(b) || 0) - (lineMap.get(a) || 0))) {
      const lines = lineMap.get(f) || 0;
      const known = KNOWN[f];
      out.push(`### ${f.replace(proj + '/', '')}(${lines} 行,${chunkCount.get(f)} 块)${known ? ' ※' : ''}`);
      if (known) out.push(`> ${known}`);
      const syms = [...byFile.get(f).entries()].sort((a, b) => a[1] - b[1]);
      if (syms.length) {
        out.push('`' + syms.map(([n, l]) => `${n}:${l}`).join(' · ') + '`');
      }
      out.push('');
    }
  }
}

const OUT_PATH = path.join(DATA_DIR, 'CODE_DETAILS.md');
fs.writeFileSync(OUT_PATH, out.join('\n'), 'utf8');
console.log(`[ok] ${OUT_PATH}`);
console.log(`     ${byFile.size} 文件、${[...byFile.values()].reduce((s, m) => s + m.size, 0)} 个符号,文档 ${(fs.statSync(OUT_PATH).size / 1024).toFixed(0)}KB / ${out.length} 行`);
