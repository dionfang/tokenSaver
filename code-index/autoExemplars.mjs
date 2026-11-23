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
import { DATA_DIR, decisionActive, loadConfig } from './config.mjs';
import { isInquiryShape, normalizeType, classifyPrompt } from './classify.mjs';
import { deriveTierTruth } from './tierTruth.mjs';
import { R3_SEED_MIN } from './thresholds.mjs';
import { buildExemplars, loadPool, promptKey, resolveExemplarCaps } from './buildExemplars.mjs';
import { atomicWriteFileSync, takeJsonLock, releaseJsonLock } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = 'autoexemplars.json';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 阶段①(2026-11-10):争议池与标签 TTL
const CONTESTED_FILE = 'contested-pool.jsonl';
const LABEL_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 标签有效期 90 天(复核正常时每周期刷新 reviewedAt)
const CONTESTED_CAP = 500;
const ARB_REASK_MS = 30 * 24 * 60 * 60 * 1000; // 争议池仲裁重问间隔(2026-11-22):决策票免费但每 6h 重投整池是浪费

/** 标签 TTL 执行:autoSigned 行 reviewedAt 超期 → 摘签退池;缺失 reviewedAt(迁移期)盖戳保留。
 *  独立于 grow 分支(2026-11-10):长期无新对齐数据时也要能摘掉过期标签。返回 {stamped,demoted,entries}。 */
