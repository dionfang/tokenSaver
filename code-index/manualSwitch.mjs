/**
 * manualSwitch.mjs — 人工改档真值通道(20261119 用户裁定落地)。
 *
 * 设计要点(用户定档):
 *   - 只采「人工改档动作」(同 session 相邻 turn 齿轮/模型名变化),不采静态默认选档——
 *     主动改档=经过思考的档位判断;日常不改档可能只是随意/不在意,无信号。
 *   - 改档目标模型档=人工锚点真值,独立于分类器(用户侧事实,与 flagship 同类)⇒不触 #14 循环红线。
 *   - 方向不对称:升档高权(人肉版 P2 上梯,conf 0.8)/降档低权(动机混杂:省钱/求快≠任务轻,conf 0.5)/
 *     同档换模型最弱(conf 0.3)。
 *   - would*(难度裸解析)只作对照,**绝不作真值**(分类器自己的预测回灌=循环自证)。
 *   - 影子先行:默认 live=false,只采集+审计三方一致率(人工 vs would vs 结果),达标(agreeMin)再开 live。
 *
 * 采集口径同 test/scripts/manualSwitchProbe.mjs(齿轮判定/换档事件/归因换档前 prompt),本模块是其生产化提升。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { tierOfModel, TIER_RANK } from './modelRoute.mjs';
import { promptKey } from './buildExemplars.mjs';
import { DATA_DIR } from './config.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_DB = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const LEDGER = 'manual-switch.jsonl';

/** 通道默认参数(用户裁定:升 0.8/降 0.5/同档 0.3/一致率门槛 0.8/影子先行 live=false)。 */
export const SWITCH_DEFAULTS = { enabled: true, live: false, upConf: 0.8, downConf: 0.5, lateralConf: 0.3, agreeMin: 0.8 };

/** model_id → {gear:'auto',rate}|{gear:'manual',name};null 过滤(test-* 探针/空)。同探针口径。 */
export function parseGear(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^test-/i.test(s)) return null;
  const seg = s.includes('/') ? s.split('/').pop() : s;
  const m = /^auto(?:\s*×\s*([0-9.]+))?$/i.exec(seg);
  if (m) return { gear: 'auto', rate: m[1] ? Number(m[1]) : null };
  return { gear: 'manual', name: seg.toLowerCase() };
}

/** 剥注入标记取用户原文(同探针 cleanPrompt)。 */
export function cleanPrompt(txt) {
  for (const marker of ['[code-index]', '[model-routing]', '[Hook additional context]']) {
    if (txt && txt.includes(marker)) txt = txt.split(marker)[0].trim();
  }
  return txt || '';
}

const gearKey = (g) => (g.gear === 'auto' ? 'auto' : `manual:${g.name}`);
const gearModel = (g) => (g.gear === 'auto' ? 'auto' : g.name);

/** 改档方向:目标档 vs 来源档。auto 显式视作 R1 sticky 基准(tierOfModel('auto') 会落 normal R2,不对)。纯函数。 */
export function switchDirection(fromModel, toModel, tierOpts = {}) {
  const rankOf = (m) => (String(m || '').toLowerCase() === 'auto' ? 1 : (TIER_RANK[tierOfModel(m, tierOpts)] || 1));
  const f = rankOf(fromModel);
  const t = rankOf(toModel);
  if (t > f) return 'up';
  if (t < f) return 'down';
  return 'lateral';
}

/**
 * 纯函数:从有序 model_usage 行提取换档事件。rows 须按 session_id,started_at 排序。
 * promptOf(messageId)→原文(注入以便密闭测试,不依赖 db)。归因=换档前最后 turn 的 parent 用户消息。
 * 返回 [{pkey,promptHead,from,to,toTier,dir,host,ts}]。dev 噪音:cleanPrompt 剥标记 + parseGear 滤 test-*。
 */
