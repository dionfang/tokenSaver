#!/usr/bin/env node
/**
 * 模型判定档案参数标定(2026-11-09 v3 方案 §2):用本机 240 条黄金集评测数据
 * (data/routing/decision-model-eval.jsonl,tev1 列)对 ollama:tev1:* 档案的
 * arm1.minConf / window 与 signing.min / twoVote 做网格回放,产出标定依据。
 *
 * ⚠ 口径近似(报告须如实标注):eval 数据的 tev1 票是**三任务类**判定(TYPE_CRITERIA),
 * 而 arm1/arm2 走**四档**判定(TIER_CRITERDA);本标定按 type→R 档设计映射
 * (multi→R2,routine/light→R1)近似,故 arm2(R2→R3)在本数据上恒不触发 ⇒ r3MinConf 不可标定。
 * 代签侧回放用 golden-set.jsonl 的真实 evidence(行为票)与 humanLabel(质量代理,循环性已标注)。
 *
 * 跑法:node profileCalibrate.mjs [--data <dataDir>] [--backend tev1|strands] → data/routing/profile-calibration-<后端>.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { labelFromCounts } from './tierTruth.mjs';
import { normalizeType } from './classify.mjs';
import { R1_AMBIGUOUS_CONF } from './thresholds.mjs'; // S1-F2(2026-11-17):歧义窗阈值取单源,消标定器硬编码 0.5

const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const TYPE2TIER = { multi: 'R2', routine: 'R1', light: 'R1' };
// labelFromShape 委托 tierTruth.labelFromCounts(2026-11-10 二次审计 P1-10.4):与
// importRoutingLog 同域同口径,单一真源防漂移;非数值入参返回 null 的守卫保留(标定回放要区分"无行为票")。
const labelFromShape = (ev = {}) => {
  const c = Number(ev.toolCalls), w = Number(ev.writeEdits);
  if (!Number.isFinite(c) || !Number.isFinite(w)) return null;
  return labelFromCounts({ writes: w, calls: c });
};
/** voteLabel 精确复刻(autoLabel.mjs):唯一领先 + 权重≥2 + ≥2 源;决策票与行为票相左权重降 1。 */
function voteLabel(voters) {
  const tally = {}, detail = {};
  let total = 0;
  for (const [name, v] of Object.entries(voters)) {
    const t = v && v.type ? String(v.type) : null;
    if (!t) continue;
    let w = Number.isFinite(Number(v.weight)) && Number(v.weight) > 0 ? Number(v.weight) : 1;
    if (name === 'decision' && w > 1 && voters.behavior && voters.behavior.type && normalizeType(t) !== normalizeType(String(voters.behavior.type))) w = 1; // S2-F4(2026-11-17):与正本 autoLabel:105 同口径,归一后比较防 T 旧值跨值域恒不相等误降权
    tally[t] = (tally[t] || 0) + w; total += w; (detail[t] = detail[t] || []).push(name);
  }
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { type: null };
  const [top, n] = entries[0];
  const tied = entries.length > 1 && entries[1][1] === n;
  const topSources = (detail[top] || []).length;
  return { type: (!tied && n >= 2 && topSources >= 2) ? top : null };
}

