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
import { DATA_DIR, loadConfig } from './config.mjs';
import { atomicWriteFileSync } from './proc.mjs';

/** 双轴值域(2026-11-06 定稿;2026-11-10 自 autoLabel 物理下沉——只作常量宿主,供路由/打分方取用,
 *  避免 L4 路由为两个常量反向加载 L6 自进化模块图;autoLabel 以重导出兼容旧调用方)。 */
export const SEMANTIC_AXIS = ['multi', 'routine', 'light'];
export const INTENSITY_AXIS = ['heavy', 'normal', 'light'];

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

/**
 * 样本库构建(2026-11-10 配额策略升级):质量优先 + 动态配额 + 总预算。
 *   - 质量排序:来源(signed 3 > routing-log 2 > 弱标签 1)> 置信 > 新鲜度(signedAt/reviewedAt/ts);
 *     旧实现"先到先得"会让新签的高质量行被旧弱标签挤掉。
 *   - 动态配额(dynamicQuota):按各类供给的 sqrt 平滑分配,再在 capPerLabel 与总预算内回填;
 *     供给不足的类不占额度。
 *   - 三重硬上限:per-label capPerLabel、全库 totalCap——**2026-11-14 起默认不限(0)**:base+local
 *     双层向量合并生效后,本地层不再设比例限制(全量入库);config exemplars.capPerLabel/totalCap
 *     显式配正数才重新启用治理,0/未配=不限。
 *   - stats 记录 supply / droppedByCap(触顶可观测,旧实现静默丢弃)。
 * 池内已由导出端按 prompt 去重。
 */
export function buildExemplars(pool, { capPerLabel = 0, totalCap = 0, dynamicQuota = true } = {}) {
  const rows = (pool || []).filter((r) => r && r.label && r.prompt);
  const srcRank = (r) => {
    const s = String(r.source || '');
    if (s === 'auto-signed' || String(r.id || '').startsWith('as-')) return 3;
    if (s === 'routing-log' || /routing-log/.test(String(r.labelRule || ''))) return 2;
    return 1;
  };
  const confOf = (r) => Number(r.confidence) || 0;
  const recOf = (r) => Number(r.signedAt || r.reviewedAt || r.ts || 0);
  const ranked = [...rows].sort((a, b) => srcRank(b) - srcRank(a) || confOf(b) - confOf(a) || recOf(b) - recOf(a));

  const supply = {};
  for (const r of rows) supply[r.label] = (supply[r.label] || 0) + 1;
  const labels = Object.keys(supply);
  const quota = {};
  const wsum = labels.reduce((s, l) => s + Math.sqrt(supply[l]), 0) || 1;
  // 2026-11-14:base+local 双层合并生效后,本地层默认**不限**(cap≤0 ⇒ 全量保留,droppedByCap 恒 0);
  // 显式配正数(config exemplars.capPerLabel/totalCap)才重新启用配额治理。两键可独立生效:
  // 只配 capPerLabel ⇒ 仅单类上限(无总预算约束);只配 totalCap ⇒ 仅 sqrt 动态总预算。
  const capped = (Number(capPerLabel) || 0) > 0 || (Number(totalCap) || 0) > 0;
  const hasTotal = (Number(totalCap) || 0) > 0;
  let budgetLeft = hasTotal ? Number(totalCap) : Infinity;
  for (const l of labels) {
    if (!capped) { quota[l] = supply[l]; continue; }
    // 动态:按供给 sqrt 分摊总预算(供给不足的类不多占);capPerLabel 仅作单类垄断兜底。
    const dynamic = dynamicQuota && hasTotal ? Math.ceil(budgetLeft * Math.sqrt(supply[l]) / wsum) : (capPerLabel || Infinity);
    quota[l] = Math.max(0, Math.min(capPerLabel || Infinity, dynamic, supply[l], budgetLeft));
    if (hasTotal) budgetLeft -= quota[l];
  }
  // 注:不做"剩余预算回填"——实测回填会把没用完的额度全灌给供给最大的类(light 逼近 50%),
  // 破坏 sqrt 平滑的类别平衡;少用预算优于制造先验偏置。

  const used = {}; const droppedByCap = {};
  const exemplars = [];
  for (const r of ranked) {
    if ((used[r.label] || 0) >= (quota[r.label] || 0)) { droppedByCap[r.label] = (droppedByCap[r.label] || 0) + 1; continue; }
    used[r.label] = (used[r.label] || 0) + 1;
    exemplars.push({
      id: r.id, prompt: r.prompt, label: r.label, confidence: r.confidence,
      labelRule: r.labelRule, project: r.project,
      toolCalls: r.toolCalls, writeEdits: r.writeEdits, reads: r.reads,
    });
  }
  const stats = { total: exemplars.length, supply, quota, droppedByCap, budget: { capPerLabel, totalCap, dynamicQuota } };
  for (const l of labels) stats[l] = used[l] || 0;
  return { version: 1, builtAt: new Date().toISOString(), source: 'weak-v1', stats, exemplars };
}