export function extractSwitches(rows, { promptOf = () => null, host = null, tierOpts = {} } = {}) {
  const events = [];
  let prev = null;
  for (const r of rows || []) {
    const gear = parseGear(r.model_id);
    if (!gear) { continue; } // 过滤行不打断连续性(prev 保留)
    if (prev && prev.session_id === r.session_id && gearKey(prev.gear) !== gearKey(gear)) {
      const prompt = cleanPrompt(promptOf(prev.parent_user_message_id) || '');
      const from = gearModel(prev.gear);
      const to = gearModel(gear);
      const toTier = gear.gear === 'manual' ? tierOfModel(gear.name, tierOpts) : 'R1';
      events.push({
        pkey: prompt ? promptKey(prompt) : null,
        promptHead: prompt.slice(0, 200),
        from, to, toTier,
        dir: switchDirection(from, to, tierOpts),
        host, ts: r.started_at,
        // 精确配对字段(20261119 审计加固 #2):会话/归因 prompt 的 turn 与 message/归因 prompt 轮时刻。
        // promptTs=换档前那一轮(被归因 prompt)的 started_at,与影子账本 ts(同轮代理落账时刻)对齐;
        // ts 仍记换档轮时刻保持旧口径兼容。
        sessionId: r.session_id || null,
        promptTurnId: prev.turn_id || null,
        promptMessageId: prev.parent_user_message_id || null,
        promptTs: prev.started_at ?? null,
      });
    }
    prev = { ...r, gear };
  }
  return events;
}

/** db 采集包装:读 interactive 行(滤子代理选档)→ extractSwitches。node:sqlite 不可用/打不开 → []。 */
export function collectSwitchEvents({ dbPath = DEFAULT_DB, host = null, tierOpts = {} } = {}) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return []; }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return []; }
  try {
    const rows = db.prepare(
      `SELECT session_id, turn_id, parent_user_message_id, model_id, started_at
       FROM model_usage WHERE task_type='interactive' ORDER BY session_id, started_at`
    ).all();
    const promptOf = (mid) => {
      if (!mid) return null;
      let parts;
      try { parts = db.prepare('SELECT data FROM part WHERE message_id=? ORDER BY sequence').all(mid); } catch { return null; }
      const texts = [];
      for (const p of parts || []) { try { const d = JSON.parse(p.data); if (typeof d?.text === 'string' && d.text.trim()) texts.push(d.text.trim()); } catch { /* 非 text */ } }
      return texts.length ? texts.join('\n') : null;
    };
    return extractSwitches(rows, { promptOf, host, tierOpts });
  } finally { try { db.close(); } catch { /* 已关 */ } }
}

/** 采集并追加落盘 manual-switch.jsonl(按 pkey+ts+to 去重);旧行缺 session/promptTs 时就地升级(db 重采匹配)。返回 {added, upgraded, total}。 */
export function refreshSwitchLedger({ dataDir = DATA_DIR, dbPath = DEFAULT_DB, host = null, tierOpts = {} } = {}) {
  const events = collectSwitchEvents({ dbPath, host, tierOpts });
  const file = path.join(dataDir, 'routing', LEDGER);
  let existing = [];
  try { existing = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* 无账本 */ }
  const keyOf = (e) => `${e.pkey}|${e.ts}|${e.to}`;
  const seen = new Set(existing.map(keyOf));
  const fresh = events.filter((e) => e.pkey && !seen.has(keyOf(e)));
  // 审计加固 #2:旧账本行无 sessionId/promptTs ⇒ 按 pkey|ts|to 从 db 重采事件补齐( db 是权威源,幂等)。
  const byKey = new Map(events.filter((e) => e.pkey).map((e) => [keyOf(e), e]));
  let upgraded = 0;
  for (const e of existing) {
    if (e.sessionId && e.promptTs != null) continue;
    const src = byKey.get(keyOf(e));
    if (!src) continue;
    e.sessionId = e.sessionId || src.sessionId || null;
    e.promptTurnId = e.promptTurnId || src.promptTurnId || null;
    e.promptMessageId = e.promptMessageId || src.promptMessageId || null;
    if (e.promptTs == null) e.promptTs = src.promptTs ?? null;
    upgraded += 1;
  }
  if (upgraded) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [...existing, ...fresh].map((e) => JSON.stringify(e)).join('\n') + '\n');
  } else if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return { added: fresh.length, upgraded, total: existing.length + fresh.length };
}

/** 读锚点账本 → Map pkey → {toTier,dir,ts}(同 key 取最近)。host 过滤(别端模型池隔离)。fail-open。 */
export function loadManualSwitchAnchors({ dataDir = DATA_DIR, host = null, tailCap = 50000 } = {}) {
  const out = new Map();
  let lines;
  try { lines = fs.readFileSync(path.join(dataDir, 'routing', LEDGER), 'utf8').split('\n').filter(Boolean); } catch { return out; }
  if (lines.length > tailCap) lines = lines.slice(-tailCap);
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r || !r.pkey || !r.toTier) continue;
    if (host && r.host && r.host !== host) continue;
    out.set(r.pkey, { toTier: r.toTier, dir: r.dir || 'lateral', ts: r.ts || null });
  }
  return out;
}