function enforceLabelTtl(dataDir, now, labelTtlMs) {
  const entries = [];
  let stamped = 0, demoted = 0;
  try {
    const gf = path.join(dataDir, 'routing', 'golden-set.jsonl');
    const gRows = readJsonl(gf);
    if (!gRows.length) return { stamped, demoted, entries };
    let changed = false;
    const next = gRows.map((r) => {
      if (r.autoSigned !== true) return r;
      const at = Number(r.reviewedAt || 0);
      if (!at) { stamped += 1; changed = true; return { ...r, reviewedAt: now }; }
      if (now - at > labelTtlMs) {
        demoted += 1; changed = true;
        entries.push({ pkey: r.pkey || promptKey(r.prompt || ''), prompt: String(r.prompt || '').slice(0, 500), from: r.humanLabel || null, reason: 'ttl-expired' });
        return { ...r, reviewed: false, autoSigned: false, humanLabel: null, autoLabel: null, demotedAt: now, demotedFrom: r.humanLabel || null, demoteRule: 'TTL 过期未复核(自动摘签退池)' };
      }
      return r;
    });
    if (changed) atomicWriteFileSync(gf, next.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch { /* fail-open */ }
  return { stamped, demoted, entries };
}

/** 争议/翻案/过期条目入池(按 pkey 合并,保留最近 at,上限 CONTESTED_CAP)。fail-open。 */
function recordContested(dataDir, entries = []) {
  if (!entries.length) return 0;
  try {
    const file = path.join(dataDir, 'routing', CONTESTED_FILE);
    const byKey = new Map();
    for (const r of readJsonl(file)) {
      const k = r.pkey || promptKey(r.prompt || '');
      if (k) byKey.set(k, r);
    }
    for (const e of entries) {
      const k = e.pkey || promptKey(e.prompt || '');
      if (!k) continue;
      byKey.set(k, { ...(byKey.get(k) || {}), ...e, pkey: k, at: Date.now() });
    }
    const rows = [...byKey.values()].sort((a, b) => Number(b.at || 0) - Number(a.at || 0)).slice(0, CONTESTED_CAP);
    atomicWriteFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return entries.length;
  } catch { return 0; }
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** 本轮复核已摘签的行不再以代签身份进样本库。pkey 与 promptKey 都参与对齐。 */
export function dropDemotedSigned(signedRows, demotedRows) {
  const dropped = new Set();
  for (const d of demotedRows || []) {
    if (!d) continue;
    if (d.pkey) dropped.add(String(d.pkey));
    const k = promptKey(d.prompt || '');
    if (k) dropped.add(k);
  }
  return (signedRows || []).filter((s) => {
    if (!s || !s.prompt) return false;
    if (s.pkey && dropped.has(String(s.pkey))) return false;
    return !dropped.has(promptKey(s.prompt));
  });
}

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
 * R3 硬真值种子(2026-11-22 R3 种子通道):tier-evidence 行 → 'R3' 类池条目。
 * 只认 deriveTierTruth 判 R3 的 p2-escalated 行(escalationTo=R3 或 from=R2 上梯)——
 * R2 档真值不入(multi 类已覆盖 R2 救回,再设 'R2' 类只会稀释 multi 票);非 escalated /
 * 上梯后仍 R1-R2 的行不碰。预测不回灌(#14)不破:deriveTierTruth 签名无 prompt,只吃证据字段;
 * 这也是黄金集治理红线「R3 真值仅 P2 行为证据可达」的既有口径。纯函数,证据字段按
 * tier-evidence 顶层结构适配(escalated/servedTier/escalationFrom·To/calls/writes/errTotal)。
 */
export function r3SeedRows(teRows = []) {
  const out = [];
  for (const r of teRows || []) {
    if (!r || r.escalated !== true || !r.prompt) continue;
    const truth = deriveTierTruth({
      escalated: true,
      escalationTo: r.escalationTo, escalationFrom: r.escalationFrom, servedTier: r.servedTier,
      calls: r.calls, writes: r.writes, errors: r.errTotal,
    });
    if (!truth || truth.tier !== 'R3' || !String(truth.rule || '').startsWith('p2-escalated')) continue;
    out.push({
      id: `te-${String(r.pkey || '').slice(0, 12)}`,
      project: 'TokenSaver',
      prompt: r.prompt,
      label: 'R3',
      confidence: Number(truth.confidence) || 0.8,
      labelRule: 'tier-evidence:p2-escalated(R3 硬真值)',
      source: 'tier-evidence',
    });
  }
  return out;
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
      // S2-1(20261119 夜审):转发 escalationFrom/To——上梯目标档是派生真值的单源字段,丢了它
      // deriveTierTruth 只能按 servedTier(上梯后实际服务档)回落。与 servedTier 同口径:本行有值取本行,缺则留前值。
      escalationFrom: (typeof r.escalationFrom === 'string' && r.escalationFrom.trim()) ? r.escalationFrom.trim() : ((prevRow && prevRow.escalationFrom) || null),
      escalationTo: (typeof r.escalationTo === 'string' && r.escalationTo.trim()) ? r.escalationTo.trim() : ((prevRow && prevRow.escalationTo) || null),
    });
  }
  return out;
}

/**
 * 自动增长一次:对齐 → 并池 → **四票自动代签黄金集** → 写 exemplars.json → 需要时后台重建向量。
 * 返回 {state:'skipped'|'grown'|'failed', ...}。
 */
export async function maybeGrowPool({ dataDir = DATA_DIR, minIntervalMs = DEFAULT_INTERVAL_MS, now = Date.now(), spawnVectors = true, label = true, exportFn = null, labelTtlMs = LABEL_TTL_MS, buildFn = null } = {}) {
  // 并发锁(2026-11-10 根治):prompt-guard --check 可能多进程同轮并发(09:41 实测两次 grow 叠跑),
  // 重复导出/签入会写坏状态,双双重试向量重建还会叠加常驻重启窗口的资源压力。锁按 pid 存活判定,进程崩溃自动过期。
  const lockPath = path.join(dataDir, 'routing', '.autoexemplars.lock');
  if (!takeJsonLock(lockPath)) return { state: 'skipped', reason: '并发锁占用' };
  try {
    try {
    const statePath = path.join(dataDir, 'routing', STATE_FILE);
    const state = readJson(statePath) || {};
    // 节流(2026-11-08 时钟防御):负龄(上次时间戳在未来 = 机器时钟漂移过)不节流,立即放行并自愈——
    // 实弹:错误时钟把 at 写成未来 5 天,6h 节流被判"还剩 131 小时",代签停摆数日无人察觉。
    const age = now - Number(state.at || 0);
    if (state.at && age >= 0 && age < minIntervalMs) return { state: 'skipped', reason: '距上次不足间隔' };
    // Step② 自动触发(2026-11-03 审读修):db→raw-labels 弱标签导出原是全闭环唯一的手动步;
    // 现在随池生长同步重导(本函数只在 prompt-guard --check 后台分支跑,不占注入时间),且放在
    // routing-log 对齐检查之前——db 全量导出是比 routing-log 更全的源头,无新日志时照样值得刷新。
    // 失败 fail-open 沿用旧 raw-labels;exportFn 可注入(测试密闭,不碰真实会话库)。
    try {
      const exp = exportFn || (await import('./exportWeakLabels.mjs')).exportWeakLabels;
      const er = exp({ out: path.join(dataDir, 'routing', 'raw-labels.jsonl') });
      if (er && er.error) console.error(`[warn] 弱标签导出失败(${er.error}),沿用旧 raw-labels`);
    } catch (e) { console.error(`[warn] 弱标签导出异常:${e && e.message ? e.message : e}`); }
    const buildCandidates = buildFn || (await import('./importRoutingLog.mjs')).buildCandidates; // S5-F1 测试缝:可注入对齐器做密闭故障注入
    // logFile 显式按 dataDir 推导(2026-11-03 R1 审查修):buildCandidates 不认 dataDir,缺省会静默落到
    // 全局 routing-log——注入临时 dataDir 的部署/测试隔离契约失效。dbPath 保持全局默认(ZCode 会话库
    // 是机器级资源,与 dataDir 无关;R3 待办:maybeGrowPool 开 dbPath 注入口,测试再密闭)。
    const built = await buildCandidates({
      logFile: path.join(dataDir, 'usage', 'routing-log.jsonl'),
      out: path.join(dataDir, 'routing', 'routinglog-labels.jsonl'),
    });
    if (!built.aligned) {
      // 无新数据也要执行 TTL(2026-11-10):标签不因"管线闲着"而永久有效
      const ttl = enforceLabelTtl(dataDir, now, labelTtlMs);
      if (ttl.entries.length) recordContested(dataDir, ttl.entries);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ at: now, result: built, ttl: { stamped: ttl.stamped, demoted: ttl.demoted } }) + '\n');
      return { state: 'skipped', reason: '无新对齐数据', logRows: built.total, ttlDemoted: ttl.demoted };
    }
    const labels = readJsonl(path.join(dataDir, 'routing', 'routinglog-labels.jsonl'));
    // 四票合议代签:L1/L2/决策/行为,决策票按模型档案门槛加权(signing.min 起投/twoVote 记 2 票,反压制),
    // 唯一领先 + 权重≥2 + ≥2 源才签。
    let signStats = null;
    let signedRows = [];
    let reviewStats = null;
    let arbStats = null; // 争议池二轮仲裁(2026-11-22):{asked, signed, stillContested, note}
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
      // 争议池二轮仲裁(2026-11-22):tev1 对池内 quorum-not-met 条目带外重投一票,与已记的
      // l1/l2/behavior 票合议(voteLabel 同口径,1B 行为否决照旧);达成则签入黄金集并移出争议池。
      try { arbStats = await arbitrateContested({ dataDir, now }); } catch { /* 仲裁 fail-open */ }
    }
    // ---------- 阶段①(2026-11-10):争议池 + 标签 TTL ----------
    // 争议池:四票未签出的候选 + 复核翻案行 → data/routing/contested-pool.jsonl(不进黄金集),
    //   供后续人工/跨模型复核;按 pkey 合并、上限 500、按 at 保留最近。
    // TTL:有 reviewedAt 且超期的机器签入行 → 摘签退池(标签不永久有效);缺失 reviewedAt = 迁移期,
    //   盖当前时间戳保留(不误杀存量 279 行)。
    const contestedEntries = [];
    if (signStats && Array.isArray(signStats.contestedRows)) {
      for (const c of signStats.contestedRows) {
        const v = c.vote || {};
        contestedEntries.push({
          pkey: c.pkey || promptKey(c.prompt || ''), prompt: String(c.prompt || '').slice(0, 500),
          suggested: v.type || null, votes: v.votes ?? 0, sources: v.sources ?? 0, agreement: v.agreement ?? 0,
          voters: v.voters || {}, reason: 'quorum-not-met',
        });
      }
    }
    if (reviewStats && Array.isArray(reviewStats.demotedRows)) {
      for (const d of reviewStats.demotedRows) {
        contestedEntries.push({
          pkey: d.pkey || promptKey(d.prompt || ''), prompt: String(d.prompt || '').slice(0, 500),
          suggested: null, reason: 'review-demoted', demoteRule: d.demoteRule || null,
        });
      }
    }
    const ttl = enforceLabelTtl(dataDir, now, labelTtlMs);
    if (ttl.entries.length) contestedEntries.push(...ttl.entries);
    if (ttl.stamped || ttl.demoted) reviewStats = { ...(reviewStats || {}), ttlStamped: ttl.stamped, ttlDemoted: ttl.demoted };
    if (contestedEntries.length) recordContested(dataDir, contestedEntries);
    const primary = loadPool(path.join(dataDir, 'routing', 'raw-labels.jsonl')).pool;
    const extra = toPoolRows(labels);
    // 自动代签的标签回流样本库(2026-11-02 补分发链路;2026-11-06 修优先级倒置):L2 向量空间原先只学
    // "行为形态"标签;代签标签是四票合议,更准 ⇒ 同 prompt 去重**代签排最前**(mergePools 先到先得)。
    // 旧实现把 raw 弱标签放 primary 位,172 条代签只有 4-5 条进库(97% 被去重+120/类配额掐断),
    // "进化回路"两端皆断——现 signed → raw → routing-log 三级优先,配额内代签先占位。
    const signedPool = dropDemotedSigned(signedRows, reviewStats && reviewStats.demotedRows).map((s) => ({
      id: `as-${String(s.pkey || s.prompt || '').slice(0, 12)}`,
      project: s.project || 'TokenSaver',
      prompt: s.prompt,
      label: s.humanLabel,
      labelRule: `ensemble:${s.labelRule || ''}`,
      toolCalls: s.evidence && s.evidence.toolCalls,
      writeEdits: s.evidence && s.evidence.writeEdits,
      // 质量排序用(2026-11-10):signed 来源 + 合议一致度 + 签入时间;新签行因此能挤掉旧弱标签
      confidence: Number(s.agreement) || 0,
      signedAt: Number(s.signedAt) || 0,
      source: 'auto-signed',
    }));
    // R3 硬真值种子通道(2026-11-22):tier-evidence 的 p2-escalated→R3 行按 'R3' 类入池——
    // l2TierRescue 的 R2→R3 救援分支有类才通电(此前库内 R3 类恒 0,分支结构性死亡)。门槛
    // R3_SEED_MIN(thresholds 单源,沿"每类 ≥8 条补嵌"既定设计):不足则计数不入场,噪声隔离。
    // 种子排池首(硬真值优先于弱标签同 prompt 去重);R2 档真值不入池(multi 类已覆盖 R2 救回)。
    const r3SeedsAll = r3SeedRows(readJsonl(path.join(dataDir, 'routing', 'tier-evidence.jsonl')));
    const r3Seeds = r3SeedsAll.length >= R3_SEED_MIN ? r3SeedsAll : [];
    const merged = mergePools([...r3Seeds, ...signedPool, ...primary], extra);
    const exCfg = (() => {
      const c = loadConfig({ soft: true }); // S14-F1(20261120 夜审):后台路径禁 process.exit,坏 JSON 走默认空
      return c._configError ? {} : (c.exemplars || {});
    })();
    const builtLib = buildExemplars(merged, resolveExemplarCaps(exCfg)); // 0=不限;正数才截断
    const exemplars = builtLib.exemplars;
    const outFile = path.join(dataDir, 'routing', 'exemplars.json');
    const before = readJson(outFile);
    // 变更检测用**内容签名**(条数 + id/label 摘要),不能只看条数:2026-11-02 代签标签回流后
    // 条数不变但标签变了,只看条数会漏掉向量重建 → 向量表里的标签陈旧。
    const sig = (arr) => arr.map((e) => `${e.id}:${e.label}`).join('|');
    const beforeSig = before && Array.isArray(before.exemplars) ? sig(before.exemplars) : '';
    const beforeN = (before && Array.isArray(before.exemplars) ? before.exemplars : []).length;
    atomicWriteFileSync(outFile, JSON.stringify({ ...builtLib, source: 'raw-labels + 自动代签 + routing-log行为形态' }, null, 1) + '\n');
    const changed = sig(exemplars) !== beforeSig;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const slim = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => !/Rows$/.test(k))) : o); // 状态文件不落整批行(防膨胀)
    fs.writeFileSync(statePath, JSON.stringify({ at: now, pool: merged.length, exemplars: exemplars.length, changed, r3Seeds: r3SeedsAll.length, sign: slim(signStats), review: slim(reviewStats), arb: slim(arbStats) }) + '\n');
    if (changed && spawnVectors) {
      // 向量重建耗时十几秒 → 分离后台,不等它
      try {
        const child = spawn(process.execPath, [path.join(here, 'modelRoute.mjs'), '--build-vectors'], {
          cwd: here, detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
        // 留痕分工(2026-11-10 根治):成功/失败由**子进程自己**写(见 modelRoute --build-vectors 分支);
        // 这里只兜底记录异常退出——父进程(prompt-guard --check)可能先退,旧实现全靠它的 exit 回调,
        // 结果 09:41 失败时 build-vectors.log 0 字节、问题被静默一整天。
        const logPath = path.join(path.dirname(statePath), 'build-vectors.log');
        child.on('exit', (code, signal) => {
          if (code === 0 && !signal) return; // 正常退出:子进程已自行落痕,不重复
          try { fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), source: 'spawn-exit', code, signal }) + '\n'); } catch { /* 日志失败不影响主流程 */ }
        });
      } catch { /* 起不来不影响样本库本身 */ }
    }
    return { state: 'grown', pool: merged.length, exemplars: exemplars.length, before: beforeN, changed, r3Seeds: r3SeedsAll.length, contestedPooled: contestedEntries.length, sign: signStats, review: reviewStats, arb: arbStats };
  } catch (e) {
    // S5-F1(20261118):失败也回写 state.at——原 catch 直接 return,节流看旧 at 连续放行,
    // 黄金集空/报告写失败窗口每轮空转烧 CPU。回写 at 让节流在失败后同样生效。
    try {
      const sp = path.join(dataDir, 'routing', STATE_FILE);
      fs.mkdirSync(path.dirname(sp), { recursive: true });
      fs.writeFileSync(sp, JSON.stringify({ at: now, error: String(e && e.message ? e.message : e) }) + '\n');
    } catch { /* 状态写失败不掩盖原错误 */ }
    return { state: 'failed', reason: String(e && e.message ? e.message : e) };
  }
  } finally {
    releaseJsonLock(lockPath);
  }
}

