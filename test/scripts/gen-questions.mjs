/**
 * 按当前索引(chunks.jsonl)和 config.roots 现抽检索题。
 * SYM=符号拆词(不带文件名,去掉泛词);GAP=短中文或注解(不拼符号、不用整段独特口号)。
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP_NAME = /(?:^|\/)(?:package|tsconfig|jsconfig|eslint|prettier|commitlint|vite\.config)/i;
const OK_EXT = /\.(?:js|mjs|cjs|ts|tsx|vue)$/i;
const STOP = new Set([
  'function', 'export', 'default', 'const', 'index', 'src', 'vue', 'js', 'ts', 'mjs',
  'result', 'data', 'setup', 'methods', 'computed', 'props', 'emits', 'template', 'script', 'style',
  'placeholder', 'content', 'format', 'status', 'handler', 'render', 'list', 'item', 'click', 'value',
]);

export function splitIdent(name) {
  return String(name || '')
    .replace(/^(?:template|script|style):/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w.toLowerCase()));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 长中文切成 2~4 字,避免整段口号当开卷题。 */
function cjkHard(text) {
  const runs = String(text || '').match(/[\u4e00-\u9fff]{2,}/g) || [];
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const run of runs) {
    if (run.length <= 4) push(run);
    else {
      push(run.slice(0, 2));
      if (run.length >= 4) push(run.slice(2, 4));
    }
    if (out.length >= 2) break;
  }
  return out.slice(0, 2);
}

export function chunkQueries(chunk, annotation) {
  const ident = splitIdent(chunk.y);
  const y = String(chunk.y || '');
  const templateOnly = /^(?:template|script|style)$/.test(y.replace(/:.*$/, ''));
  const symQ = !templateOnly && ident.length >= 2 ? ident.join(' ').trim() : '';
  const body = String(chunk.t || '').split('\n').slice(1).join('\n');
  const cjk = cjkHard(body);
  let gapQ = (annotation && String(annotation).trim()) || '';
  if (!gapQ && cjk.length >= 2) gapQ = cjk.join(' ');
  else if (!gapQ && cjk.length === 1) gapQ = cjk[0];
  if (gapQ && gapQ === symQ) gapQ = '';
  return { symQ, gapQ };
}

function projectOf(p) {
  return String(p || '').replace(/\\/g, '/').split('/')[0] || '';
}

function inRoots(p, rootLabels) {
  if (!rootLabels || !rootLabels.size) return true;
  return rootLabels.has(projectOf(p));
}

function usable(chunk) {
  const p = String(chunk.p || '').replace(/\\/g, '/');
  if (!OK_EXT.test(p) || SKIP_NAME.test(p)) return false;
  if (!chunk.y || !String(chunk.y).replace(/^(?:template|script|style):/, '').trim()) return false;
  if ((chunk.e || 0) - (chunk.s || 0) < 8) return false;
  return true;
}