/** Wilson 95% 置信下界(正态近似 z=1.96);n≤0 → null。小样本即使全一致下界也偏低,防点估计假达标(#5)。 */
export function wilsonLower(successes, n, z = 1.96) {
  const N = Number(n) || 0;
  if (N <= 0) return null;
  const p = Number(successes) / N;
  const z2 = z * z;
  const denom = 1 + z2 / N;
  const centre = p + z2 / (2 * N);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * N)) / N);
  return Math.max(0, (centre - margin) / denom);
}

const mkDir = () => ({ n: 0, hw: 0, hwN: 0, ho: 0, hoN: 0, humanVsOutcome: null, wilsonLower: null });

function textOfPart(data) {
  try { const d = JSON.parse(String(data || '')); return typeof d?.text === 'string' ? d.text : ''; } catch { return ''; }
}

/** 影子行 sessionId 恢复:ts±windowMs 查 db part,两_pass 头匹配(全头→12字前缀,同 importRoutingLog 口径)。fail-open,绝不影响审计主流程。 */
function resolveShadowSessions(rows, { dbPath = DEFAULT_DB, windowMs = 120000 } = {}) {
  if (!rows.length) return;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return; }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return; }
  try {
    const near = db.prepare('SELECT session_id, time_created, data FROM part WHERE time_created BETWEEN ? AND ?');
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    for (const r of rows) {
      if (r.ts == null || !r.promptHead) continue;
      const head = norm(r.promptHead).slice(0, 30);
      const probe = head.slice(0, 12);
      let hits;
      try { hits = near.all(r.ts - windowMs, r.ts + windowMs); } catch { continue; }
      let hit = null;
      for (const h of hits) { const t = norm(textOfPart(h.data)); if (t && t.includes(head)) { hit = h; break; } }
      if (!hit) for (const h of hits) { const t = norm(textOfPart(h.data)); if (t && t.includes(probe)) { hit = h; break; } }
      if (hit && hit.session_id) r.sessionId = hit.session_id;
    }
  } finally { try { db.close(); } catch { /* 已关 */ } }
}

/**
 * 三方一致率审计(影子态核心,20261119 加固 #2+#5):人工锚点 vs would*(难度裸解析) vs 结果(实际服务档/上梯目标)。
 * #2 精确配对:按 pkey 收数组(不覆盖)+ |shadow.ts − anchor.promptTs| ≤ windowMs + 唯一匹配(拒 0=unmatched/拒多=ambiguous)
 *   + 重复锚点拒配 + 会话校验(影子 sessionId 经 db 对齐恢复;双方都有会话时须相等)。
 * #5 分层 CI 门:按 up/down/lateral 分层;liveReady=人工vs结果 Wilson 95% 下界 ≥ agreeMin 且 n ≥ minN(非点估计)。
 * would* 只作对照不作真值(防循环)。返回 {n, humanVsWould, humanVsOutcome, wouldVsOutcome, denominators,
 *   agreeMin, minN, windowMs, wilsonLower, byDirection, rejected, liveReady, sample}。
 */
