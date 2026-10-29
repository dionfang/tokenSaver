#!/usr/bin/env node
/**
 * 代码索引构建器(项目无关;扫描根目录等配置见 code-index.config.json)
 * 逐行扫描全部源码,按行窗口切块(带函数/组件符号上下文),输出:
 *   data/chunks.jsonl  —— 每行一个块 {i,p,s,e,y,t}
 *   data/index.json    —— 清单(文件列表/行数/构建信息)
 *
 * 配置优先级:内置默认 < code-index.config.json < 环境变量 CODE_INDEX_ROOTS < CLI 参数
 * 用法:
 *   node build.mjs
 *   node build.mjs --roots "D:/a,D:/b"
 *   node build.mjs --roots=D:/a,D:/b
 * 两种写法都认。同时传时,命令行里后出现的那个生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR, gitHeadOf, findGitRoot, MODULE_DIR } from './config.mjs';

/** 工具目录是否是宿主仓的直接子目录(hub 部署)。 */
export function isHubDir(moduleDir) {
  const root = findGitRoot(moduleDir);
  return !!root && path.dirname(path.resolve(moduleDir)) === path.resolve(root);
}
// hub:宿主代码也纳入索引(用户可能自行改造工具);复制部署时仍排除工具自身
const HUB = isHubDir(MODULE_DIR);
const isModuleDir = (p) => path.relative(MODULE_DIR, p) === '';

/** 解析 --roots "a,b" 与 --roots=a,b。未传返回 null。 */
export function rootsFromArgv(argv) {
  let raw = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--roots') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        console.error('[err] --roots 需要逗号分隔的路径,例如 --roots "D:/a,D:/b"');
        process.exit(1);
      }
      raw = v;
      i++;
    } else if (a.startsWith('--roots=')) {
      raw = a.slice('--roots='.length);
    }
  }
  if (raw == null) return null;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) {
    console.error('[err] --roots 没有有效路径');
    process.exit(1);
  }
  return list.map(p => path.resolve(p));
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
const cfg = loadConfig();
const cliRoots = rootsFromArgv(process.argv.slice(2));
const ROOTS = cliRoots || cfg.roots.map(p => path.resolve(p));
if (!ROOTS.length) {
  console.error('[err] 未配置扫描根目录:在 code-index.config.json 的 roots 里填写,或执行 node build.mjs --roots "D:/a,D:/b"');
  process.exit(1);
}

// 以下均来自配置(可按项目栈调整):跳过的目录、收录扩展名、JSON 白名单、文件大小上限
const SKIP_DIRS = new Set(cfg.skipDirs);
const EXTS = new Set(cfg.exts);
const JSON_OK = new Set(cfg.jsonWhitelist);
const MAX_FILE_BYTES = cfg.maxFileBytes;

const TARGET_LINES = cfg.chunk.targetLines;   // 目标块行数
const MAX_LINES = cfg.chunk.maxLines;         // 块行数上限
const OVERLAP_LINES = cfg.chunk.overlapLines; // 相邻块重叠行数
const MIN_TAIL = cfg.chunk.minTail;           // 尾部不足此行数并入前块

const KEYWORD_BLOCK = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'new', 'typeof', 'delete', 'await']);

const SYM_RES = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?namespace\s+([A-Za-z_$][\w$]*)/,
];
// .vue / class 体内的方法定义(缩进 ≤ 2),排除关键字
const METHOD_RE = /^\s{1,2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;{=]*\)\s*\{/;
const VUE_SECTION_RE = /^<(template|script|style)[\s>]/;

const files = [];
for (const root of ROOTS) {
  if (!fs.existsSync(root)) {
    console.warn(`[warn] 根目录不存在,跳过: ${root}`);
    continue;
  }
  walk(root, root, files);
}

function walk(dir, root, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { console.warn(`[warn] 无法读取目录 ${dir}: ${e.message}`); return; }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) && !(HUB && isModuleDir(abs))) continue;
      walk(abs, root, out);
    } else if (ent.isFile()) {
      if (!HUB && isModuleDir(path.dirname(abs))) continue; // 排除索引工具自身
      const base = ent.name;
      const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
      const ok = EXTS.has(ext) || (ext === 'json' && JSON_OK.has(base));
      if (!ok) continue;
      const st = fs.statSync(abs);
      if (st.size > MAX_FILE_BYTES) { console.warn(`[skip>size] ${abs} (${Math.round(st.size / 1024)}KB)`); continue; }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const label = path.basename(root);
      out.push({ abs, display: `${label}/${rel}`, ext, root });
    }
  }
}

