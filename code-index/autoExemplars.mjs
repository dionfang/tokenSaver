/**
 * 样本库自动增长(2026-11-02,承接 importRoutingLog 的对齐结果)。
 *
 * 目的:让"用得越多、语义库越准"这条闭环真正自动跑——routing-log 里的真实 prompt
 * 经对齐器取回完整原文与该轮行为形态,按形态打弱标签,去重后并入样本库(exemplars.json),
 * 并在样本变化时后台重建向量(embedding)。
 *
 * 铁律:
 *   - 黄金集写入面(2026-11-04 全自动定档):**自动代签 + 复核翻案降级**两条机器通道,无人工签字环节;
 *     labelRule 含 ab-constructive 的设计即真值条目复核豁免,永不触碰;
 *   - 标签只来自行为形态,不回灌 L1/L2 预测(翻案降级只摘标签归 unknown,也绝不按预测重贴);
 *   - 频率受限(默认 6h)+ 只在日志有新数据时才跑;
 *   - 向量重建放分离后台(耗时十几秒,不能占钩子时间);
 *   - 全程 fail-open,失败只留痕不影响任何其他功能。
 *
 * 触发:prompt-guard 的 --check 后台分支(见 maybeGrowPool)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { buildExemplars, loadPool, promptKey } from './buildExemplars.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = 'autoexemplars.json';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/**
 * 合并两个池(raw-labels 历史弱标签 + routing-log 行为标签),按 promptKey 跨文件去重。
 * 纯函数,便于测试。
 */
export function mergePools(primary, extra) {
  const seen = new Set();
  const out = [];
  for (const row of [...(primary || []), ...(extra || [])]) {
    if (!row || !row.prompt || !row.label) continue;
    const k = promptKey(row.prompt);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...row, promptKey: k });
  }
  return out;
}

/** 把 routing-log 对齐结果转成池条目(只收有标签的)。 */
export function toPoolRows(labels) {
  return (labels || [])
    .filter((r) => r && r.label && r.prompt)
    .map((r) => ({
      id: `rl-${r.promptKey.slice(0, 12)}`,
      project: 'TokenSaver',
      prompt: r.prompt,
      label: r.label,
      labelRule: 'routing-log行为形态',
      toolCalls: r.shape && r.shape.calls,
      writeEdits: r.shape && r.shape.writes,
      reads: r.shape && r.shape.reads,
      source: 'routing-log',
    }));
}

/**
 * 读四档影子账本(usage/routing-shadow.jsonl,source:'tier')→ promptKey → {escalated, servedTier}。
 * 自进化证据回流(2026-11-04):P2 上梯 + 实弹服务档是"低档干不动"的唯一硬证据——黄金集的
 * toolCalls/writeEdits 只能证"活多",证不了"能力不够";这份账本把 R2/R3 真值从恒 0 变成有样本。
 * host 过滤(2026-11-05):影子行自带的宿主标签(zcode|qoder)与 host 过滤条件不符的行不进证据——
 * 两端模型池隔离,别端的 escalated/servedTier 对本端路由没有证据意义。缺 host 的旧行按"通配"收。
 * 同 key 多行取最近,escalated 取并;账本单调增长只读最近 tailCap 行。fail-open(读不到=空表=照旧)。
 */