/** 从块清单抽题。nSym/nGap 按纳入项目均分,优先不同文件。 */
export function generateFromChunks(chunks, {
  nSym = 30,
  nGap = 20,
  seed = Date.now(),
  rootLabels = null,
  annotations = {},
} = {}) {
  const rnd = mulberry32(Number(seed) || 1);
  const pool = [];
  for (const c of chunks) {
    if (!usable(c) || !inRoots(c.p, rootLabels)) continue;
    const anno = annotations[String(c.p || '').replace(/\\/g, '/')];
    const { symQ, gapQ } = chunkQueries(c, anno);
    if (!symQ && !gapQ) continue;
    pool.push({ c, symQ, gapQ });
  }
  const byProj = new Map();
  for (const item of pool) {
    const k = projectOf(item.c.p) || '_';
    if (!byProj.has(k)) byProj.set(k, []);
    byProj.get(k).push(item);
  }
  for (const [k, list] of byProj) byProj.set(k, shuffle(list, rnd));

  const projects = shuffle([...byProj.keys()], rnd);
  const okKind = (it, kind) => (kind === 'SYM' ? it.symQ : it.gapQ);
  const preferGap = (it) => it.gapQ && it.gapQ !== it.symQ;
  const pickUnique = (want, kind) => {
    const picked = [];
    const usedFile = new Set();
    const takeRound = (pred) => {
      let n = 0;
      for (const proj of projects) {
        if (picked.length >= want) break;
        const list = byProj.get(proj) || [];
        const hit = list.find(pred);
        if (!hit) continue;
        usedFile.add(hit.c.p);
        picked.push(hit);
        n++;
      }
      return n;
    };
    let guard = 0;
    while (picked.length < want && guard++ < pool.length * 3) {
      const n = kind === 'GAP'
        ? takeRound((it) => !usedFile.has(it.c.p) && preferGap(it))
          || takeRound((it) => !usedFile.has(it.c.p) && it.gapQ)
        : takeRound((it) => !usedFile.has(it.c.p) && it.symQ);
      if (!n) break;
    }
    guard = 0;
    while (picked.length < want && guard++ < pool.length) {
      if (!takeRound((it) => okKind(it, kind) && !picked.includes(it))) break;
    }
    return picked.slice(0, want);
  };

  const pad = (n, i) => String(i + 1).padStart(Math.max(2, String(n).length), '0');
  const toRow = (it, type, i, n, query) => ({
    id: `${type}-${pad(n, i)}`,
    type,
    query,
    file: it.c.p,
    lines: [it.c.s, it.c.e],
    symbol: it.c.y || '',
    project: projectOf(it.c.p),
  });

  const syms = pickUnique(nSym, 'SYM');
  const gaps = pickUnique(nGap, 'GAP');
  const rows = [
    ...syms.map((it, i) => toRow(it, 'SYM', i, nSym, it.symQ)),
    ...gaps.map((it, i) => toRow(it, 'GAP', i, nGap, it.gapQ)),
  ];
  return { seed: Number(seed) || 1, rows, nPool: pool.length, projects };
}

export function loadChunks(dataDir) {
  const p = path.join(dataDir, 'chunks.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function loadRootLabels(dataDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'code-index.config.json'), 'utf8'));
    const roots = Array.isArray(cfg.roots) ? cfg.roots : [];
    return {
      labels: new Set(roots.map((r) => path.basename(r))),
      annotations: cfg.knownAnnotations && typeof cfg.knownAnnotations === 'object' ? cfg.knownAnnotations : {},
      roots,
    };
  } catch {
    return { labels: new Set(), annotations: {}, roots: [] };
  }
}

export function generateQuestions(dataDir, opts = {}) {
  const chunks = loadChunks(dataDir);
  if (!chunks.length) {
    throw new Error(`没有 ${path.join(dataDir, 'chunks.jsonl')},请先在 TokenSaver/code-index 跑 init/build`);
  }
  const { labels, annotations, roots } = loadRootLabels(dataDir);
  const out = generateFromChunks(chunks, {
    nSym: opts.nSym ?? 30,
    nGap: opts.nGap ?? 20,
    seed: opts.seed,
    rootLabels: labels.size ? labels : null,
    annotations,
  });
  out.roots = roots;
  return out;
}

export function writeQuestions(dataDir, generated) {
  const dir = path.join(dataDir, 'exp-regress');
  fs.mkdirSync(dir, { recursive: true });
  const dump = (name, rows) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    return p;
  };
  const all = generated.rows;
  const sym = all.filter((r) => r.type === 'SYM');
  const gap = all.filter((r) => r.type === 'GAP');
  const gtFile = dump('ground-truth.jsonl', all);
  const symFile = dump('ground-truth-sym.jsonl', sym);
  const gapFile = dump('ground-truth-gap.jsonl', gap);
  const metaFile = path.join(dir, 'ground-truth.meta.json');
  fs.writeFileSync(metaFile, JSON.stringify({
    at: new Date().toISOString(),
    seed: generated.seed,
    n: all.length,
    nSym: sym.length,
    nGap: gap.length,
    nPool: generated.nPool,
    projects: generated.projects,
    roots: generated.roots || [],
  }, null, 2) + '\n');
  return { gtFile, symFile, gapFile, metaFile, dir, nSym: sym.length, nGap: gap.length };
}