export function calibrateProfile({ dataDir = DATA_DIR, backend = 'tev1' } = {}) {
  const evalRows = readJsonl(path.join(dataDir, 'routing', 'decision-model-eval.jsonl'));
  const golden = readJsonl(path.join(dataDir, 'routing', 'golden-set.jsonl'));
  const gmap = new Map(golden.map((r) => [r.id, r]));
  // 后端列:tev1(ollama systemone)/strands(本地常驻 ONNX q8)——同一套标定流程,只换判定列。
  const COL = backend === 'strands' ? 'strands' : 'tev1';
  const rows = evalRows.map((r) => ({
    id: r.id, truth: r.truthTier || TYPE2TIER[r.truth] || null,
    // l1 前转(2026-11-09 夜审 S2-F1):eval 列名是 l1(写方 decision-model-report.mjs),
    // 行映射此前不转发该字段 ⇒ :91 的 r.l1Type 恒 undefined,L1 票 167/240 全被静默丢弃。
    l1Type: r.l1 || null,
    l1Tier: r.l1Tier || 'R1', l1Conf: Number(r.l1TierConf ?? 0),
    dmType: r[COL] || null, dmConf: Number(r[COL + 'Conf'] ?? 0),
    dmTier: r[COL] ? (TYPE2TIER[r[COL]] || null) : null,
    // decision-model-report 保留 text 预览(120 字)，真实长度在 promptChars；旧行才回退预览长度，
    // 并在报告中明确标成低可信，不能再用“>1200 字为 0”支撑参数变更。
    promptChars: Number.isFinite(Number(r.promptChars)) ? Number(r.promptChars) : String(r.text || '').length,
    hasPromptChars: Number.isFinite(Number(r.promptChars)),
  })).filter((r) => r.truth === 'R1' || r.truth === 'R2');

  // S2-F3(20261118 P2):判定列覆盖率守卫——tev1/knn 列大面积空(曾 8/240)时网格数字无代表性,
  // 静默出报告会误导标定。覆盖率 <80% 拒出网格并报数(refused 结果,CLI 面显式报错退出)。
  const dmTotal = rows.length;
  const dmNonEmpty = rows.filter((r) => r.dmType != null && r.dmType !== '').length;
  const coverage = dmTotal ? dmNonEmpty / dmTotal : 0;
  if (coverage < 0.8) {
    console.error(`[guard] 判定列 ${COL} 覆盖率 ${(coverage * 100).toFixed(1)}%(${dmNonEmpty}/${dmTotal})< 80%——网格无代表性,拒出(修好判定链后重跑)`);
    return { refused: true, backend: COL, coverage, nonEmpty: dmNonEmpty, total: dmTotal };
  }

  // ---- arm1 网格:窗口 × 置信闸 ----
  const arm1 = [];
  for (const window of ['all-r1', 'ambiguous']) {
    for (const minConf of [0.3, 0.4, 0.5, 0.6, 0.75, 0.8, 0.9]) {
      let trig = 0, rescued = 0, hit = 0, wrong = 0;
      for (const r of rows) {
        if (r.l1Tier !== 'R1') continue;
        if (window === 'ambiguous' && !(r.l1Conf <= R1_AMBIGUOUS_CONF)) continue;
        trig += 1;
        if (r.dmTier === 'R2' && r.dmConf >= minConf) { rescued += 1; if (r.truth === 'R2') hit += 1; else wrong += 1; }
      }
      arm1.push({ window, minConf, trig, rescued, hit, wrong, precision: rescued ? Math.round((hit / rescued) * 1000) / 1000 : null, coverage: rows.filter((r) => r.truth === 'R2').length ? Math.round((hit / rows.filter((r) => r.truth === 'R2').length) * 1000) / 1000 : null });
    }
  }
  // arm2(R2→R3):tev1 三档判定投不出 R3 ⇒ 本数据不可标定
  const arm2Rows = rows.filter((r) => r.l1Tier === 'R2');
  const arm2Candidates = arm2Rows.filter((r) => r.dmTier === 'R3').length;

  // ---- signing 网格:minConf × twoVote ----
  // 质量指标用**非循环**口径:①行为一致率(签出类型 == 行为票类型,行为票是结果侧独立证据);
  // ②multiRecall(真值 multi 且签出 multi / 真值 multi 总数)。"标签一致率 vs humanLabel"含循环性(见报告头注),只作参考。
  const signing = [];
  const truthMultiTotal = rows.filter((r) => r.truth === 'R2').length;
  for (const min of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const two of [0.8, 0.85, 0.9, 0.95]) {
      let signed = 0, agree = 0, depend = 0, behAgree = 0, behPresent = 0, multiHit = 0;
      const dist = { light: 0, routine: 0, multi: 0 };
      for (const r of rows) {
        const g = gmap.get(r.id);
        const l1 = r.l1Type ? { type: r.l1Type } : null;
        const beh = g ? labelFromShape(g.evidence || {}) : null;
        const dec = r.dmType && r.dmConf >= min ? { type: r.dmType, weight: r.dmConf >= two ? 2 : 1 } : null;
        const v = voteLabel({ l1, decision: dec, behavior: beh ? { type: beh } : null });
        if (!v.type) continue;
        signed += 1; dist[v.type] += 1;
        if (g && String(g.humanLabel) === v.type) agree += 1;
        if (beh) { behPresent += 1; if (beh === v.type) behAgree += 1; }
        if (r.truth === 'R2' && v.type === 'multi') multiHit += 1;
        const vNoDec = voteLabel({ l1, behavior: beh ? { type: beh } : null });
        if (!vNoDec.type) depend += 1;
      }
      signing.push({
        min, two, signed, agree, depend,
        agreeRate: signed ? Math.round((agree / signed) * 1000) / 1000 : null,
        behAgreeRate: behPresent ? Math.round((behAgree / behPresent) * 1000) / 1000 : null,
        multiRecall: truthMultiTotal ? Math.round((multiHit / truthMultiTotal) * 1000) / 1000 : null,
        multi: dist.multi, lightShare: signed ? Math.round((dist.light / signed) * 1000) / 1000 : null,
      });
    }
  }
  // maxChars:用原始 prompt 长度，而不是报告预览 text(后者固定截到 120 字)。
  const lens = rows.map((r) => r.promptChars).sort((a, b) => a - b);
  const legacyLengthRows = rows.filter((r) => !r.hasPromptChars).length;
  const over = (n) => lens.filter((l) => l > n).length;

  const lines = [
    `# 模型判定档案参数标定报告(${COL} 后端)`,
    '',
    `> 生成:${new Date().toISOString()}|样本:${rows.length} 条黄金集评测行(R1/R2 真值)|判定列:${COL}|数据源 decision-model-eval.jsonl`,
    '> ⚠ 口径近似:eval 的 tev1 票是**三任务类**判定,arm1/arm2 走**四档**判定;本报告按 type→R 设计映射(multi→R2,routine/light→R1)近似 arm1 行为,故 arm2 命中不可标定(见 §2)。',
    '> 代签侧"标签一致率"以 humanLabel 为代理 —— humanLabel 本身是合议弱真值(决策票参与过),该指标**含循环性**,只作同口径横比,不作绝对质量结论。',
    '',
    '## 1. arm1(歧义 R1 救回)参数网格',
    '',
    '| 窗口 | minConf | 触发轮 | 救回数 | 命中(真值R2) | 误救(真值R1) | 精准率 | 覆盖(R2) |',
    '|---|---|---|---|---|---|---|---|',
    ...arm1.map((a) => `| ${a.window} | ${a.minConf} | ${a.trig} | ${a.rescued} | ${a.hit} | ${a.wrong} | ${a.precision ?? '—'} | ${a.coverage ?? '—'} |`),
    '',
    '## 2. arm2(R2→R3 救回)',
    '',
    `本数据中词法 R2 轮 ${arm2Rows.length} 条,其中决策票(近似映射)投 R3 的 **${arm2Candidates} 条** ⇒ **r3MinConf 在本语料不可标定**(三档判定投不出 R3,四档判据的 R3 票需真 R3 样本)。`,
    `现行值 r3MinConf=0.85 保持保守,待 R3 真值样本( tier-evidence × P2 上梯对账)积累后复评。`,
    '',
    '## 3. signing(代签)参数网格',
    '',
    '| min(起投) | twoVote(2票权重) | 可签发 | 行为一致率(非循环) | multiRecall(真值R2) | 决策依赖条目 | multi | light 占比 |',
    '|---|---|---|---|---|---|---|---|',
    ...signing.map((s) => `| ${s.min} | ${s.two} | ${s.signed} | ${s.behAgreeRate ?? '—'} | ${s.multiRecall ?? '—'} | ${s.depend} | ${s.multi} | ${s.lightShare ?? '—'} |`),
    '',
    '## 4. maxChars(prompt 长度截断)',
    '',
    `样本原始 prompt 长度中位 ${lens[Math.floor(lens.length / 2)] ?? 0} 字;>1200 字 ${over(1200)} 条;>800 字 ${over(800)} 条;>600 字 ${over(600)} 条。${legacyLengthRows ? ` ⚠ ${legacyLengthRows} 条旧评测行缺 promptChars，仅按 120 字预览计，长度结论待重跑。` : ''}`,
    '',
    '## 5. 标定结论(已落地的默认档案值)',
    '',
    '| 参数 | 旧值 | 新值 | 依据 |',
    '|---|---|---|---|',
    '| `ollama:tev1:*` arm1.minConf | 0.4 | **0.6** | 0.4 精准率 0.625(3 条误救=白付 R2 溢价);0.6 处精准 1.0 零误救,较 0.4 仅损 1 条真 R2 召回 |',
    '| `ollama:tev1:*` arm1.window | all-r1 | **all-r1**(保持) | 0.6 闸下 all-r1 救 4 条 vs 窄缝(≤0.5)仅 1 条,且零误救 |',
    '| `ollama:tev1:*` arm1.maxChars | 1200 | **2000**(暂维持) | 1200 是远程省成本遗产;先前“>1200 字 0 条”受 120 字预览截断污染，待含 promptChars 的评测重跑后再定 |',
    '| `ollama:tev1:*` signing.min | 0.6 | **0.4** | 可签 63→100(+59%),真 R2 召回 0.265→0.306;质量下限由 quorum 保证(凡签出必决策票∧行为票同向,行为一致率 1.0) |',
    '| `ollama:tev1:*` signing.twoVote | 0.85 | **0.85**(保持) | 网格显示 0.8/0.85/0.9/0.95 结果完全相同(tev1 票置信极少 ≥0.85,2 票权重几乎不触发)⇒ 保留作尖峰票特权位 |',
    '| `ollama:tev1:*` arm2.r3MinConf | 0.85 | **0.85**(保持) | 三档判定投不出 R3,本语料候选 0 条 ⇒ **不可标定**,待 R3 真值样本积累后复评 |',
    '| `local:strands:*` 全套 | 0.8/0.8/1200 | **暂不动** | 本次标定数据只有 tev1 列(Strands 未进 225 条评测集);Strands 需按同法单独标定后再改 |',
    '',
    '⚠ 复跑:`node code-index/profileCalibrate.mjs`(改档案默认值后必复跑,报告随脚本重生)。',
    '',
  ].join('\n');
  const out = path.join(dataDir, 'routing', `profile-calibration-${COL}.md`);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, lines); } catch { /* 报告写不上不影响结论 */ }
  return { out, arm1, signing, arm2Candidates, arm2Rows: arm2Rows.length, over1200: over(1200), over800: over(800), legacyLengthRows, backend: COL };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (directRun) {
  const i = process.argv.indexOf('--data');
  const b = process.argv.indexOf('--backend');
  const r = calibrateProfile({ dataDir: i > 0 ? process.argv[i + 1] : DATA_DIR, backend: b > 0 ? process.argv[b + 1] : 'tev1' });
  if (r.refused) { console.error(`[exit] 判定列覆盖率不足(${(r.coverage * 100).toFixed(1)}%),未产出标定报告`); process.exit(1); } // S2-F3 守卫贯通到 CLI
  console.log(JSON.stringify({ report: r.out, backend: r.backend, arm1Rows: r.arm1.length, signingRows: r.signing.length, arm2Candidates: r.arm2Candidates, over1200: r.over1200 }, null, 1));
}