export function loadShadowEvidence({ dataDir = DATA_DIR, tailCap = 50000, host = null } = {}) {
  const out = new Map();
  let lines;
  try { lines = fs.readFileSync(path.join(dataDir, 'usage', 'routing-shadow.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return out; }
  if (lines.length > tailCap) lines = lines.slice(-tailCap);
  for (const l of lines) {
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (!r || r.source !== 'tier') continue;
    if (host && r.host && r.host !== host) continue;
    const key = r.pkey || (r.promptHead ? promptKey(String(r.promptHead)) : null);
    if (!key) continue;
    const prevRow = out.get(key);
    out.set(key, {
      escalated: !!(r.escalated || (prevRow && prevRow.escalated)),
      servedTier: (typeof r.servedTier === 'string' && r.servedTier.trim()) ? r.servedTier.trim() : ((prevRow && prevRow.servedTier) || null),
      servedModel: r.servedModel || ((prevRow && prevRow.servedModel) || null),
      decisionTier: r.decisionTier || ((prevRow && prevRow.decisionTier) || null),
    });
  }
  return out;
}

/**
 * 自动增长一次:对齐 → 并池 → **四票自动代签黄金集** → 写 exemplars.json → 需要时后台重建向量。
 * 返回 {state:'skipped'|'grown'|'failed', ...}。
 */
export async function maybeGrowPool({ dataDir = DATA_DIR, minIntervalMs = DEFAULT_INTERVAL_MS, now = Date.now(), spawnVectors = true, label = true, exportFn = null } = {}) {
  try {
    const statePath = path.join(dataDir, 'routing', STATE_FILE);
    const state = readJson(statePath) || {};
    if (state.at && now - Number(state.at) < minIntervalMs) return { state: 'skipped', reason: '距上次不足间隔' };
    // Step② 自动触发(2026-11-03 审读修):db→raw-labels 弱标签导出原是全闭环唯一的手动步;
    // 现在随池生长同步重导(本函数只在 prompt-guard --check 后台分支跑,不占注入时间),且放在
    // routing-log 对齐检查之前——db 全量导出是比 routing-log 更全的源头,无新日志时照样值得刷新。
    // 失败 fail-open 沿用旧 raw-labels;exportFn 可注入(测试密闭,不碰真实会话库)。
    try {
      const exp = exportFn || (await import('./exportWeakLabels.mjs')).exportWeakLabels;
      const er = exp({ out: path.join(dataDir, 'routing', 'raw-labels.jsonl') });
      if (er && er.error) console.error(`[warn] 弱标签导出失败(${er.error}),沿用旧 raw-labels`);
    } catch (e) { console.error(`[warn] 弱标签导出异常:${e && e.message ? e.message : e}`); }
    const { buildCandidates } = await import('./importRoutingLog.mjs');
    // logFile 显式按 dataDir 推导(2026-11-03 R1 审查修):buildCandidates 不认 dataDir,缺省会静默落到
    // 全局 routing-log——注入临时 dataDir 的部署/测试隔离契约失效。dbPath 保持全局默认(ZCode 会话库
    // 是机器级资源,与 dataDir 无关;R3 待办:maybeGrowPool 开 dbPath 注入口,测试再密闭)。
    const built = await buildCandidates({
      logFile: path.join(dataDir, 'usage', 'routing-log.jsonl'),
      out: path.join(dataDir, 'routing', 'routinglog-labels.jsonl'),
    });
    if (!built.aligned) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ at: now, result: built }) + '\n');
      return { state: 'skipped', reason: '无新对齐数据', logRows: built.total };
    }
    const labels = readJsonl(path.join(dataDir, 'routing', 'routinglog-labels.jsonl'));
    // 三投票+一加权代签:L1/L2/行为各 1 票,决策模型生效时按置信加权(可影响结果),唯一领先 + 权重≥2 + ≥2 源才签。
    let signStats = null;
    let signedRows = [];
    let reviewStats = null;
    if (label) {
      // 影子证据按宿主过滤:两端模型池隔离,qoder 行的 escalated/servedTier 对 zcode 路由无证据意义
      // (promptKey 对齐器不带端信息;宿主名从代理账本口径取,影子行缺 host 的旧记录按通配收进)
      const shadowHost = await detectShadowHost({ dataDir });
      const shadowEvidence = loadShadowEvidence({ dataDir, host: shadowHost });
      const r = await autoSignGolden({ dataDir, labels, shadowEvidence });
      signStats = r;
      signedRows = r.signed || [];
      // 复核翻案(2026-11-04 全自动纠错通道):与代签同周期,同一套四票复核已签机器条目
      try { reviewStats = await reviewGolden({ dataDir }); } catch { /* 复核 fail-open */ }
    }
    const primary = loadPool(path.join(dataDir, 'routing', 'raw-labels.jsonl')).pool;
    const extra = toPoolRows(labels);
    // 自动代签的标签回流样本库(2026-11-02 补分发链路):L2 向量空间原先只学"行为形态"标签,
    // 而行为票是最粗的一票;代签标签是四票合议,更准 ⇒ 让 L2 也学它(与行为标签同 prompt 去重,代签优先)。
    const signedPool = signedRows.map((s) => ({
      id: `as-${String(s.pkey || s.prompt || '').slice(0, 12)}`,
      project: s.project || 'TokenSaver',
      prompt: s.prompt,
      label: s.humanLabel,
      labelRule: `ensemble:${s.labelRule || ''}`,
      toolCalls: s.evidence && s.evidence.toolCalls,
      writeEdits: s.evidence && s.evidence.writeEdits,
      source: 'auto-signed',
    }));
    const merged = mergePools(primary, [...signedPool, ...extra]);
    const builtLib = buildExemplars(merged, { capPerLabel: 120 }); // 返回 {version,builtAt,source,stats,exemplars[]}
    const exemplars = builtLib.exemplars;
    const outFile = path.join(dataDir, 'routing', 'exemplars.json');
    const before = readJson(outFile);
    // 变更检测用**内容签名**(条数 + id/label 摘要),不能只看条数:2026-11-02 代签标签回流后
    // 条数不变但标签变了,只看条数会漏掉向量重建 → 向量表里的标签陈旧。
    const sig = (arr) => arr.map((e) => `${e.id}:${e.label}`).join('|');
    const beforeSig = before && Array.isArray(before.exemplars) ? sig(before.exemplars) : '';
    const beforeN = (before && Array.isArray(before.exemplars) ? before.exemplars : []).length;
    fs.writeFileSync(outFile, JSON.stringify({ ...builtLib, source: 'raw-labels + 自动代签 + routing-log行为形态' }, null, 1) + '\n');
    const changed = sig(exemplars) !== beforeSig;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ at: now, pool: merged.length, exemplars: exemplars.length, changed, sign: signStats, review: reviewStats }) + '\n');
    if (changed && spawnVectors) {
      // 向量重建耗时十几秒 → 分离后台,不等它
      try {
        const child = spawn(process.execPath, [path.join(here, 'modelRoute.mjs'), '--build-vectors'], {
          cwd: here, detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
      } catch { /* 起不来不影响样本库本身 */ }
    }
    return { state: 'grown', pool: merged.length, exemplars: exemplars.length, before: beforeN, changed, sign: signStats, review: reviewStats };
  } catch (e) {
    return { state: 'failed', reason: String(e && e.message ? e.message : e) };
  }
}