/** 配额解析:正数才启用;0、缺省、非数都是不限。CLI 正数盖过配置,CLI 的 0 表示读配置。
 *  不能写成 `Number(x) || 120`——0 是「不限」,会被 || 吃掉并装回旧上限。 */
export function resolveExemplarCaps(exCfg = {}, cli = {}) {
  const pos = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    capPerLabel: pos(cli.cap) || pos(exCfg.capPerLabel),
    totalCap: pos(cli.totalCap) || pos(exCfg.totalCap),
    dynamicQuota: exCfg.dynamicQuota !== false,
  };
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
  const cap = Number(opt('--cap', 0)) || 0; // 0=读配置 exemplars.capPerLabel;配置也未设=不限(0)
  const totalCapOpt = Number(opt('--total-cap', 0)) || 0; // 0=读配置 exemplars.totalCap
  const goldenN = Number(opt('--golden', 50));
  // --review-only:只用现有 golden-set.jsonl 重生代签清单 md;不碰 jsonl 与样本库(免触嵌入过期)
  if (argv.includes('--review-only')) {
    const gf = path.join(outDir, 'golden-set.jsonl');
    const rows = readGolden(gf);
    if (!rows.length) { console.error(`[err] ${gf} 无条目,不能只重生清单`); process.exit(1); }
    atomicWriteFileSync(path.join(outDir, 'golden-set-review.md'), reviewMarkdown(rows));
    console.log(`[ok] 代签清单由现有 ${rows.length} 条重生(jsonl 与样本库未改动)→ ${path.join(outDir, 'golden-set-review.md')}`);
    return;
  }
  const { pool, bad, total } = loadPool(poolFile);
  if (!pool.length) {
    console.error(`[err] ${poolFile} 无有效标注(总行 ${total},坏行 ${bad});先运行 python exportWeakLabels.py`);
    process.exit(1);
  }
  const exCfg = (() => { try { return loadConfig().exemplars || {}; } catch { return {}; } })();
  const exemplars = buildExemplars(pool, resolveExemplarCaps(exCfg, { cap, totalCap: totalCapOpt }));
  fs.mkdirSync(outDir, { recursive: true });
  atomicWriteFileSync(path.join(outDir, 'exemplars.json'), JSON.stringify(exemplars, null, 1) + '\n');
  // 项目配额:按池占比分配 goldenN,foodFocus/TokenSaver/yiwu 优先,工作区 draft 归并为 workspace
  const plan = { 'foodFocus': 18, 'TokenSaver': 14, 'yiwu-processing-platform': 10, 'draft-0645e799-07c9-4b1b-a230-254f2c6a226a': 8 };
  const goldenFile = path.join(outDir, 'golden-set.jsonl');
  const { rows: merged, preserved, skipped } = mergeGolden(selectGolden(pool, plan), readGolden(goldenFile));
  const floor = merged.filter(isCalibrated).length; // 已签条目永不被 --golden 截掉(排在前列)
  const golden = renumberGolden(merged.slice(0, Math.max(goldenN, floor)));
  atomicWriteFileSync(goldenFile, golden.map((g) => JSON.stringify(g)).join('\n') + '\n');
  atomicWriteFileSync(path.join(outDir, 'golden-set-review.md'), reviewMarkdown(golden)); // 原子写(2026-11-10 二次审计 P1-3)
  console.log(`[ok] 样本库 ${exemplars.exemplars.length} 条(stats=${JSON.stringify(exemplars.stats)});黄金集 ${golden.length} 条(已签保留 ${preserved},同 prompt 去重 ${skipped});坏行 ${bad};输出 → ${outDir}`);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self);
if (directRun) main();