// ---------- 切块 ----------
const chunks = [];
let ci = 0;
let totalLines = 0;

for (const f of files) {
  const content = fs.readFileSync(f.abs, 'utf8');
  const lines = content.split(/\r?\n/);
  // 压缩/生成文件启发式:行少但平均行长超大
  const avgLen = content.length / Math.max(lines.length, 1);
  if (lines.length < 200 && avgLen > 250) { console.warn(`[skip>minified] ${f.display}`); continue; }

  totalLines += lines.length;

  // 逐行追踪最近一次顶层符号,作为块上下文
  let lastSym = '';
  let vueSection = '';
  const symOf = new Array(lines.length);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const vm = line.match(VUE_SECTION_RE);
    if (vm) vueSection = vm[1];
    let sym = null;
    for (const re of SYM_RES) {
      const m = line.match(re);
      if (m) { sym = m[1]; break; }
    }
    if (!sym) {
      const m = line.match(METHOD_RE);
      if (m && !KEYWORD_BLOCK.has(m[1])) sym = m[1];
    }
    if (sym) lastSym = sym;
    symOf[ln] = vueSection ? (lastSym ? `${vueSection}:${lastSym}` : vueSection) : lastSym;
  }

  let start = 0;
  const n = lines.length;
  while (start < n) {
    let end = Math.min(start + TARGET_LINES, n);
    if (end < n) {
      // 尝试吸附到下一条空行,避免把函数切断(不超过 MAX_LINES)
      let probe = end;
      while (probe < n && probe < start + MAX_LINES && lines[probe].trim() !== '') probe++;
      if (probe < start + MAX_LINES) end = probe;
      if (n - end < MIN_TAIL) end = n; // 尾部过短并入本块
    }
    const sym = symOf[start] || symOf[Math.max(start - 1, 0)] || '';
    const body = lines.slice(start, end).join('\n');
    chunks.push({
      i: ci++,
      p: f.display,
      s: start + 1,           // 1-based 起始行
      e: end,                 // 1-based 结束行(含)
      y: sym,
      t: `${f.display}${sym ? ` · ${sym}` : ''}\n${body}`,
    });
    if (end >= n) break;
    start = Math.max(end - OVERLAP_LINES, start + 1);
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'chunks.jsonl'), chunks.map(c => JSON.stringify(c)).join('\n'), 'utf8');
const manifest = {
  builtAt: new Date().toISOString(),
  roots: ROOTS,
  // 记录各 root 构建时的 git HEAD:auto 保鲜据此判定"HEAD 变了→重建,没变→跳过"(非 git root 走 24h 时间回退)
  rootsHeads: Object.fromEntries(ROOTS.map(r => [r, fs.existsSync(r) ? gitHeadOf(r) : null])),
  totalFiles: files.length,
  totalLines,
  totalChunks: chunks.length,
  files: files.map(f => ({ p: f.display, lines: 0 })), // 行数在下方回填
};
// 回填真实行数(与切块口径一致:跳过 minified 的文件不再列出)
manifest.files = [];
for (const f of files) {
  const content = fs.readFileSync(f.abs, 'utf8');
  const lines = content.split(/\r?\n/).length;
  const avgLen = content.length / Math.max(lines, 1);
  if (lines < 200 && avgLen > 250) continue;
  manifest.files.push({ p: f.display, lines });
}
fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log(`[ok] 文件 ${manifest.files.length} 个 / 共 ${totalLines.toLocaleString()} 行 / 切块 ${chunks.length} 个`);
console.log(`[ok] 输出 ${path.join(DATA_DIR, 'chunks.jsonl')} (${(fs.statSync(path.join(DATA_DIR, 'chunks.jsonl')).size / 1048576).toFixed(1)}MB)`);
}
