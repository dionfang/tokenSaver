#!/usr/bin/env node
/**
 * 全量检索回归:对 ground-truth.jsonl 逐条跑 code-index/search.mjs --json,判分文件/区间 Recall 与 MRR。
 *   node regress.mjs --gt ground-truth.jsonl --out results.jsonl [--rerun id,id] -- [--k 8] [--rerank] [--mode bm25]
 *   node regress.mjs --suite [--seed N] [--n-sym 30] [--n-gap 20]
 *     按当前索引/roots 现抽 SYM+GAP 题,再跑 bm25/hybrid/rerank。
 *     数据目录:CODE_INDEX_DATA_DIR 或 TokenSaver/data。--gt 可对已有 jsonl 跑单臂。
 */
import { generateQuestions, writeQuestions } from './gen-questions.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeIndex = path.join(here, '..', 'code-index');
const argv = process.argv.slice(2);
const take = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const asSuite = argv.includes('--suite');
if (asSuite) argv.splice(argv.indexOf('--suite'), 1);
const gtPath = take('--gt');
const outPath = take('--out');
const rerunRaw = take('--rerun');
const seedRaw = take('--seed');
const nSym = Number(take('--n-sym') || 30);
const nGap = Number(take('--n-gap') || 20);
if (argv[0] === '--') argv.shift();
if (!asSuite && (!gtPath || !outPath)) {
  console.error('用法: node regress.mjs --gt ground-truth.jsonl --out results.jsonl [--rerun id,id] -- [--k 8] [--rerank] [--mode bm25]');
  console.error('     node regress.mjs --suite [--seed N] [--n-sym 30] [--n-gap 20]');
  process.exit(1);
}

const suffixMatch = (resultFile, gtFile) => String(resultFile || '').replace(/\\/g, '/').endsWith(gtFile);
const overlap = (a, b) => a[0] <= b[1] && b[0] <= a[1];

function parseResults(stdout) {
  const s = String(stdout || '');
  const start = s.search(/\[[\s\n]*\{/);
  const end = s.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error(`no json array; stdout: ${s.slice(0, 160)}`);
  return JSON.parse(s.slice(start, end + 1));
}

function runSearch(query, searchArgs) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['search.mjs', query, '--json', ...searchArgs], {
    cwd: codeIndex, encoding: 'utf8', timeout: 180000, windowsHide: true, env: process.env,
  });
  const ms = Date.now() - t0;
  if (r.status !== 0) {
    return { ms, ok: false, err: String(r.stderr || r.stdout || '').slice(-400), results: [] };
  }
  try {
    return { ms, ok: true, err: null, results: parseResults(r.stdout) };
  } catch (e) {
    return { ms, ok: false, err: `${e.message}`, results: [] };
  }
}

function grade(gtById, rows) {
  const main = rows.filter((r) => !String(r.id).endsWith(' re'));
  const reruns = new Map(rows.filter((r) => String(r.id).endsWith(' re')).map((r) => [r.id.replace(/ re$/, ''), r]));
  const n = main.length;
  let fileR5 = 0, fileR8 = 0, rangeR5 = 0, rangeR8 = 0, mrrFile = 0, mrrRange = 0, fails = 0;
  const latencies = [];
  const misses = [];
  for (const r of main) {
    latencies.push(r.ms);
    const g = gtById.get(r.id);
    if (!g || !r.ok) { fails++; misses.push(r.id); continue; }
    let fileRank = 0, rangeRank = 0;
    r.results.forEach((res, i) => {
      const rank = i + 1;
      if (!suffixMatch(res.file, g.file)) return;
      if (!fileRank) fileRank = rank;
      if (!rangeRank && overlap(res.lines || [0, 0], g.lines)) rangeRank = rank;
    });
    if (fileRank && fileRank <= 5) fileR5++;
    if (fileRank && fileRank <= 8) fileR8++;
    if (fileRank) mrrFile += 1 / fileRank;
    else misses.push(r.id);
    if (rangeRank && rangeRank <= 5) rangeR5++;
    if (rangeRank && rangeRank <= 8) rangeR8++;
    if (rangeRank) mrrRange += 1 / rangeRank;
  }
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
  let determinism = null;
  if (reruns.size) {
    let same = 0;
    const key = (x) => (x?.ok ? (x.results || []).slice(0, 5).map((h) => `${h.file}:${h.lines?.[0]}`).join('|') : 'ERR');
    for (const [id, re] of reruns) {
      if (key(main.find((r) => r.id === id)) === key(re)) same++;
    }
    determinism = { checked: reruns.size, identicalTop5: same };
  }
  return {
    n, fails, misses,
    fileR5: `${fileR5}/${n}`, fileR8: `${fileR8}/${n}`,
    rangeR5: `${rangeR5}/${n}`, rangeR8: `${rangeR8}/${n}`,
    mrrFile: (mrrFile / n).toFixed(3), mrrRange: (mrrRange / n).toFixed(3),
    latencyMs: { p50: pct(0.5), p95: pct(0.95) },
    determinism,
  };
}

