/**
 * 样本库与黄金集构建(model-routing.md #9 Step②):消费 exportWeakLabels.py 的
 * data/routing/raw-labels.jsonl,产出:
 *   1. data/routing/exemplars.json — L2 kNN 样本库(按 label 配额,纯文本向量在 Step③ 补)
 *   2. data/routing/golden-set.jsonl + golden-set-review.md — 分层候选池 + 只读代签清单
 * 纯函数(buildExemplars/selectGolden/loadPool/mergeGolden)可注入测试;CLI 直呼执行。
 * 防丢工(#14):重跑不得清掉已签条目——按 prompt 归一键保留并排在前列。
 *   标签的唯一写入口是四票代签(autoLabel.mjs),2026-11-04 起人工签字环节已全部移除。
 * 用法:node buildExemplars.mjs [--pool 路径] [--out-dir 路径] [--cap N] [--golden N]
 *       node buildExemplars.mjs --review-only(仅按现有 jsonl 重生代签清单,不重建样本库)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);

/** 读取 raw-labels.jsonl;坏行跳过;label=null(uncertain)排除。 */
export function loadPool(file) {
  const pool = [];
  let bad = 0;
  let total = 0;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { pool, bad: 0, total: 0 }; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    total += 1;
    try {
      const o = JSON.parse(line);
      if (o && o.label) pool.push(o);
    } catch { bad += 1; }
  }
  return { pool, bad, total };
}

/** 样本库构建:按 label 配额截断(默认每类 120),输出统计。池内已由导出端按 prompt 去重。 */
export function buildExemplars(pool, { capPerLabel = 120 } = {}) {
  const byLabel = new Map();
  const exemplars = [];
  for (const r of pool) {
    const arr = byLabel.get(r.label) || [];
    if (arr.length >= capPerLabel) continue;
    arr.push(r);
    byLabel.set(r.label, arr);
    exemplars.push({
      id: r.id, prompt: r.prompt, label: r.label, confidence: r.confidence,
      labelRule: r.labelRule, project: r.project,
      toolCalls: r.toolCalls, writeEdits: r.writeEdits, reads: r.reads,
    });
  }
  const stats = { total: exemplars.length };
  for (const [label, arr] of byLabel) stats[label] = arr.length;
  return { version: 1, builtAt: new Date().toISOString(), source: 'weak-v1', stats, exemplars };
}

/** 黄金集分层:项目配额 × 类别轮转(尽量覆盖多类型)。plan={项目名:配额};池不足的配额作废。 */
export function selectGolden(pool, plan = {}) {
  const byProject = new Map();
  for (const r of pool) {
    const arr = byProject.get(r.project) || [];
    arr.push(r);
    byProject.set(r.project, arr);
  }
  const picked = [];
  for (const [proj, quota] of Object.entries(plan)) {
    const arr = (byProject.get(proj) || []).slice()
      .sort((a, b) => (a.label || '').localeCompare(b.label || '') || b.confidence - a.confidence);
    // 类别轮转:同项目内按 label 分组轮流取,避免黄金集被单一类型占满
    const groups = new Map();
    for (const r of arr) {
      const g = groups.get(r.label) || [];
      g.push(r);
      groups.set(r.label, g);
    }
    const queues = [...groups.values()];
    let taken = 0;
    while (taken < quota && queues.some((q) => q.length)) {
      for (const q of queues) {
        if (taken >= quota) break;
        const r = q.shift();
        if (r) { picked.push({ ...r, golden: true }); taken += 1; }
      }
    }
  }
  return picked.map((r, i) => ({
    id: `g-${String(i + 1).padStart(2, '0')}`, project: r.project, prompt: r.prompt,
    autoLabel: r.label, confidence: r.confidence, labelRule: r.labelRule,
    evidence: { toolCalls: r.toolCalls, writeEdits: r.writeEdits, reads: r.reads },
    humanLabel: null, reviewed: false, pkey: promptKey(r.prompt),
  }));
}

/**
 * prompt 归一键:折叠空白 + 小写 + 截 400 字后取 32 位哈希,附长度做碰撞区分。
 * 重跑后 id 会变(位置编号),已签标签只能按内容匹配才保得住。
 */