/**
 * 四票合议自动代签(2026-11-03 三投票+一加权定档,L3 层取消;2026-11-09 v3 口径正式化为四票合议):
 *   四票 = L1(词法)/L2(向量)/决策模型/行为形态;
 *   决策票是常驻合议方(本机 225 条实测 49% 成票依赖其凑 quorum,名实相符):起投与 2 票权重门槛按
 *     模型判定档案(resolveDecisionProfile().signing,缺省回退 0.6/0.9)标定——
 *     ≥twoVoteConf 记 2 票/≥min 记 1 票/更低弃权,可影响代签结果,但单票永不独签(quorum 仍要求最高票 ≥2 个不同投票源);
 *   反压制:决策票与行为票相左时权重降回 1 票(autoLabel.voteLabel);断网/跳闸 → 决策票弃权,三票照常,完全离线可用。
 * 唯一领先且 ≥2 票 ⇒ 签(reviewed=true, autoSigned=true);平票/单票 ⇒ 只留池。
 * 产出诊断报告(auto-label-report.md),**不需要人签字**。
 */
/**
 * 四票组装(代签与复核共用):L1 词法 / L2 向量(低置信弃权)/ 决策模型加权 / 行为形态。
 * 行为票默认取 row.label(代签候选=行为形态标签);复核场景传 behaviorFrom(row) 按 evidence 重放。
 * 决策模型批量判定失败/异常 → 跳闸并弃权,三票照常。返回 {voters:Map(row→voters), decisionNote}。
 */