export function auditSwitchAgreement({ dataDir = DATA_DIR, host = null, agreeMin = SWITCH_DEFAULTS.agreeMin, minN = 30, windowMs = 120000, tailCap = 50000, dbPath = DEFAULT_DB, resolveSession = true } = {}) {
  // 锚点:收全量列表(保留重复以便拒配),host 过滤。
  const anchorRows = [];
  let alines;
  try { alines = fs.readFileSync(path.join(dataDir, 'routing', LEDGER), 'utf8').split('\n').filter(Boolean); } catch { alines = []; }
  if (alines.length > tailCap) alines = alines.slice(-tailCap);
  for (const l of alines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r || !r.pkey || !r.toTier) continue;
    if (host && r.host && r.host !== host) continue;
    anchorRows.push(r);
  }
  // 影子:收全量 tier 行,按 pkey 索引成数组(不覆盖),host 过滤。
  const shadowByPkey = new Map();
  const shadowRows = [];
  let slines;
  try { slines = fs.readFileSync(path.join(dataDir, 'usage', 'routing-shadow.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { slines = []; }
  if (slines.length > tailCap) slines = slines.slice(-tailCap);
  for (const l of slines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r || r.source !== 'tier') continue;
    if (host && r.host && r.host !== host) continue;
    const key = r.pkey || (r.promptHead ? promptKey(String(r.promptHead)) : null);
    if (!key) continue;
    const outcome = (typeof r.escalationTo === 'string' && r.escalationTo) || (typeof r.servedTier === 'string' && r.servedTier) || null;
    const row = { pkey: key, ts: r.ts ?? null, sessionId: r.sessionId || null, promptHead: r.promptHead || '', wouldTier: r.wouldTier || null, outcome };
    shadowRows.push(row);
    if (!shadowByPkey.has(key)) shadowByPkey.set(key, []);
    shadowByPkey.get(key).push(row);
  }
  // 会话恢复:影子行缺 sessionId 时按 ts±窗口 + 头匹配对齐 db(fail-open;密闭测试可 resolveSession=false 跳过)。
  if (resolveSession) resolveShadowSessions(shadowRows.filter((r) => !r.sessionId), { dbPath, windowMs });
  // 重复锚点拒配:同 pkey|sessionId|promptTs 多次 ⇒ 整组剔除(归因不可信)。
  const aKeyOf = (a) => `${a.pkey}|${a.sessionId || ''}|${a.promptTs ?? a.ts ?? ''}`;
  const groupCount = new Map();
  for (const a of anchorRows) groupCount.set(aKeyOf(a), (groupCount.get(aKeyOf(a)) || 0) + 1);
  let n = 0, hw = 0, ho = 0, wo = 0, hwN = 0, hoN = 0, woN = 0;
  const byDirection = { up: mkDir(), down: mkDir(), lateral: mkDir() };
  const rejected = { duplicate: 0, ambiguous: 0, unmatched: 0, sessionMismatch: 0 };
  const sample = [];
  const seenAnchor = new Set();
  for (const a of anchorRows) {
    const ak = aKeyOf(a);
    if (groupCount.get(ak) > 1) { rejected.duplicate += 1; continue; }
    if (seenAnchor.has(ak)) continue;
    seenAnchor.add(ak);
    const at = a.promptTs ?? a.ts;
    const pool = shadowByPkey.get(a.pkey) || [];
    const cands = pool.filter((s) => {
      if (s.ts == null || at == null || Math.abs(s.ts - at) > windowMs) return false;
      if (a.sessionId && s.sessionId && a.sessionId !== s.sessionId) return false;
      return true;
    });
    if (!cands.length) {
      const inWindow = at != null && pool.some((s) => s.ts != null && Math.abs(s.ts - at) <= windowMs);
      if (inWindow) rejected.sessionMismatch += 1; else rejected.unmatched += 1;
      continue;
    }
    if (cands.length > 1) { rejected.ambiguous += 1; continue; }
    const s = cands[0];
    n += 1;
    const dir = a.dir || 'lateral';
    const bd = byDirection[dir] || (byDirection[dir] = mkDir());
    bd.n += 1;
    if (s.wouldTier) { hwN += 1; bd.hwN += 1; if (a.toTier === s.wouldTier) { hw += 1; bd.hw += 1; } }
    if (s.outcome) { hoN += 1; bd.hoN += 1; if (a.toTier === s.outcome) { ho += 1; bd.ho += 1; } }
    if (s.wouldTier && s.outcome) { woN += 1; if (s.wouldTier === s.outcome) wo += 1; }
    if (sample.length < 20) sample.push({ pkey: a.pkey, sessionId: a.sessionId || null, human: a.toTier, dir, would: s.wouldTier, outcome: s.outcome });
  }
  const rate = (x, d) => (d ? Math.round((x / d) * 1000) / 1000 : null);
  const humanVsOutcome = rate(ho, hoN);
  const ciLower = wilsonLower(ho, hoN);
  for (const d of Object.values(byDirection)) { d.humanVsOutcome = rate(d.ho, d.hoN); d.wilsonLower = wilsonLower(d.ho, d.hoN); }
  return {
    n, humanVsWould: rate(hw, hwN), humanVsOutcome, wouldVsOutcome: rate(wo, woN),
    denominators: { humanVsWould: hwN, humanVsOutcome: hoN, wouldVsOutcome: woN },
    agreeMin, minN, windowMs, wilsonLower: ciLower, byDirection, rejected,
    liveReady: humanVsOutcome != null && ciLower != null && ciLower >= agreeMin && hoN >= minN,
    sample,
  };
}