export function promptKey(prompt) {
  const norm = String(prompt || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 400);
  let h = 0;
  for (let i = 0; i < norm.length; i += 1) h = (h * 31 + norm.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}:${norm.length}`;
}

/** 已签字=代签写入的合法 T 标签或 reviewed=true(autoLabel.mjs 两者同写);重跑必须保留。 */
export function isCalibrated(row) {
  return !!row && (row.reviewed === true || /^T[1-8]$/.test(String(row.humanLabel || '')));
}

/** 读已存在的黄金集 jsonl(缺文件返回空,坏行跳过),供合并。 */
export function readGolden(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object') rows.push(o);
    } catch { /* 坏行跳过 */ }
  }
  return rows;
}

/** 合并:已签字条目原样保留(含 humanLabel/reviewed/calibratedAt,现为代签写入)并置于前列,新候选按 pkey 去重后追加。 */
export function mergeGolden(fresh, existing = []) {
  const byKey = new Map();
  for (const r of (existing || []).filter(isCalibrated)) {
    const k = r.pkey || promptKey(r.prompt);
    if (!byKey.has(k)) byKey.set(k, { ...r, pkey: k });
  }
  const kept = [...byKey.values()];
  const seen = new Set(kept.map((r) => r.pkey));
  const out = [...kept];
  let skipped = 0;
  for (const r of fresh) {
    const k = r.pkey || promptKey(r.prompt);
    if (seen.has(k)) { skipped += 1; continue; }
    seen.add(k);
    out.push({ ...r, pkey: k });
  }
  return { rows: out, preserved: kept.length, skipped };
}

/** id 按最终顺序重排(保留条目在前列,重排不动其标注)。 */
export function renumberGolden(rows) {
  return rows.map((r, i) => ({ ...r, id: `g-${String(i + 1).padStart(2, '0')}` }));
}

function reviewMarkdown(golden) {
  const head = [
    '# 黄金集代签清单(model-routing.md #9 Step②/#14;只读诊断)',
    '',
    '> 标签的唯一写入口是四票代签(`autoLabel.mjs` 写 humanLabel/reviewed/autoSigned),**没有人工签字环节**,本表手改会被覆盖。',
    '> `id` 是位置编号,重跑可能变动;条目按 prompt 内容(`pkey`)合并保留,已签条目不会被 `--golden` 截掉。',
    '',
  ];
  const rows = golden.map((g) => `| ${g.id} | ${g.project} | ${g.prompt.replace(/\|/g, '/').slice(0, 90)} | ${g.autoLabel} | ${g.labelRule}(${g.evidence.toolCalls} 调用/写 ${g.evidence.writeEdits}) | ${g.humanLabel || ''}${g.reviewed ? ' 已签' : ''} |`);
  return [...head, '| id | 项目 | prompt(截断) | 自动标签 | 依据 | 已签标签(T) |', '|---|---|---|---|---|---|', ...rows, ''].join('\n');
}

function main() {
  const argv = process.argv;
  const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
  const poolFile = opt('--pool', path.join(DATA_DIR, 'routing', 'raw-labels.jsonl'));
  const outDir = opt('--out-dir', path.join(DATA_DIR, 'routing'));
  const cap = Number(opt('--cap', 120));
  const goldenN = Number(opt('--golden', 50));
  // --review-only:只用现有 golden-set.jsonl 重生代签清单 md;不碰 jsonl 与样本库(免触嵌入过期)
  if (argv.includes('--review-only')) {
    const gf = path.join(outDir, 'golden-set.jsonl');
    const rows = readGolden(gf);
    if (!rows.length) { console.error(`[err] ${gf} 无条目,不能只重生清单`); process.exit(1); }
    fs.writeFileSync(path.join(outDir, 'golden-set-review.md'), reviewMarkdown(rows));
    console.log(`[ok] 代签清单由现有 ${rows.length} 条重生(jsonl 与样本库未改动)→ ${path.join(outDir, 'golden-set-review.md')}`);
    return;
  }
  const { pool, bad, total } = loadPool(poolFile);
  if (!pool.length) {
    console.error(`[err] ${poolFile} 无有效标注(总行 ${total},坏行 ${bad});先运行 python exportWeakLabels.py`);
    process.exit(1);
  }
  const exemplars = buildExemplars(pool, { capPerLabel: cap });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'exemplars.json'), JSON.stringify(exemplars, null, 1) + '\n');
  // 项目配额:按池占比分配 goldenN,foodFocus/TokenSaver/yiwu 优先,工作区 draft 归并为 workspace
  const plan = { 'foodFocus': 18, 'TokenSaver': 14, 'yiwu-processing-platform': 10, 'draft-0645e799-07c9-4b1b-a230-254f2c6a226a': 8 };
  const goldenFile = path.join(outDir, 'golden-set.jsonl');
  const { rows: merged, preserved, skipped } = mergeGolden(selectGolden(pool, plan), readGolden(goldenFile));
  const floor = merged.filter(isCalibrated).length; // 已签条目永不被 --golden 截掉(排在前列)
  const golden = renumberGolden(merged.slice(0, Math.max(goldenN, floor)));
  fs.writeFileSync(goldenFile, golden.map((g) => JSON.stringify(g)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'golden-set-review.md'), reviewMarkdown(golden));
  console.log(`[ok] 样本库 ${exemplars.exemplars.length} 条(stats=${JSON.stringify(exemplars.stats)});黄金集 ${golden.length} 条(已签保留 ${preserved},同 prompt 去重 ${skipped});坏行 ${bad};输出 → ${outDir}`);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self);
if (directRun) main();