/**
 * 三投票+一加权自动代签(2026-11-03 用户定档,L3 层彻底取消——语义兜底由四档分档承担):
 *   三投票 = L1(词法)/L2(向量)/行为形态,各 1 票;
 *   一加权 = 决策模型,开关生效(modelRouting.decisionModel.enabled)且断路器未开时批量判定,
 *     按置信加权参与计票(≥0.9 记 2 票/≥0.6 记 1 票/更低弃权)——**可影响代签结果**(救回低证据签名/
 *     反向形成平票更保守),但单票永不独签(quorum 仍要求最高票 ≥2 个不同投票源);
 *   断网/开关关/跳闸 → 决策模型弃权,三票照常,完全离线可用。
 * 唯一领先且 ≥2 票 ⇒ 签(reviewed=true, autoSigned=true);平票/单票 ⇒ 只留池。
 * 产出诊断报告(auto-label-report.md),**不需要人签字**。
 */
/**
 * 四票组装(代签与复核共用):L1 词法 / L2 向量(低置信弃权)/ 决策模型加权 / 行为形态。
 * 行为票默认取 row.label(代签候选=行为形态标签);复核场景传 behaviorFrom(row) 按 evidence 重放。
 * 决策模型批量判定失败/异常 → 跳闸并弃权,三票照常。返回 {voters:Map(row→voters), decisionNote}。
 */