async function gatherVoters({ rows, dataDir, l2MinConf, decisionMinConf, twoVoteConf = 0.9, classifyBatchFn, behaviorFrom = null }) {
  const { classifyPromptRaw } = await import('./classify.mjs');
  const { l2EmbedFn, loadVectors, knnClassify, vectorsMatchModel } = await import('./modelRoute.mjs');
  const { signable } = await import('./autoLabel.mjs');
  const embedFn = await l2EmbedFn({ dataDir });
  // 指纹不符(嵌入模型已切换)→ KNN 票弃权,不拿旧维度向量出错票(2026-11-08 修)
  const vectorsLoaded = loadVectors(dataDir);
  const vectorsDoc = embedFn && vectorsMatchModel(vectorsLoaded) ? vectorsLoaded : null;
  const dm = await import('./decisionModel.mjs');
  const cfgRaw = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'code-index.config.json'), 'utf8')); } catch { return {}; }
  })();
  // 判定总闸(v4 2026-11-09 远程链删):本地判定恒启用(decisionActive 恒 true);断路器开着时决策票弃权退三票。
  // 把 data config 传给判定:judgeBatch 恒本地(ollama/常驻),与代理判定同口径。
  const decisionOn = decisionActive(cfgRaw) && !dm.breakerOpen(dataDir);
  const decisionByRow = new Map();
  let decisionNote = null;
  let dmModel = null; // 决策模型血缘(2026-11-09):judgeBatch 返回的 backend,随决策票落盘 golden-set
  if (decisionOn) {
    try {
      const batch = classifyBatchFn || dm.classifyBatch;
      const cand = rows.map((r, i) => ({ id: i + 1, text: String(r.prompt || ''), row: r })).filter((x) => signable(x.row.prompt));
      if (cand.length) {
        const prof = dm.resolveDecisionProfile ? dm.resolveDecisionProfile(cfgRaw, { dataDir }) : null;
        const maxLat = Number(prof?.arm1?.maxLatencyMs) > 0 ? Number(prof.arm1.maxLatencyMs) : 30000;
        const dr = await batch(cand.map((x) => x.text), { config: cfgRaw, timeoutMs: maxLat }); // S2-2: honoring 档案 maxLatencyMs
        if (dr.skipped) {
          // 批量嵌入让行(2026-11-10):忙跳过 ≠ 故障——不跳闸,决策票本轮弃权,三票照常签
          decisionNote = dr.error || '批量嵌入进行中,决策票本轮弃权';
        } else if (dr.error) {
          dm.tripBreaker(`代签加权失败:${dr.error}`, dataDir);
          decisionNote = `决策模型失败已跳闸:${dr.error}`;
        } else {
          dmModel = dr.backend || null;
          const byId = new Map(cand.map((x) => [x.id, x]));
          for (const a of dr.answers) {
            const src = byId.get(a.id);
            if (src) decisionByRow.set(src.row, a);
          }
          if (dr.failedChunks) {
            const retryInfo = dr.retriedChunks ? `,退避重试 ${dr.retriedChunks} 次` : '';
            decisionNote = `决策模型 ${dr.failedChunks}/${dr.chunks} 个分片失败已跳过(其余照常计票${retryInfo})`;
          }
        }
      }
    } catch (e) {
      dm.tripBreaker(`代签加权异常:${e && e.message ? e.message : e}`, dataDir);
      decisionNote = '决策模型异常已跳闸';
    }
  }
  const voters = new Map();
  // LOO 参照集 pkey 索引(2026-11-10 阶段①):签入行会回流样本库,同一 prompt 的自邻居 cosine≈1;
  // 代签/复核时按 pkey 排除自身,断掉"L2 背答案自证"(taintFactor 只降权不剔除)。
  const refPkeys = vectorsDoc ? new Set(Object.values(vectorsDoc.vectors || {}).map((e) => e && e.pkey).filter(Boolean)) : null;
  for (const c of rows) {
    const l1 = classifyPromptRaw(c.prompt);
    let l2 = null;
    const pk = c.pkey || c.promptKey || promptKey(c.prompt || '');
    if (embedFn && vectorsDoc) {
      try {
        const v = await embedFn(c.prompt);
        l2 = knnClassify(v, vectorsDoc, { excludePkey: pk });
        if (l2 && refPkeys && refPkeys.has(pk)) l2.loo = true; // 审计标记:该票已排除自邻居
      } catch { /* L2 失败算弃权 */ }
    }
    const dec = decisionByRow.get(c);
    const dmVote = dec && dec.confidence >= decisionMinConf
      ? { type: dec.type, confidence: dec.confidence, weight: dec.confidence >= twoVoteConf ? 2 : 1, model: dmModel } // 2 票权重门槛按模型档案(v3)
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

async function readL2MinConf(dataDir) {
  // 统一走 resolveL2Config(2026-11-07 嵌套收口):l2.vote.minConf 新结构优先,旧 l2.minConf/旧顶层回落
  try {
    const { resolveL2Config } = await import('./modelRoute.mjs');
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'code-index.config.json'), 'utf8')) || {};
    return resolveL2Config(cfg.modelRouting || {}).voteMinConf;
  } catch { return 0.6; }
}