function runArm({ name, gtFile, outFile, searchArgs, rerunIds = [] }) {
  const gt = fs.readFileSync(gtFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const gtById = new Map(gt.map((g) => [g.id, g]));
  const rerun = new Set(rerunIds);
  const rows = [];
  for (const g of gt) {
    const entry = { id: g.id, type: g.type, query: g.query, ...runSearch(g.query, searchArgs) };
    rows.push(entry);
    console.error(`[${name}] ${entry.ok ? 'ok' : 'ERR'} ${g.id} ${entry.ok ? `${entry.results.length} hits ${entry.ms}ms` : entry.err}`);
    if (rerun.has(g.id)) {
      const re = { id: `${g.id} re`, type: g.type, query: g.query, ...runSearch(g.query, searchArgs) };
      rows.push(re);
      console.error(`[${name}] ${re.ok ? 'ok' : 'ERR'} ${re.id} ${re.ok ? `${re.ms}ms` : re.err}`);
    }
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, rows.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const summary = { name, gt: gtFile, args: searchArgs, ...grade(gtById, rows), out: outFile };
  fs.writeFileSync(outFile.replace(/\.jsonl$/, '') + '.grade.json', JSON.stringify(summary, null, 2) + '\n');
  console.error(`[${name}] fileR5 ${summary.fileR5} fileR8 ${summary.fileR8} mrrFile ${summary.mrrFile} p50 ${summary.latencyMs.p50}ms`);
  return summary;
}

if (asSuite) {
  const dataDir = process.env.CODE_INDEX_DATA_DIR
    ? path.resolve(process.env.CODE_INDEX_DATA_DIR)
    : path.join(here, '..', 'data');
  let generated;
  try {
    generated = generateQuestions(dataDir, {
      seed: seedRaw != null ? Number(seedRaw) : Date.now(),
      nSym,
      nGap,
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!generated.rows.length) {
    console.error(`抽题为 0:检查 ${dataDir} 的 chunks.jsonl 与 roots`);
    process.exit(1);
  }
  const written = writeQuestions(dataDir, generated);
  const { dir: outDir, symFile, gapFile } = written;
  console.error(`抽题 ${generated.rows.length} 条 SYM=${written.nSym} GAP=${written.nGap} seed=${generated.seed} 项目=${(generated.projects || []).join(',') || '(无)'}`);
  const rerun = generated.rows.filter((r) => r.type === 'SYM').slice(0, 5).map((r) => r.id);
  const jobs = [];
  if (written.nSym) {
    jobs.push(
      { name: 'sym-bm25', gtFile: symFile, searchArgs: ['--k', '8', '--mode', 'bm25'] },
      { name: 'sym-hybrid', gtFile: symFile, searchArgs: ['--k', '8'] },
      { name: 'sym-rerank', gtFile: symFile, searchArgs: ['--k', '8', '--rerank'], rerunIds: rerun },
    );
  }
  if (written.nGap) {
    jobs.push(
      { name: 'gap-bm25', gtFile: gapFile, searchArgs: ['--k', '8', '--mode', 'bm25'] },
      { name: 'gap-hybrid', gtFile: gapFile, searchArgs: ['--k', '8'] },
      { name: 'gap-rerank', gtFile: gapFile, searchArgs: ['--k', '8', '--rerank'] },
    );
  }
  const summaries = [];
  for (const job of jobs) {
    console.error(`\n==== ${job.name} ====`);
    summaries.push(runArm({ ...job, outFile: path.join(outDir, `results-${job.name}.jsonl`) }));
  }
  const suite = {
    at: new Date().toISOString(),
    search: codeIndex,
    dataDir,
    seed: generated.seed,
    projects: generated.projects,
    nSym: written.nSym,
    nGap: written.nGap,
    gt: written.gtFile,
    summaries,
  };
  fs.writeFileSync(path.join(outDir, 'suite-summary.json'), JSON.stringify(suite, null, 2) + '\n');
  console.log(JSON.stringify(suite, null, 2));
  process.exit(0);
}

const summary = runArm({
  name: 'arm',
  gtFile: gtPath,
  outFile: outPath,
  searchArgs: argv.length ? argv : ['--k', '8'],
  rerunIds: rerunRaw ? rerunRaw.split(',').map((s) => s.trim()).filter(Boolean) : [],
});
console.log(JSON.stringify(summary, null, 2));