async function gatherVoters({ rows, dataDir, l2MinConf, decisionMinConf, classifyBatchFn, behaviorFrom = null }) {
  const { classifyPromptRaw } = await import('./classify.mjs');
  const { l2EmbedFn, loadVectors, knnClassify } = await import('./modelRoute.mjs');
  const { signable } = await import('./autoLabel.mjs');
  const embedFn = await l2EmbedFn({ dataDir });
  const vectorsDoc = embedFn ? loadVectors(dataDir) : null;
  const dm = await import('./decisionModel.mjs');
  const decisionOn = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'code-index.config.json'), 'utf8'))
        ?.modelRouting?.decisionModel?.enabled === true;
    } catch { return false; }
  })() && !dm.breakerOpen(dataDir);
  const decisionByRow = new Map();
  let decisionNote = null;
  if (decisionOn) {
    try {
      const batch = classifyBatchFn || dm.classifyBatch;
      const cand = rows.map((r, i) => ({ id: i + 1, text: String(r.prompt || ''), row: r })).filter((x) => signable(x.row.prompt));
      if (cand.length) {
        const dr = await batch(cand.map((x) => x.text));
        if (dr.error) {
          dm.tripBreaker(`代签加权失败:${dr.error}`, dataDir);
          decisionNote = `决策模型失败已跳闸:${dr.error}`;
        } else {
          for (const a of dr.answers) {
            const src = cand[a.id - 1];
            if (src) decisionByRow.set(src.row, a);
          }
        }
      }
    } catch (e) {
      dm.tripBreaker(`代签加权异常:${e && e.message ? e.message : e}`, dataDir);
      decisionNote = '决策模型异常已跳闸';
    }
  }
  const voters = new Map();
  for (const c of rows) {
    const l1 = classifyPromptRaw(c.prompt);
    let l2 = null;
    if (embedFn && vectorsDoc) {
      try {
        const v = await embedFn(c.prompt);
        l2 = knnClassify(v, vectorsDoc);
      } catch { /* L2 失败算弃权 */ }
    }
    const dec = decisionByRow.get(c);
    const dmVote = dec && dec.confidence >= decisionMinConf
      ? { type: dec.type, confidence: dec.confidence, weight: dec.confidence >= 0.9 ? 2 : 1 }
      : null;
    voters.set(c, {
      l1,
      l2: l2 && l2.confidence >= l2MinConf ? l2 : null,                       // 低置信弃权
      decision: dmVote,
      behavior: behaviorFrom ? behaviorFrom(c) : (c.label ? { type: c.label } : null),
    });
  }
  return { voters, decisionNote };
}

function readL2MinConf(dataDir) {
  try { return Number(JSON.parse(fs.readFileSync(path.join(dataDir, 'code-index.config.json'), 'utf8'))?.modelRouting?.l2?.minConf) || 0.6; } catch { return 0.6; }
}