export async function autoSignGolden({ dataDir = DATA_DIR, labels = null, minVotes = 2, decisionMinConf = null, twoVoteConf = null, l2MinConf = null, classifyBatchFn = null, shadowEvidence = null } = {}) {
  // l2MinConf 缺省读配置 l2.minConf(与 classifyRoute 同一口径,2026-11-03 R1 审查修):
  // 旧硬编码 0.75 在边际置信口径下让 L2 票几乎恒弃权,配置调阈值不生效。
  if (l2MinConf == null) l2MinConf = readL2MinConf(dataDir);
  // 决策票门槛缺省读模型判定档案(v3,2026-11-09):signing.min=起投 / signing.twoVote=2 票权重;
  // 未建档模型回退 FALLBACK(0.6/0.9,与旧硬编码一致,行为零漂移)。
  if (decisionMinConf == null || twoVoteConf == null) {
    const { resolveDecisionProfile } = await import('./decisionModel.mjs');
    const prof = resolveDecisionProfile();
    if (decisionMinConf == null) decisionMinConf = Number(prof.signing.min) || 0.6;
    if (twoVoteConf == null) twoVoteConf = Number(prof.signing.twoVote) || 0.9;
  }
  const rows = labels || readJsonl(path.join(dataDir, 'routing', 'routinglog-labels.jsonl'));
  const { autoSign, mergeAutoSigned, writeReport } = await import('./autoLabel.mjs');
  const { renumberGolden } = await import('./buildExemplars.mjs');
  const { voters, decisionNote } = await gatherVoters({ rows, dataDir, l2MinConf, decisionMinConf, twoVoteConf, classifyBatchFn });
  const withVotes = rows.map((c) => ({ ...c, voters: voters.get(c) }));
  const { signed, contested, skipped } = autoSign(withVotes, (c) => c.voters, { minVotes });
  // 影子账本证据回流:promptKey 命中 → evidence 补 escalated/servedTier(P2 硬证据进行为真值,
  // 让 R2/R3 不再是"恒 0";"活多"证不了能力,这份证据才证"低档干不动")。只补不删。
  // signedAt(2026-11-10 阶段①):签入时间戳,TTL 复核的起点;每条都盖,不留"无时间"的标签。
  const signedAt = Date.now();
  // 人工改档锚点回流(20261119 用户裁定,影子先行):仅 live=true 才把人工改档档写进 evidence 供 deriveTierTruth;
  // 默认 live=false 只采集+审计(auditSwitchAgreement),不改真值/代签行为。would* 永不作真值(防循环红线)。
  let msAnchors = null, msLive = false;
  try {
    const ms = await import('./manualSwitch.mjs');
    const lc = loadConfig({ soft: true }); // S14-F1(20261120 夜审):坏 config JSON 时 process.exit 不可捕获,catch 兜不住——soft 化后 msLive=false 即零影响
    const msCfg = lc._configError ? ms.SWITCH_DEFAULTS
      : { ...ms.SWITCH_DEFAULTS, ...(lc.modelRouting?.manualSwitch || {}) };
    msLive = msCfg.enabled === true && msCfg.live === true;
    if (msLive) msAnchors = ms.loadManualSwitchAnchors({ dataDir });
  } catch { /* 通道不可用 = 零影响 */ }
  const signedWithEvidence = signed.map((s) => {
    if (!s.evidence) return { ...s, signedAt };
    // 影子账本的 pkey 是 promptKey(原文前 200 字)。代签原文用默认 400 会让超长 prompt 对不上。
    // 人工改档锚点仍按全文 400 存储,两边分开查,避免修好影子回流时拆掉锚点。
    const pkShadow = promptKey(String(s.prompt || ''), 200);
    const pkAnchor = promptKey(String(s.prompt || ''));
    const ex = shadowEvidence && shadowEvidence.get(pkShadow);
    const extra = {};
    if (ex) {
      if (ex.escalated === true) extra.escalated = true;
      if (ex.servedTier) extra.servedTier = ex.servedTier;
      // S2-1(20261119 夜审):上梯事件行的 from/to 一并回流——黄金证据缺 escalationTo 时
      // deriveTierTruth 只能按 servedTier 回落,真值单源字段不能断流。
      if (ex.escalationFrom) extra.escalationFrom = ex.escalationFrom;
      if (ex.escalationTo) extra.escalationTo = ex.escalationTo;
    }
    if (msLive && msAnchors) {
      const a = msAnchors.get(pkAnchor);
      if (a) { extra.manualSwitch = true; extra.manualSwitchTo = a.toTier; extra.manualSwitchDir = a.dir; extra.manualSwitchLive = true; }
    }
    if (!Object.keys(extra).length) return { ...s, signedAt };
    return { ...s, signedAt, evidence: { ...s.evidence, ...extra } };
  });
  const goldenFile = path.join(dataDir, 'routing', 'golden-set.jsonl');
  const existing = readJsonl(goldenFile);
  const merged = renumberGolden(mergeAutoSigned(signedWithEvidence, existing));
  atomicWriteFileSync(goldenFile, merged.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const report = writeReport({ signed, contested, skipped }, { dataDir, decisionNote: decisionNote || '' });
  return { signed: signedWithEvidence, signedCount: signedWithEvidence.length, contested: contested.length, skipped: skipped.length, contestedRows: contested, skippedRows: skipped, golden: merged.length, report: report.out, decisionNote: decisionNote || null };
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
export async function reviewGolden({ dataDir = DATA_DIR, minVotes = 2, decisionMinConf = null, twoVoteConf = null, l2MinConf = null, classifyBatchFn = null, now = Date.now() } = {}) {
  if (l2MinConf == null) l2MinConf = readL2MinConf(dataDir);
  // 决策票门槛缺省读模型判定档案(v3,与 autoSignGolden 同口径)
  if (decisionMinConf == null || twoVoteConf == null) {
    const { resolveDecisionProfile } = await import('./decisionModel.mjs');
    const prof = resolveDecisionProfile();
    if (decisionMinConf == null) decisionMinConf = Number(prof.signing.min) || 0.6;
    if (twoVoteConf == null) twoVoteConf = Number(prof.signing.twoVote) || 0.9;
  }
  const { voteLabel, signable } = await import('./autoLabel.mjs');
  const { labelFromShape } = await import('./importRoutingLog.mjs');
  const goldenFile = path.join(dataDir, 'routing', 'golden-set.jsonl');
  const rows = readJsonl(goldenFile);
  const cand = rows.filter((r) => r.autoSigned === true && r.reviewed === true && signable(r.prompt));
  const { voters, decisionNote } = await gatherVoters({
    rows: cand, dataDir, l2MinConf, decisionMinConf, twoVoteConf, classifyBatchFn,
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
  const reviewedHeavySet = new Set(); // heavy 反向候选当轮点名去重(跨周期由 reviewRows 台账留痕)
  for (const r of cand) {
    // multi 疑问形态一票否决(2026-11-06 用户拍板):标签=multi 但原文是疑问/征询形态(isInquiryShape:
    // 疑问结构+无祈使+无实改组锚)**且** L1 元提问防线也弃权(classifyPrompt=null)——双确认才否决,
    // 带疑问从句的真任务(把X注册进Y,L1 判 routine)不误伤。行为票把会话级工作强度漏进了单轮标签,
    // "问"被签成"做";否决独立于投票多数(行为票认同正是这批错标的成因),只摘标退池、绝不按预测重贴(红线)。
    if (normalizeType(r.humanLabel) === 'multi' && isInquiryShape(r.prompt) && classifyPrompt(r.prompt) == null) {
      demotedSet.set(r, {
        ...r, reviewed: false, autoSigned: false, humanLabel: null, autoLabel: null,
        demotedAt: now, demotedFrom: r.humanLabel,
        demoteRule: 'multi疑问形态一票否决(问被签成做,2026-11-06 定向翻案)',
      });
      reviewRows.push({
        ts: now, pkey: r.pkey || null, promptHead: String(r.prompt || '').slice(0, 120),
        from: r.humanLabel || null, verdict: 'demoted', votes: 0, sources: 1,
        voters: { multi: ['inquiry-morphology'] },
      });
      continue;
    }
    // multi 行为证据强度对齐(2026-11-06 用户拍板第二刀):multi 是强度声明——evidence 重放
    // labelFromShape 不到 heavy(写≥3/调用≥15)⇒ 签名管线内部不一致(别的票盖过了行为票),复核即摘。
    // 反向候选(2026-11-06 补):light/routine 但 evidence 重放=heavy 的也进复核——此前单向只查 multi,
    // 7 条"写 3-8 个文件"的重活被漏摘;不过反向只**点名不直接摘标**(行为票把会话级强度漏进单轮标签的
    // 方向恰好相反,直接摘会重蹈疑问形态覆辙),靠下方四票复核对齐裁定。
    const behaviorVote = (voters.get(r) || {}).behavior;
    if (normalizeType(r.humanLabel) === 'multi' && behaviorVote && behaviorVote.type && behaviorVote.type !== 'multi') {
      demotedSet.set(r, {
        ...r, reviewed: false, autoSigned: false, humanLabel: null, autoLabel: null,
        demotedAt: now, demotedFrom: r.humanLabel,
        demoteRule: `multi行为证据强度不符(重放=${behaviorVote.type},不到 heavy 门槛)`,
      });
      reviewRows.push({
        ts: now, pkey: r.pkey || null, promptHead: String(r.prompt || '').slice(0, 120),
        from: r.humanLabel || null, verdict: 'demoted', votes: 0, sources: 1,
        voters: { [behaviorVote.type]: ['behavior-replay'] },
      });
      continue;
    }
    if ((normalizeType(r.humanLabel) === 'routine' || normalizeType(r.humanLabel) === 'light')
      && behaviorVote && behaviorVote.type === 'multi' && !reviewedHeavySet.has(r)) {
      // heavy 反向候选:记录复核行(from=原标签,voters 标 behavior-replay→multi)但不摘——
      // reviewedHeavySet 防同一条每周期重复点名(等四票真翻案它才退出循环)。
      reviewRows.push({
        ts: now, pkey: r.pkey || null, promptHead: String(r.prompt || '').slice(0, 120),
        from: r.humanLabel || null, verdict: 'kept', votes: 0, sources: 1,
        voters: { multi: ['behavior-replay'] }, note: 'heavy证据但标'+r.humanLabel+'(反向候选,仅点名)',
      });
      reviewedHeavySet.add(r);
    }
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
  // 复核时间戳(2026-11-10 阶段①):每条机器签入行盖 reviewedAt——TTL 判活的依据。
  // 复核正常时每周期刷新;复核失效(异常/断路器)时旧戳会超期,由 maybeGrowPool 的 TTL 摘签兜底。
  const keptStamped = new Map();
  for (const r of cand) if (!demotedSet.has(r)) keptStamped.set(r, { ...r, reviewedAt: now });
  if (demotedSet.size || keptStamped.size) {
    const next = rows.map((r) => demotedSet.get(r) || keptStamped.get(r) || r);
    atomicWriteFileSync(goldenFile, next.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  // stability 台账(只增;超 2MB 截尾保留最近 2000 条,防单调膨胀)
  const reviewFile = path.join(dataDir, 'routing', 'golden-review.jsonl');
  try {
    let hist = readJsonl(reviewFile).concat(reviewRows);
    let blob = hist.map((r) => JSON.stringify(r)).join('\n') + '\n';
    if (blob.length > 2 * 1024 * 1024) { hist = hist.slice(-2000); blob = hist.map((r) => JSON.stringify(r)).join('\n') + '\n'; }
    atomicWriteFileSync(reviewFile, blob);
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
  return { candidates: cand.length, demoted: demotedSet.size, demotedRows: [...demotedSet.values()], golden: rows.length, decisionNote: decisionNote || null };
}

/**
 * 争议池二轮仲裁(2026-11-22):contested-pool.jsonl 此前零消费方、500 条纯积灰——四票未签
 * 候选(quorum-not-met)每周期照旧进出。本通道让决策模型对池内条目**带外重投一票**:新鲜决策票
 * 替换池内陈旧决策票,与已记的 l1/l2/behavior 票重新合议(voteLabel 同口径:唯一领先+权重≥2+
 * ≥2 源,1B 行为否决照旧——单模仍不独签,quorum 纪律不动)。
 *   达成 ⇒ ensemble-arb 签入黄金集(mergeAutoSigned 防丢工)并把条目**移出争议池**;
 *   仍争议 ⇒ 盖 arbAt(ARB_REASK_MS 内不重问:决策票本地免费,但每 6h 重投整池是浪费);
 *   决策跳闸/批量失败 ⇒ 弃权仲裁(fail-open,池与黄金集照旧)。
 * 不带上下文:离线池无 prevAssistant 通道(那是代理 arm 的地),靠重投的置信门槛本身。
 * classifyBatchFn 注入缝供测试密闭。返回 {asked, signed, stillContested, note}。
 */
export async function arbitrateContested({ dataDir = DATA_DIR, now = Date.now(), decisionMinConf = null, twoVoteConf = null, classifyBatchFn = null, arbTtlMs = ARB_REASK_MS } = {}) {
  const rows = readJsonl(path.join(dataDir, 'routing', CONTESTED_FILE));
  if (!rows.length) return { asked: 0, signed: 0, stillContested: 0, note: null };
  // 只仲裁带 voters 的 quorum-not-met 条目(review-demoted/ttl 行无 voters,天然排除);
  // arbAt 未过期的跳过(上轮问过、没结论,30 天内不再烧这批)。
  const cand = rows.filter((r) => r && r.prompt && r.voters && typeof r.voters === 'object'
    && Object.keys(r.voters).length
    && !(Number(r.arbAt) > 0 && now - Number(r.arbAt) < arbTtlMs));
  if (!cand.length) return { asked: 0, signed: 0, stillContested: rows.length, note: '无待仲裁条目' };
  if (decisionMinConf == null || twoVoteConf == null) {
    const { resolveDecisionProfile } = await import('./decisionModel.mjs');
    const prof = resolveDecisionProfile();
    if (decisionMinConf == null) decisionMinConf = Number(prof.signing.min) || 0.6;
    if (twoVoteConf == null) twoVoteConf = Number(prof.signing.twoVote) || 0.9;
  }
  const dm = await import('./decisionModel.mjs');
  const cfgRaw = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'code-index.config.json'), 'utf8')); } catch { return {}; }
  })();
  // 与 gatherVoters 同闸:本地判定恒启用 + 断路器开 → 本轮弃权仲裁
  if (!(decisionActive(cfgRaw) && !dm.breakerOpen(dataDir))) {
    return { asked: 0, signed: 0, stillContested: rows.length, note: '决策模型断路器开启,本轮弃权仲裁' };
  }
  const { signable, voteLabel, mergeAutoSigned } = await import('./autoLabel.mjs');
  const { renumberGolden } = await import('./buildExemplars.mjs');
  const batch = classifyBatchFn || dm.classifyBatch;
  const targets = cand.filter((c) => signable(c.prompt)).slice(0, CONTESTED_CAP);
  let answers = new Map(); // text → {type, confidence}
  let dmModel = null;
  let note = null;
  try {
    const dr = await batch(targets.map((c) => String(c.prompt || '')), { config: cfgRaw });
    if (dr.error) { note = `决策模型失败,本轮弃权仲裁:${dr.error}`; targets.length = 0; }
    else {
      dmModel = dr.backend || null;
      targets.forEach((c, i) => { const a = (dr.answers || []).find((x) => x.id === i + 1); if (a) answers.set(String(c.prompt || ''), a); });
      if (dr.failedChunks) note = `决策模型 ${dr.failedChunks}/${dr.chunks} 个分片失败已跳过(其余照常仲裁)`;
    }
  } catch (e) { note = `仲裁决策票异常,本轮弃权:${e && e.message ? e.message : e}`; targets.length = 0; }
  const signedRows = [];
  const resolved = new Set();
  const nextRows = rows.map((r) => {
    const hit = targets.find((c) => c === r);
    if (!hit) return r;
    const fresh = answers.get(String(r.prompt || ''));
    const voters = { ...r.voters };
    if (fresh && Number(fresh.confidence) >= decisionMinConf) {
      voters.decision = { type: fresh.type, confidence: Number(fresh.confidence), weight: Number(fresh.confidence) >= twoVoteConf ? 2 : 1, ...(dmModel ? { model: dmModel } : {}), fresh: true };
    } else {
      delete voters.decision; // 重投未起投 ⇒ 决策票弃权(不带池内陈旧决策票充数)
    }
    const v = voteLabel(voters);
    if (v.type && !v.contested && v.votes >= 2) {
      resolved.add(r);
      signedRows.push({
        project: r.project || 'TokenSaver',
        prompt: r.prompt,
        autoLabel: v.type, humanLabel: v.type,
        semanticType: v.type, intensityType: null,
        reviewed: true, autoSigned: true, arbitrated: true,
        labelRule: `ensemble-arb(${Object.values(v.voters).flat().join('+')})`,
        agreement: v.agreement, votes: v.votes, sources: v.sources,
        voters,
        evidence: { toolCalls: r.toolCalls != null ? r.toolCalls : '-', writeEdits: r.writeEdits != null ? r.writeEdits : '-' },
        signedAt: now,
      });
      return null; // 仲裁达成,移出争议池
    }
    return { ...r, arbAt: now, arbResult: 'still-contested' }; // 未达成:盖戳,重问间隔内跳过
  }).filter(Boolean);
  if (signedRows.length) {
    const goldenFile = path.join(dataDir, 'routing', 'golden-set.jsonl');
    const existing = readJsonl(goldenFile);
    const merged = renumberGolden(mergeAutoSigned(signedRows, existing));
    atomicWriteFileSync(goldenFile, merged.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }
  atomicWriteFileSync(path.join(dataDir, 'routing', CONTESTED_FILE), nextRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { asked: targets.length, signed: signedRows.length, stillContested: nextRows.length, note };
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

/** 只重写黄金集与样本库,不嵌向量。托盘先等这一步结束并刷新进度条,再另起 --build-vectors。 */
export async function growDecisionNow({ dataDir = DATA_DIR } = {}) {
  return maybeGrowPool({ dataDir, minIntervalMs: 0, spawnVectors: false });
}

/** 命令行一步做完:无视 6 小时节流,先更新黄金集与样本库,再重嵌决策向量。对齐失败不改样本库,仍重嵌现有库。 */
export async function syncDecisionNow({ dataDir = DATA_DIR } = {}) {
  const grown = await growDecisionNow({ dataDir });
  const { buildVectors } = await import('./modelRoute.mjs');
  const vectors = await buildVectors({ dataDir });
  return { grown, vectors };
}

// CLI:node autoExemplars.mjs --review-golden | --grow-now | --sync-now
const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun && process.argv.includes('--review-golden')) {
  reviewGolden().then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(`[err] ${e && e.message ? e.message : e}`); process.exit(1); });
}
if (directRun && process.argv.includes('--grow-now') && !process.argv.includes('--sync-now')) {
  growDecisionNow().then((g) => {
    console.log(JSON.stringify({ grow: g.state, reason: g.reason || null, exemplars: g.exemplars ?? null }));
    if (g.state === 'failed') process.exit(1);
    process.exit(0);
  }).catch((e) => { console.error(`[err] ${e && e.message ? e.message : e}`); process.exit(1); });
}
if (directRun && process.argv.includes('--sync-now')) {
  syncDecisionNow().then((r) => {
    const g = r.grown || {};
    console.log(JSON.stringify({
      grow: g.state, reason: g.reason || null, exemplars: g.exemplars ?? null,
      embedded: r.vectors.embedded, reusedLocal: r.vectors.reusedLocal, ok: r.vectors.ok,
    }));
    if (g.state === 'failed') process.exit(1);
    process.exit(0);
  }).catch((e) => { console.error(`[err] ${e && e.message ? e.message : e}`); process.exit(1); });
}