export async function autoSignGolden({ dataDir = DATA_DIR, labels = null, minVotes = 2, decisionMinConf = 0.6, l2MinConf = null, classifyBatchFn = null, shadowEvidence = null } = {}) {
  // l2MinConf 缺省读配置 l2.minConf(与 classifyRoute 同一口径,2026-11-03 R1 审查修):
  // 旧硬编码 0.75 在边际置信口径下让 L2 票几乎恒弃权,配置调阈值不生效。
  if (l2MinConf == null) l2MinConf = readL2MinConf(dataDir);
  const rows = labels || readJsonl(path.join(dataDir, 'routing', 'routinglog-labels.jsonl'));
  const { autoSign, mergeAutoSigned, writeReport } = await import('./autoLabel.mjs');
  const { renumberGolden } = await import('./buildExemplars.mjs');
  const { voters, decisionNote } = await gatherVoters({ rows, dataDir, l2MinConf, decisionMinConf, classifyBatchFn });
  const withVotes = rows.map((c) => ({ ...c, voters: voters.get(c) }));
  const { signed, contested, skipped } = autoSign(withVotes, (c) => c.voters, { minVotes });
  // 影子账本证据回流:promptKey 命中 → evidence 补 escalated/servedTier(P2 硬证据进行为真值,
  // 让 R2/R3 不再是"恒 0";"活多"证不了能力,这份证据才证"低档干不动")。只补不删。
  const signedWithEvidence = signed.map((s) => {
    const ex = shadowEvidence && shadowEvidence.get(promptKey(String(s.prompt || '')));
    if (!ex || !s.evidence) return s;
    const extra = {};
    if (ex.escalated === true) extra.escalated = true;
    if (ex.servedTier) extra.servedTier = ex.servedTier;
    if (!Object.keys(extra).length) return s;
    return { ...s, evidence: { ...s.evidence, ...extra } };
  });
  const goldenFile = path.join(dataDir, 'routing', 'golden-set.jsonl');
  const existing = readJsonl(goldenFile);
  const merged = renumberGolden(mergeAutoSigned(signedWithEvidence, existing));
  fs.writeFileSync(goldenFile, merged.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const report = writeReport({ signed, contested, skipped }, { dataDir });
  return { signed: signedWithEvidence, signedCount: signedWithEvidence.length, contested: contested.length, skipped: skipped.length, golden: merged.length, report: report.out, decisionNote: decisionNote || null };
}

/**
 * 黄金集周期复核(2026-11-04 用户定档:全自动、无人工签后的纠错通道):
 *   对**机器签发**(autoSigned=true)的已签条目用同一套四票重新评审;
 *   当前投票全员一致(唯一领先 + 权重≥minVotes + ≥2 源,与代签同证据强度)且 ≠ 原标签
 *   ⇒ **翻案降级**:摘 reviewed/autoSigned/humanLabel 退回样本池(下个代签周期凭证据可重签);
 *   绝不按当前预测重贴新标签——预测只撤销置信、不写真值,"L1/L2 预测不回灌"红线保持。
 *   豁免:autoSigned!==true 的条目(ab-constructive 设计即真值是全集最高质量真值,永不触碰)。
 *   行为票按 evidence 重放 labelFromShape(证据缺失则弃权);复核历史落 golden-review.jsonl
 *   (stability 口径=历次复核"维持"占比,翻转率最高者即疑似错签排序列表),复核段追加进
 *   auto-label-report.md。全程 fail-open。
 */
export async function reviewGolden({ dataDir = DATA_DIR, minVotes = 2, decisionMinConf = 0.6, l2MinConf = null, classifyBatchFn = null, now = Date.now() } = {}) {
  if (l2MinConf == null) l2MinConf = readL2MinConf(dataDir);
  const { voteLabel, signable } = await import('./autoLabel.mjs');
  const { labelFromShape } = await import('./importRoutingLog.mjs');
  const goldenFile = path.join(dataDir, 'routing', 'golden-set.jsonl');
  const rows = readJsonl(goldenFile);
  const cand = rows.filter((r) => r.autoSigned === true && r.reviewed === true && signable(r.prompt));
  const { voters, decisionNote } = await gatherVoters({
    rows: cand, dataDir, l2MinConf, decisionMinConf, classifyBatchFn,
    behaviorFrom: (r) => {
      const ev = r.evidence || {};
      const calls = Number(ev.toolCalls);
      const writes = Number(ev.writeEdits);
      if (!Number.isFinite(calls) || !Number.isFinite(writes)) return null; // 证据缺失 → 行为弃权
      const t = labelFromShape({ calls, writes });
      return t ? { type: t } : null;
    },
  });
  const demotedSet = new Map();
  const reviewRows = [];
  for (const r of cand) {
    const v = voteLabel(voters.get(r) || {});
    const flip = !!(v.type && v.type !== r.humanLabel);
    reviewRows.push({
      ts: now, pkey: r.pkey || null, promptHead: String(r.prompt || '').slice(0, 120),
      from: r.humanLabel || null, verdict: flip ? 'demoted' : 'kept',
      votes: v.votes, sources: v.sources, voters: v.voters,
    });
    if (flip) {
      demotedSet.set(r, {
        ...r, reviewed: false, autoSigned: false, humanLabel: null, autoLabel: null,
        demotedAt: now, demotedFrom: r.humanLabel,
        demoteRule: `复核投票一致反对(${Object.entries(v.voters).map(([t, srcs]) => srcs.join('+') + '→' + t).join(';')})`,
      });
    }
  }
  if (demotedSet.size) {
    const next = rows.map((r) => demotedSet.get(r) || r);
    fs.writeFileSync(goldenFile, next.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  // stability 台账(只增;超 2MB 截尾保留最近 2000 条,防单调膨胀)
  const reviewFile = path.join(dataDir, 'routing', 'golden-review.jsonl');
  try {
    let hist = readJsonl(reviewFile).concat(reviewRows);
    let blob = hist.map((r) => JSON.stringify(r)).join('\n') + '\n';
    if (blob.length > 2 * 1024 * 1024) { hist = hist.slice(-2000); blob = hist.map((r) => JSON.stringify(r)).join('\n') + '\n'; }
    fs.writeFileSync(reviewFile, blob);
  } catch { /* 台账失败不影响降级 */ }
  // 复核段追加进代签报告:stability 排序列表即"疑似错签"优先复核面
  try {
    const byKey = new Map();
    for (const h of readJsonl(reviewFile)) {
      const k = h.pkey || h.promptHead;
      const s = byKey.get(k) || { n: 0, flips: 0, head: h.promptHead };
      s.n += 1;
      if (h.verdict === 'demoted') s.flips += 1;
      byKey.set(k, s);
    }
    const unstable = [...byKey.entries()].filter(([, s]) => s.flips > 0).sort((a, b) => b[1].flips - a[1].flips).slice(0, 10);
    const sec = [
      '', '## 黄金集复核(翻案降级,stability 口径)', '',
      `> 复核时间:${new Date(now).toISOString()}　候选:${cand.length}　降级:${demotedSet.size}${decisionNote ? '　' + decisionNote : ''}`,
      '降级规则:当前投票全员一致反对原标签(与代签同证据强度)⇒ 摘签退池;设计即真值条目豁免。', '',
      '| 条目 | 复核次数 | 翻案次数 | stability |', '|---|---|---|---|',
      ...unstable.map(([, s]) => `| ${String(s.head).replace(/\|/g, '/').slice(0, 40)} | ${s.n} | ${s.flips} | ${(1 - s.flips / s.n).toFixed(2)} |`),
      '',
    ];
    fs.appendFileSync(path.join(dataDir, 'routing', 'auto-label-report.md'), sec.join('\n'));
  } catch { /* 报告失败不影响降级 */ }
  return { candidates: cand.length, demoted: demotedSet.size, golden: rows.length, decisionNote: decisionNote || null };
}

function readJsonl(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * 证据回流的宿主口径:影子行现在自带 host(zcode|qoder),但扩样循环本身跑在"某个部署的 data"上,
 * 它同时服务两端 ⇒ 默认不过滤(收两端,保守:多收证据只会让行为真值更全,不会污染——
 * 真值看的是该 prompt 自己那轮的结果侧事实,与哪个端无关;按端分池是未来"分端校准"才需要的)。
 * 保留 host 入参与过滤逻辑,供测试与未来分端口径使用。
 */
async function detectShadowHost() { return null; }

// CLI:node autoExemplars.mjs --review-golden(手动触发一轮复核翻案;6h 周期由 maybeGrowPool 自动带)
const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun && process.argv.includes('--review-golden')) {
  reviewGolden().then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(`[err] ${e && e.message ? e.message : e}`); process.exit(1); });
}

