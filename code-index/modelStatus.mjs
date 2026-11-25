/**
 *本地模型部署状态(status.mjs 现场判定,auto.mjs 写入会话注入)。
 * 只探测:不拉起 Ollama、不 pull、不建索引。
 * 「运行正常」:modelIn=ollama 时要 Ollama 在听、两个 Ollama 模型已下载且正在驻留(/api/ps)、
 * 索引后端与模型名一致,且向量签名与当前块清单一致。已下载但 ollama ps 里没有,不算启动成功。本模块不拉起模型。
 * modelIn=local 时当前路径的向量须是 jina,权重在 hf-cache,且常驻进程里的嵌入和精排都已拉起;local 不探测 Ollama。
 * 向量只认 data/vectors/<当前路径>/,不看另一条路径。两条路径都还要求块清单在、签名未过期、没有进行中的嵌入进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DATA_DIR, DEFAULT_CONFIG, loadConfig, decisionLocalWanted } from './config.mjs';
import { ollamaProcessesRunning, resolveBase } from './ollamaGuard.mjs';
import { localOnnxCached } from './localRerank.mjs';
import { activeBackend, vectorPaths, readVectorMeta, vectorSignatureStale, pairedSnapshotUsable } from './vectorStore.mjs';
import { residentHealth } from './localResident.mjs';
import { pidAlive, LOCK_TTL_MS, atomicWriteFileSync, takeJsonLock, releaseJsonLock } from './proc.mjs';
import { isAutoModelName } from './virtualProvider.mjs';
import { loadTokenizer, lookupModel } from 'tokenizer-core';

const CHUNKS_PATH = path.join(DATA_DIR, 'chunks.jsonl');
const IDX_PATH = path.join(DATA_DIR, 'index.json');
const PIDFILE = path.join(DATA_DIR, '.embed.pid');
const SAVINGS_PATH = path.join(DATA_DIR, 'session-savings.json');
const TOKEN_CACHE = path.join(DATA_DIR, 'tokenizers');
const TOKEN_MODEL = 'qwen'; // exact,与本仓库 Qwen 嵌入/精排同一族
// tokenizer 下载超时(2026-11-24):原实现无 signal,网络被墙/半连时 fetch 无界挂起——
// search --symbol 的记账路径会因此永不返回(闸门里 search-symbol 套件 60s 超时的根因)。
// 6s/主机:两主机(官方+镜像)各 6s,失败即抛,调用方 catch 跳过记账,工具链不再被网络拖死。
const TOKEN_FETCH_TIMEOUT_MS = 6000;

function fileReady(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

function readEmbedPid() {
  try {
    const prev = JSON.parse(fs.readFileSync(PIDFILE, 'utf8'));
    if (pidAlive(prev.pid) && Number.isFinite(prev.ts) && Date.now() - prev.ts < LOCK_TTL_MS) return prev.pid;
  } catch { /* 无 pidfile */ }
  return null;
}

function getJson(url, ms) {
  return Promise.race([
    (async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function zeroBucket() {
  return { originalTokens: 0, compressedTokens: 0, savedTokens: 0, readInputTokens: 0 };
}

function bucketOf(raw) {
  const originalTokens = Math.max(0, Math.round(Number(raw?.originalTokens) || 0));
  const compressedTokens = Math.max(0, Math.round(Number(raw?.compressedTokens) || 0));
  const savedTokens = Math.max(0, Math.round(Number(raw?.savedTokens) || 0));
  // Read/Bash 工具结果实际进入上下文的量(信息字段),独立于节约三件套
  const readInputTokens = Math.max(0, Math.round(Number(raw?.readInputTokens) || 0));
  return { originalTokens, compressedTokens, savedTokens, readInputTokens };
}

/** 旧的平铺账(含 basisSaved)收成按日记录。没有原文分母的纯估算不带入。 */
export function normalizeSavings(j, now = Date.now()) {
  const updatedAt = Number.isFinite(j?.updatedAt) ? j.updatedAt : now;
  if (j?.days && typeof j.days === 'object' && !Array.isArray(j.days)) {
    const days = {};
    for (const [k, v] of Object.entries(j.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const [y, mo, da] = k.split('-').map(Number);
      if (dayKey(new Date(y, mo - 1, da).getTime()) !== k) continue; // 历法校验:'2026-13-99' 这类格式合法但日历不存在的键剔除
      days[k] = bucketOf(v);
    }
    return { updatedAt, days };
  }
  const originalTokens = Math.max(0, Math.round(Number(j?.originalTokens) || 0));
  const basis = Math.max(0, Math.round(Number(j?.basisSaved) || 0));
  let savedTokens = Math.max(0, Math.round(Number(j?.savedTokens) || 0));
  if (basis) savedTokens = Math.max(0, savedTokens - basis);
  else if (!(originalTokens > 0)) savedTokens = 0;
  const compressedTokens = Number.isFinite(Number(j?.compressedTokens))
    ? Math.max(0, Math.round(Number(j.compressedTokens)))
    : Math.max(0, originalTokens - savedTokens);
  if (!(originalTokens > 0) && !(compressedTokens > 0)) return { updatedAt, days: {} };
  return {
    updatedAt,
    days: {
      [dayKey(updatedAt)]: {
        originalTokens,
        compressedTokens,
        savedTokens: Math.max(0, originalTokens - compressedTokens),
      },
    },
  };
}

let savingsUnreadable = false; // 本进程内发现账本"在但读不了/解析不了"→ 拒绝写回,防止把整本历史当空账抹掉(2026-11-10 清账事故)

function readDoc() {
  let j = null;
  savingsUnreadable = false;
  try {
    j = JSON.parse(fs.readFileSync(SAVINGS_PATH, 'utf8'));
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      // 文件存在却读不出/是坏的(如掉电留下的 NUL 空账,2026-11-11 0:20 实证):绝不当"尚无账"覆盖。
      // 先把坏件改名留证;留证成功即可视为无账,走流水对账自愈;留证失败才禁写。
      let moved = false;
      try { fs.renameSync(SAVINGS_PATH, `${SAVINGS_PATH}.corrupt-${Date.now()}`); moved = true; } catch { /* 留证失败 */ }
      if (!moved) { savingsUnreadable = true; return normalizeSavings({}, Date.now()); }
      return healDoc(normalizeSavings({}, Date.now()));
    }
    /* ENOENT=尚无账 → 照样对账一次,断电清账后第一个读账进程即可自动回补 */
  }
  const doc = normalizeSavings(j || {}, Date.now());
  if (j && !j.days) {
    try { writeDoc(doc); } catch { /* 迁移失败不影响读取 */ }
  }
  return healDoc(doc);
}

function writeDoc(doc) {
  if (savingsUnreadable) throw new Error('session-savings.json 读不出/解析不了,拒绝覆盖防清账');
  maybeBackupSavings(); // 每日首写前先快照"昨天最后状态"(2026-11-11 加固)
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const days = {};
  for (const k of Object.keys(doc.days || {}).sort()) days[k] = bucketOf(doc.days[k]);
  atomicWriteFileSync(SAVINGS_PATH, JSON.stringify({ updatedAt: Date.now(), days })); // 原子写+fsync:崩溃/掉电不留半截账
}

// ---------- 账本自愈与每日备份(2026-11-11 加固:两次清账事故的纵深防御) ----------

/** 从 turns 流水取最后一条有效对账记录(total 明显大于 today 的才算历史仍可信;total==today 是清账后的重建流水,跳过)。 */
export function readTurnsLastGood(turnsPath = path.join(DATA_DIR, 'usage', 'turns.jsonl')) {
  try {
    const lines = fs.readFileSync(turnsPath, 'utf8').trim().split('\n');
    let lastGood = null;
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      const today = Math.max(0, Math.round(Number(j?.today) || 0));
      const total = Math.max(0, Math.round(Number(j?.total) || 0));
      if (total > today + 1000) lastGood = { ts: Math.round(Number(j?.ts) || 0), today, total };
    }
    return lastGood;
  } catch { return null; } // 无流水/读不了 → 对不出账,不动
}

/** 对账自愈(纯函数):days 现值合计低于流水最后有效 total → 把缺的历史(total−当日)补进记录日的前一天桶;
 *  完好则原样返回同一对象。当日部分不补——由水位机制自愈,避免与重新入账双计。 */
export function healSavingsFromTurns(days, lastGood) {
  if (!lastGood) return days;
  const norm = (v) => Math.max(0, Math.round(Number(v) || 0));
  let cur = 0;
  for (const d of Object.values(days || {})) cur += norm(d?.savedTokens);
  if (cur >= lastGood.total) return days;
  const hist = Math.max(0, lastGood.total - lastGood.today);
  const d = new Date(lastGood.ts || Date.now());
  const key = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime());
  const out = { ...(days || {}) };
  const old = out[key] || {};
  out[key] = {
    originalTokens: Math.max(norm(old.originalTokens), hist),
    compressedTokens: norm(old.compressedTokens),
    savedTokens: Math.max(norm(old.savedTokens), hist),
    readInputTokens: norm(old.readInputTokens),
  };
  return out;
}

let healChecked = false; // 每进程只对账一次(兜底逻辑,不进热路径)
let healLastResult = { changed: false };
function healDoc(doc) {
  if (healChecked) return doc;
  healChecked = true;
  try {
    const healed = healSavingsFromTurns(doc.days, readTurnsLastGood());
    const changed = healed !== doc.days;
    healLastResult = { changed };
    if (changed) { try { writeDoc({ updatedAt: Date.now(), days: healed }); } catch { /* 写失败不影响读 */ } }
    return { ...doc, days: healed };
  } catch { healLastResult = { changed: false }; return doc; }
}

const SAVINGS_BACKUP_DIR = path.join(DATA_DIR, 'backups', 'session-savings');

/** 备份轮转:按文件名(YYYY-MM-DD.json,dayKey 口径)升序只保留最近 keep 份,其余删除。 */
export function pruneSavingsBackups(dir = SAVINGS_BACKUP_DIR, keep = 14) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return; }
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* 删不掉就算了 */ }
  }
}

let lastBackupDay = null;
/** 每日懒备份:当天首次写账前把磁盘上现有账本拷一份(= 昨天最后状态),保留 14 天。 */
function maybeBackupSavings() {
  try {
    const day = dayKey(Date.now());
    if (lastBackupDay === day) return;
    lastBackupDay = day; // 无论成败当天只试一次
    if (!fs.existsSync(SAVINGS_PATH)) return; // 尚无账可备
    fs.mkdirSync(SAVINGS_BACKUP_DIR, { recursive: true });
    const dest = path.join(SAVINGS_BACKUP_DIR, `${day}.json`);
    if (!fs.existsSync(dest)) fs.copyFileSync(SAVINGS_PATH, dest);
    pruneSavingsBackups();
  } catch { /* 备份失败不影响记账 */ }
}

/** 手动修复入口(CLI:rebuild-savings.mjs):强制对账自愈一次→写回→返回摘要。留证失败的禁写态会如实抛错。 */
export function repairSavingsLedger() {
  healChecked = false;
  const doc = readDoc();
  let total = 0;
  for (const d of Object.values(doc.days || {})) total += Math.max(0, Math.round(Number(d?.savedTokens) || 0));
  try { writeDoc({ updatedAt: Date.now(), days: doc.days }); } catch { /* 禁写态抛给 CLI */ }
  return { total, dayCount: Object.keys(doc.days || {}).length, changed: healLastResult.changed === true };
}

function readSavingsState() {
  const doc = readDoc();
  const date = dayKey(Date.now());
  return { ...(doc.days[date] || zeroBucket()), date, days: doc.days };
}

/** 今天的节约。过了本机 24:00 显示 0,以往日期仍留在文件里。 */
export function readSessionSavings() {
  return readSavingsState().savedTokens;
}

/** 检索节约的原文分母(纯):命中块正文按文件行区间**并集去重**拼接。
 *  块文本首行是 header,正文第 k 行对应 s+k;索引相邻块有 overlapLines 重叠,
 *  直接拼接会把重叠行重复计入 → 原文分母偏大 → 节约高估(2026-11-18 节约口径审查修)。
 *  同文件按 s 升序,跳过已被前块覆盖的行;不同文件各自累计。 */
export function mergeHitBodies(chunks, kept) {
  const byFile = new Map();
  for (const i of kept || []) {
    const c = chunks?.[i];
    if (!c) continue;
    const raw = String(c.t || '');
    const nl = raw.indexOf('\n');
    const body = nl >= 0 ? raw.slice(nl + 1) : raw;
    const arr = byFile.get(c.p) || [];
    arr.push({ s: Number(c.s) || 0, e: Number(c.e) || 0, lines: body.split('\n') });
    byFile.set(c.p, arr);
  }
  const parts = [];
  for (const arr of byFile.values()) {
    arr.sort((a, b) => a.s - b.s);
    let covered = -1;
    for (const b of arr) {
      const from = Math.max(0, covered - b.s + 1);
      const seg = b.lines.slice(from).join('\n');
      if (seg.trim()) parts.push(seg);
      covered = Math.max(covered, b.e);
    }
  }
  return parts.join('\n');
}

/** 一次请求:原文 token、压缩后 token。节约 = 原文 − 压缩后。 */
export function savingsFromCounts(originalTokens, compressedTokens) {
  const original = Math.max(0, Math.round(Number(originalTokens) || 0));
  const compressed = Math.max(0, Math.round(Number(compressedTokens) || 0));
  const saved = Math.max(0, original - compressed);
  return { original, compressed, saved };
}

/** 累加进 state.date 那一天,其它日期不动。原文为 0 则原样返回。savedTokens 由当天两个累计相减。 */
export function accumulateSavings(state, originalTokens, compressedTokens) {
  const counted = savingsFromCounts(originalTokens, compressedTokens);
  if (counted.original <= 0) return state;
  const date = state.date || dayKey(Date.now());
  const days = { ...(state.days || {}) };
  const bucket = {
    originalTokens: (state.originalTokens || 0) + counted.original,
    compressedTokens: (state.compressedTokens || 0) + counted.compressed,
    savedTokens: 0,
    // 信息字段必须透传,否则一次搜索/拦截记账会把当日 readInputTokens 清零
    readInputTokens: state.readInputTokens || 0,
  };
  bucket.savedTokens = Math.max(0, bucket.originalTokens - bucket.compressedTokens);
  days[date] = bucket;
  return { ...bucket, date, days };
}

export function addInputSavings(originalTokens, compressedTokens) {
  // 锁内读改写(2026-11-10 二次审计 P1-4):session-savings.json 跨进程共享,双钩子并发时互相覆盖丢账;
  // 锁忙时跳过本笔返回现值(单笔量级小,下笔自愈),与 warmedRegistry 同模式。
  const lockPath = SAVINGS_PATH + '.lock';
  if (!takeJsonLock(lockPath)) return readSavingsState().savedTokens;
  try {
    const state = readSavingsState();
    const next = accumulateSavings(state, originalTokens, compressedTokens);
    if (next === state) return state.savedTokens;
    try { writeDoc(next); } catch { /* 记账失败不影响检索 */ }
    return next.savedTokens;
  } finally { releaseJsonLock(lockPath); }
}

/** 工具结果实际进入上下文的量(Read/Bash,bytes/4 折算)。信息字段,不影响 savedTokens。
 *  锁内读改写(2026-11-10):与 addInputSavings/addAccumulatedSavings 共账本,裸写并发会互相覆盖丢账;信息字段锁忙直接跳过。 */
export function addReadInputTokens(tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n <= 0) return;
  const lockPath = SAVINGS_PATH + '.lock';
  if (!takeJsonLock(lockPath)) return;
  try {
    const state = readSavingsState();
    const date = state.date || dayKey(Date.now());
    const days = { ...(state.days || {}) };
    const bucket = bucketOf(days[date]);
    bucket.readInputTokens += n;
    days[date] = bucket;
    try { writeDoc({ updatedAt: Date.now(), days }); } catch { /* 记账失败不影响调用方 */ }
  } finally { releaseJsonLock(lockPath); }
}

/** 当日实际读入的 token(信息口径)。 */
export function readDayReadInputTokens() {
  return readSavingsState().readInputTokens || 0;
}

const READ_EVENTS_PATH = path.join(DATA_DIR, 'read-guard', 'events.jsonl');
const ZCODE_DB_PATH = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const AGENT_USAGE_PATH = path.join(DATA_DIR, 'usage', 'agent-usage.jsonl');

let nodeSqlite; // undefined=未探测; null=不可用(Node<22.5); 否则 DatabaseSync
function getSqlite() {
  if (nodeSqlite !== undefined) return nodeSqlite;
  try { nodeSqlite = createRequire(import.meta.url)('node:sqlite').DatabaseSync; }
  catch { nodeSqlite = null; } // db 兜底关闭,不影响其余
  return nodeSqlite;
}

/** 事件留痕:一行一 JSON(拦截 deny、Search、SearchClaim;void 仅历史遗留,read-guard 已不再产生)。失败静默,不影响主流程。 */
export function appendReadEvent(entry) {
  try {
    fs.mkdirSync(path.dirname(READ_EVENTS_PATH), { recursive: true });
    fs.appendFileSync(READ_EVENTS_PATH, JSON.stringify(entry) + '\n');
  } catch { /* 留痕失败不影响主流程 */ }
}

// ---------- 预取免读 claim(PU-002 选项 A,2026-11-18):prefetch 注入只登记不入账;
// 同会话后续 read-guard 拦截同文件才转正(归因强=证实 agent 有整读意图而被免),转正时 guard
// 不再重复入账(防双计),compressed 用预取实际注入量(真实已花成本)。未证实的 claim 过期丢弃。 ----------
const PREFETCH_CLAIMS_PATH = path.join(DATA_DIR, 'usage', 'prefetch-claims.jsonl');
const CLAIM_TTL_MS = 7 * 24 * 3600 * 1000;
const normClaimFile = (f) => String(f || '').replace(/\\/g, '/').toLowerCase();

export function appendPrefetchClaim(claim, file = PREFETCH_CLAIMS_PATH) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...claim, claimed: false }) + '\n');
  } catch { /* 登记失败不影响注入 */ }
}

/** 认领一条未转正 claim(同会话+同文件,路径后缀兼容项目相对/绝对);成功即标 claimed 落盘,只认一次。 */
export function takePrefetchClaim(session, filePath, { now = Date.now(), file = PREFETCH_CLAIMS_PATH } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return null; }
  const sid = String(session || '');
  const want = normClaimFile(filePath);
  if (!sid || !want) return null;
  let hit = null;
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (now - Number(j.at || 0) > CLAIM_TTL_MS) continue; // 过期顺带清理
    const cf = normClaimFile(j.file);
    const match = !j.claimed && j.session === sid && (cf === want || want.endsWith('/' + cf));
    if (match && !hit) { hit = j; out.push(JSON.stringify({ ...j, claimed: true, claimedAt: now })); }
    else out.push(JSON.stringify(j));
  }
  if (!hit) return null;
  try { atomicWriteFileSync(file, out.join('\n') + '\n'); } catch { return null; }
  return hit;
}

/**
 * 事件读取。day=null → 全部事件(跨日连续累计用);否则只取该日。
 * 返回三类:拦截事件(带 session)、Search 事件(session 暂空,待认领)、SearchClaim(归属指认)。
 * 缺文件/坏行跳过。
 */
export function readReadEvents(eventsPath = READ_EVENTS_PATH, day = dayKey(Date.now())) {
  let lines = [];
  try { lines = fs.readFileSync(eventsPath, 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (!j) continue;
      if (day && dayKey(Number(j.at)) !== day) continue;
      if (j.kind === 'SearchClaim') { out.push(j); continue; }
      if (j.kind === 'Prefetch' && j.session && Number(j.originalTokens) > 0) { out.push(j); continue; }
      if (Number(j.bytes) > 0 && j.session) { out.push(j); continue; }
      if (j.kind === 'Search' && Number(j.originalTokens) > 0) out.push(j);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** Search 事件按 SearchClaim 归属(refAt 精确指认,先到先得);claim 本身不外传。 */
export function attributeSearchEvents(events) {
  const claimed = new Map();
  for (const ev of events) {
    if (ev.kind === 'SearchClaim' && ev.session && Number.isFinite(Number(ev.refAt))) {
      const ref = Number(ev.refAt);
      if (!claimed.has(ref)) claimed.set(ref, ev.session);
    }
  }
  return events
    .filter((ev) => ev.kind !== 'SearchClaim')
    .map((ev) => (ev.kind === 'Search' && !ev.session && claimed.has(Number(ev.at)) ? { ...ev, session: claimed.get(Number(ev.at)) } : ev));
}

/** Bash 命令认领检索事件:命令含查询原文、120s 窗口内、未被认领,返回其 at;否则 null。 */
export function findSearchEventRef(events, command, now, windowMs = 120000) {
  const cmd = String(command || '');
  if (!cmd.includes('search.mjs')) return null;
  const claimed = new Set(events.filter((e) => e.kind === 'SearchClaim').map((e) => Number(e.refAt)));
  let best = null;
  for (const ev of events) {
    if (ev.kind !== 'Search' || ev.session) continue;
    const at = Number(ev.at);
    if (!Number.isFinite(at) || at > now || now - at > windowMs) continue;
    if (claimed.has(at)) continue;
    if (cmd.includes(String(ev.file || '')) && (best === null || at > best)) best = at;
  }
  return best;
}

// ---------- 水位化持久累计 ----------
// 账本只记入口一次;"会话累计"靠每次运行把增量滚进账本。rollout 会被轮换清理,
// 现场重放会让数字回落;水位(最后计入的 iteration)让已计入的部分永久留在账本里。

const WATERMARK_PATH = path.join(DATA_DIR, 'read-guard', 'watermarks.json');

/** 水位文件:{events:{key:{at,session,kind,file,tokens,counted,lastAt,lastKey,accumulated,voided}}}。 */
export function readWatermarks(file = WATERMARK_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j.events === 'object' && j.events ? j.events : {};
  } catch { return {}; }
}

/** 写水位(临时文件改名,避免半写)。 */
export function writeWatermarks(events, file = WATERMARK_PATH) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), events }, null, 1));
    fs.renameSync(tmp, file);
  } catch { /* 水位写失败不影响记账 */ }
}

/** 事件键:kind+at+file。void 事件与原事件同键,便于配对与退款。 */
export function eventKey(ev) {
  return `${ev.kind || '?'}|${ev.at}|${ev.file || ''}`;
}

/**
 * ZCode 数据源:一次拉取该会话边界之后的 main_turn completed 行(供会话内多个事件各自按各自边界计数)。
 * 返回 [{at, key}](at=started_at ms,key=logical_request_id);库不可用/查询失败 → null(信号"数据源不可用")。
 * 会话不存在或暂无新行 → [](计数 0,入口一次照记)。
 */
export function dbSessionRows(dbPath, sessionId, sinceMs) {
  const DatabaseSync = getSqlite();
  if (!DatabaseSync || !fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT started_at AS at, logical_request_id AS key FROM model_usage
         WHERE session_id = ? AND query_source = 'main_turn' AND status = 'completed' AND started_at >= ?
         ORDER BY started_at ASC`,
      ).all(sessionId, sinceMs);
      return rows.map((r) => ({ at: Number(r.at) || 0, key: String(r.key || '') }));
    } finally { db.close(); }
  } catch { return null; }
}

/** Cursor/Qoder 数据源:一次拉取该会话边界之后的记录(afterAgentResponse=turn 级 / Qoder 逐请求)。
 *  文件读不到 → null(数据源不可用);会话无新行 → [](计数 0)。 */
export function agentUsageSessionRows(agentUsagePath, session, sinceMs) {
  let lines;
  try { lines = fs.readFileSync(agentUsagePath, 'utf8').split('\n'); } catch { return null; }
  const out = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (!lines[idx].trim()) continue;
    let j;
    try { j = JSON.parse(lines[idx]); } catch { continue; }
    if (j.conversationId !== session) continue;
    const ts = Number(j.ts);
    if (!Number.isFinite(ts) || ts < sinceMs) continue; // 同毫秒保留,交给 countRowsAfter 按行号续接
    out.push({ at: ts, key: String(idx) });
  }
  return out;
}

/** 边界之后计数:at 更大,或同毫秒而 key 更大(同毫秒多 iteration 时稳定续接)。 */
export function countRowsAfter(rows, sinceMs, sinceKey = '') {
  let count = 0;
  let lastAt = 0;
  let lastKey = '';
  for (const r of rows || []) {
    if (!(r.at > sinceMs || (r.at === sinceMs && r.key > sinceKey))) continue;
    count += 1;
    if (r.at > lastAt || (r.at === lastAt && r.key > lastKey)) { lastAt = r.at; lastKey = r.key; }
  }
  return { count, lastAt, lastKey };
}

// ---------- 当前远程模型(状态句句首【】段,2026-11-04 用户定稿) ----------

/** 读文件末尾若干行(账本只增不删,尾部即最新;大文件不全量读)。 */
function readTailLines(file, maxLines = 256, maxBytes = 512 * 1024) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, maxBytes);
    if (len <= 0) return [];
    const fh = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fh, buf, 0, len, st.size - len);
      return buf.toString('utf8').split('\n').filter(Boolean).slice(-maxLines);
    } finally { fs.closeSync(fh); }
  } catch { return []; }
}

/** 代理账本就近配对:与锚点时间差最小的 zcode 行(±windowMs 内;qoder 行不配对)。
 *  优先取 target(决策改写目标=快照配置名,2026-11-04 加记),旧账本行无该字段退回 served(网关回报的规范名)。 */
function nearestProxyServed(at, windowMs, usageFile) {
  let best = null;
  let bestDiff = Infinity;
  for (const line of readTailLines(usageFile)) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || j.host === 'qoder') continue;
    const ts = Number(j.ts);
    if (!Number.isFinite(ts)) continue;
    const diff = Math.abs(ts - at);
    if (diff <= windowMs && diff < bestDiff) { bestDiff = diff; best = j; }
  }
  const m = best ? (best.target || best.served) : null;
  return m ? String(m) : null;
}

/** Qoder 虚拟档显真(只看 qoder 行,nearestProxyServed 的镜像):与锚点时间差最小的一条,
 *  优先 target(决策改写目标=配置名),退回 served;'auto'/空(全池兜底透传)不算真实模型,跳过。 */
function latestQoderProxyServed(at, windowMs, usageFile) {
  let best = null;
  let bestDiff = Infinity;
  for (const line of readTailLines(usageFile)) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || j.host !== 'qoder') continue;
    const ts = Number(j.ts);
    if (!Number.isFinite(ts)) continue;
    const m = j.target || j.served;
    if (!m || isAutoModelName(m)) continue; // 虚拟档名(含 auto×0.026 形态)不算真实模型(2026-11-07 统一口径)
    const diff = Math.abs(ts - at);
    if (diff <= windowMs && diff < bestDiff) { bestDiff = diff; best = j; }
  }
  return best ? String(best.target || best.served) : null;
}

/**
 * Qoder 转录直读:该会话最近一条 assistant 行里的 model(逐请求刷盘,轮内即可见)。
 * 位置 ~/.qoder-cn|.qoder/projects/<项目目录>/<sessionId>.jsonl;只扫尾部 256KB/300 行。
 * 用于轮内状态句刷新——agent-usage.jsonl 只在 prompt/SessionStart 扫描时更新,轮内取到的是旧尾巴。
 * 找不到(无该文件/无 message.model)→ null,调用方回落 agent-usage。
 */
/** Qoder 转录尾部最新 assistant 条目:{ model, ts }(ts=消息自身时间戳,作代理账本配对锚点;缺失为 null)。 */
export function qoderTranscriptEntry(sessionId, { home = os.homedir() } = {}) {
  const sid = String(sessionId || '').replace(/[^\w.-]/g, '');
  if (!sid) return null;
  for (const root of [path.join(home, '.qoder-cn', 'projects'), path.join(home, '.qoder', 'projects')]) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { continue; }
    for (const d of dirs) {
      const fp = path.join(root, d, `${sid}.jsonl`);
      if (!fs.existsSync(fp)) continue;
      for (const line of readTailLines(fp, 300, 256 * 1024).reverse()) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const m = j && typeof j === 'object' ? j.message : null;
        if (m && typeof m.model === 'string' && m.model) {
          const t = Date.parse(j.timestamp);
          return { model: m.model, ts: Number.isFinite(t) ? t : null };
        }
      }
      return null; // 文件存在但尾部没 model → 不跨项目目录乱找
    }
  }
  return null;
}

export function qoderTranscriptModel(sessionId, opts = {}) {
  return qoderTranscriptEntry(sessionId, opts)?.model || null;
}

/**
 * 当前远程模型名称:上一轮**主请求**(该轮首条 completed,同 turn_id 取最早)实际用的模型
 * ——语义是"这条 prompt 被路由到了哪档",不取工具续接(常落回 sticky flash,掩盖该轮真实升档)。
 * ZCode=db.sqlite model_usage.model_id——非 auto 直取;auto 会话记的是虚拟名(与 virtualProvider.AUTO_MODEL 同名),
 * 真实目标在 proxy-usage.jsonl 的 target/served 字段,按主请求时间戳就近配对补齐(优先 target=配置名)。
 * Qoder=转录直读(轮内逐请求可见)→ 旧回退 agent-usage.jsonl 该会话最近一条;Cusor=agent-usage。
 * Qoder 转录为虚拟档(…/auto,auto 档位制)时,用 proxy-usage 最近一条 qoder 行的真实模型替换显示(2026-11-05)。
 * 查无任何记录 → null(状态句省略【】段,不虚构)。
 */
export function currentRemoteModel(sessionId, { dbPath = ZCODE_DB_PATH, agentUsagePath = AGENT_USAGE_PATH, proxyUsageFile = path.join(DATA_DIR, 'usage', 'proxy-usage.jsonl'), windowMs = 300000, home = os.homedir() } = {}) {
  if (!sessionId) return null;
  const DatabaseSync = getSqlite();
  let anchor = null; // {at, modelId}
  if (DatabaseSync && fs.existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const last = db.prepare(
          `SELECT started_at AS at, model_id AS modelId, turn_id AS turnId FROM model_usage
           WHERE session_id = ? AND status = 'completed' AND query_source = 'main_turn'
           ORDER BY started_at DESC LIMIT 1`,
        ).get(sessionId) || null;
        if (last) {
          anchor = last.turnId
            // 主请求锚点:该轮同 turn_id 的最早一条 completed(工具续接同 turn_id 但更晚,天然被排除)
            ? (db.prepare(
                `SELECT started_at AS at, model_id AS modelId FROM model_usage
                 WHERE session_id = ? AND turn_id = ? AND status = 'completed' AND query_source = 'main_turn'
                 ORDER BY started_at ASC LIMIT 1`,
              ).get(sessionId, last.turnId) || last)
            : last; // 旧 schema 无 turn_id → 沿用最后一条
        }
      } finally { db.close(); }
    } catch { /* 库不可用落后续兜底 */ }
  }
  // db 里记的是客户端条目名(2026-11-07 起可为 auto×0.026 带倍率形态)——isAutoModelName 归一:
  // 带后缀的虚拟档不算真实模型,回落 proxy-usage 就近配对拿真实名,状态句【】段不显示 auto×名。
  if (anchor && anchor.modelId && !isAutoModelName(anchor.modelId)) return String(anchor.modelId);
  if (anchor) {
    const served = nearestProxyServed(Number(anchor.at) || 0, windowMs, proxyUsageFile);
    if (served) return served;
  }
  const entry = qoderTranscriptEntry(sessionId, { home });
  if (entry && entry.model) {
    // Qoder 虚拟档(auto 档位制,2026-11-07 起条目名可为 …/auto×0.026 带倍率形态):取最后一段
    // isAutoModelName 判定,虚拟档即用代理账本就近真实服务模型替换显示;查不到保持原样。
    // 锚点=消息自身 ts(2026-11-20 用户实测回归):消息先落盘、代理行晚几秒刷出,且轮间常隔
    // 数分钟——锚 Date.now() 在长间隔后错过该请求的行 → fail-open 裸条目名(flip-flop 现场复现);
    // 锚消息 ts + 300s 窗即按 nearest-diff 收敛到该请求的真实模型。
    // 直连条目名(qoder-custom-*/<model>)与 <synthetic> 不替换;ZCode 分支(上方 anchor 路径)不涉。
    const seg = String(entry.model).split('/').pop() || '';
    if (isAutoModelName(seg)) {
      const served = latestQoderProxyServed(entry.ts || Date.now(), windowMs, proxyUsageFile);
      if (served) return served;
      return autoDisplaySafe(String(entry.model)); // 账本查不到也别把 auto×0.026 当真实模型名显示
    }
    return String(entry.model);
  }
  for (const line of readTailLines(agentUsagePath).reverse()) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j && j.conversationId === sessionId && j.model) {
      const m = String(j.model);
      // agent-usage 记的也可能是虚拟档名(auto×0.026)——归一:虚拟档走代理账本就近替换,
      // 锚点=该行自身 ts(2026-11-20 同回归:锚 Date.now() 在长间隔后 fail-open 裸名)。
      if (isAutoModelName(m)) {
        const served = latestQoderProxyServed(Number(j.ts) || Date.now(), windowMs, proxyUsageFile);
        if (served) return served;
        return autoDisplaySafe(m);
      }
      return m;
    }
  }
  return null;
}

/** 虚拟档名安全显示:剔倍率后缀只留 auto——【当前远程模型】段不出现 auto×0.026(2026-11-07 统一口径)。 */
function autoDisplaySafe(m) {
  return String(m || '').split('×')[0].trim() || 'auto';
}

/**
 * 该会话最近一条已完成主请求所属的 turn_id(回合边界判定用,轮内状态句刷新与回合末结算都靠它)。
 * 轮内第一个请求一完成就有行可查,所以"最新完成的主请求"在回合中段即属于当前轮。
 * 非 ZCode 宿主(无 db.sqlite)或库不可用 → null,调用方按时间+模型节流兜底。
 */
export function latestCompletedTurn(sessionId, { dbPath = ZCODE_DB_PATH } = {}) {
  if (!sessionId) return null;
  const DatabaseSync = getSqlite();
  if (!DatabaseSync || !fs.existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(
      `SELECT started_at AS at, turn_id AS turnId, model_id AS modelId
       FROM model_usage
       WHERE session_id = ? AND status = 'completed' AND query_source = 'main_turn'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ).get(sessionId) || null;
    return row && row.turnId ? row : null;
  } catch { return null; } finally {
    try { db?.close(); } catch { /* 关不了不影响 */ }
  }
}

/**
 * 会话总计(跨日连续):由水位派生——每个事件的入口一次(tokens)+ 已计入的会话累计(accumulated)。
 * 事件级"入口一次"恒等于单次节约(tokens),所以 Σ(tokens + accumulated) 即该会话至今的总节约。
 */
export function sessionSavings(sessionId, watermarks = readWatermarks()) {
  let total = 0;
  let events = 0;
  for (const v of Object.values(watermarks || {})) {
    if (!v || v.session !== sessionId || v.voided) continue;
    total += (Number(v.tokens) || 0) + (Number(v.accumulated) || 0);
    events += 1;
  }
  return { total, events };
}

/** Qoder 压缩边界(scanQoderUsage 落盘):压缩后省下的上下文已不在场,累计到此为止。 */
export function readCompactionTimes(agentUsagePath, session) {
  try {
    const file = path.join(path.dirname(agentUsagePath), 'qoder-compaction.json');
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = map?.[session];
    if (!Array.isArray(list)) return [];
    return list.map((b) => Number(b?.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  } catch { return []; }
}

/** Cursor/Qoder 兜底:agent-usage.jsonl(data/usage,append-only,持久)按 conversationId
 *  数边界后记录。Cursor=turn 粒度(afterAgentResponse),Qoder=逐请求;续接键为文件行号。
 *  Qoder 若在边界后压缩过,只数到事件后第一次压缩前(压缩清掉已省下的上下文)。
 *  文件缺失或无该会话记录 → null。 */
export function agentUsageIterationsAfter(agentUsagePath, session, sinceMs, sinceIdx = -1) {
  let lines;
  try { lines = fs.readFileSync(agentUsagePath, 'utf8').split('\n'); } catch { return null; }
  const stopAt = readCompactionTimes(agentUsagePath, session).find((t) => t > sinceMs);
  let count = 0;
  let lastIdx = -1;
  let lastAt = 0;
  let total = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    if (!lines[idx].trim()) continue;
    let j;
    try { j = JSON.parse(lines[idx]); } catch { continue; }
    if (j.conversationId !== session) continue;
    total += 1;
    const ts = Number(j.ts);
    if (!Number.isFinite(ts)) continue;
    if (stopAt != null && ts >= stopAt) continue; // 压缩后的请求不再携带这段被省掉的上下文
    const after = ts > sinceMs || (ts === sinceMs && idx > sinceIdx);
    if (!after) continue;
    count += 1;
    if (idx > lastIdx) { lastIdx = idx; lastAt = ts; }
  }
  if (!total) return null;
  return { count, lastAt, lastKey: String(lastIdx) };
}

/** session 主键形态:标准 UUID=Cursor/Qoder;其余=ZCode(session_<hex> / sess_<uuid>)。 */
export function isUuidSession(session) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(session));
}

/** 源端会话盖章(PU-003,2026-11-18):宿主把会话 id 注入 Bash 子进程环境
 *  (实测 ZCode 主会话与子代理各自注入 ZCODE_SESSION_ID/CLAUDE_CODE_SESSION_ID,子代理=sess_subagent_agent_*)。
 *  检索事件出生即有主 → 子代理检索也能按 db/agent-usage 的该会话 iteration 放大,无需消费侧启发式认领。
 *  无 env(plain 终端/未注入宿主)返回 null,回落 read-nudge 命令认领兜底。 */
export function sessionFromEnv(env = process.env) {
  const sid = String(env?.ZCODE_SESSION_ID || env?.CLAUDE_CODE_SESSION_ID || env?.CLAUDE_SESSION_ID || '').trim();
  return sid || null;
}

/** 该会话的 iteration 行(边界之后);null=数据源不可用/会话无记录。 */
export function sessionIterationRows(session, sinceMs, { dbPath = ZCODE_DB_PATH, agentUsagePath = AGENT_USAGE_PATH } = {}) {
  if (isUuidSession(session)) return agentUsageSessionRows(agentUsagePath, session, sinceMs);
  return dbSessionRows(dbPath, session, sinceMs);
}

/** 单事件边界后的 iteration 数(内部用:一次拉取 + 各自边界计数)。 */
export function countIterationsFor(session, rows, sinceMs, sinceKey, agentUsagePath) {
  if (!rows) return null;
  const filtered = isUuidSession(session) && agentUsagePath
    ? (() => {
      const stopAt = readCompactionTimes(agentUsagePath, session).find((t) => t > sinceMs);
      return stopAt == null ? rows : rows.filter((r) => r.at < stopAt);
    })()
    : rows;
  return countRowsAfter(filtered, sinceMs, sinceKey);
}

/** 上下文上限封顶取值(2026-11-26):opts.contextCapTokens 显式注入(测试用) >
 *  data JSON contextCapTokens > DEFAULT_CONFIG.contextCapTokens。非正数按默认。 */
export function contextCapOf(opts = {}) {
  const n = Number(opts?.contextCapTokens);
  if (Number.isFinite(n) && n > 0) return n;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'code-index.config.json'), 'utf8'));
    const m = Number(j.contextCapTokens);
    if (Number.isFinite(m) && m > 0) return m;
  } catch { /* 缺文件或坏 JSON:用默认 */ }
  return DEFAULT_CONFIG.contextCapTokens;
}

/**
 * 纯计算:每个事件还差多少 iteration 没入账,以及应追加多少。
 * 单次节约:Read/Bash = bytes/4;Search = 命中块原文 tokens − 结果 tokens。
 * 无主(未认领)/voided(重发放行)不计;voided 需退回此前已入账的金额。
 * 事件可跨日:传入全部事件即可(会话累计不因午夜重置)。
 * 单事件节约封顶(2026-11-26):至多一个上下文上限(opts.contextCapTokens 或 data JSON
 * contextCapTokens,缺省 DEFAULT_CONFIG.contextCapTokens=1M)——超上下文文件全量 Read 放行
 * 也会被上游 context-length 拒绝,bytes/4 全额记账高估。放大与退款同源封顶。
 */
export function computeAccumulation(events, watermarks = {}, opts = {}) {
  const { dbPath = ZCODE_DB_PATH, agentUsagePath = AGENT_USAGE_PATH } = opts;
  const contextCap = contextCapOf(opts);
  const voided = new Set();
  for (const ev of events) {
    if (ev.void) voided.add(`${ev.session}|${ev.file}|${ev.at}`);
  }
  const seen = new Set();
  const detail = [];
  let total = 0;
  let refund = 0;

  // 每个会话只拉一次数据(按该会话所有事件的最小边界)
  const bounds = new Map();
  for (const ev of events) {
    if (!ev.session || ev.void || ev.kind === 'SearchClaim') continue;
    if (seen.has(eventKey(ev))) continue;
    if (voided.has(`${ev.session}|${ev.file}|${ev.at}`)) continue;
    const wm = watermarks[eventKey(ev)] || null;
    const b = wm && Number.isFinite(wm.lastAt) ? wm.lastAt : Number(ev.at);
    const cur = bounds.get(ev.session);
    if (cur == null || b < cur) bounds.set(ev.session, b);
  }
  const rowsBySession = new Map();
  for (const [session, minMs] of bounds) {
    const rows = sessionIterationRows(session, minMs, { dbPath, agentUsagePath });
    if (rows) rowsBySession.set(session, rows);
  }

  for (const ev of events) {
    if (ev.void || ev.kind === 'SearchClaim') continue;
    const key = eventKey(ev);
    const tokens = Math.min(
      (ev.kind === 'Search' || ev.kind === 'Prefetch')
        ? Math.max(0, Math.round(Number(ev.originalTokens) || 0) - Math.round(Number(ev.compressedTokens) || 0))
        : ev.kind === 'Rewrite'
          ? Math.max(0, Math.ceil((Number(ev.bytes) - Number(ev.rangeBytes || 0)) / 4))
          : Math.ceil(Number(ev.bytes) / 4),
      // 超上下文封顶(2026-11-26):单事件节约至多一个上下文上限——超限文件全量进上下文会被上游
      // context-length 拒绝,bytes/4 全额记账高估。放大 delta 与退款 entry 同源封顶,防退款大于入账。
      contextCap,
    );
    const wm = watermarks[key] || null;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!ev.session) {
      detail.push({ key, kind: ev.kind, file: ev.file, tokens, newIterations: 0, delta: 0, accumulated: wm?.accumulated || 0, unclaimed: true });
      continue;
    }
    if (voided.has(`${ev.session}|${ev.file}|${ev.at}`)) {
      // 重发放行 = 文件实际进了上下文:入口一次与已入账都要退,且只退一次
      const back = wm?.accumulated || 0;
      const entry = wm?.entryRefunded ? 0 : tokens;
      refund += back + entry;
      detail.push({ key, kind: ev.kind, file: ev.file, tokens, newIterations: 0, delta: 0, accumulated: 0, voided: true, refund: back + entry, entryRefund: entry, session: ev.session, at: Number(ev.at) });
      continue;
    }
    const sinceMs = wm && Number.isFinite(wm.lastAt) ? wm.lastAt : Number(ev.at);
    const sinceKey = wm ? String(wm.lastKey || '') : '';
    const rows = rowsBySession.get(ev.session);
    const res = countIterationsFor(ev.session, rows, sinceMs, sinceKey, agentUsagePath);
    if (!res) {
      detail.push({ key, kind: ev.kind, file: ev.file, tokens, newIterations: 0, delta: 0, accumulated: wm?.accumulated || 0, rolloutMissing: true, source: null });
      continue;
    }
    const delta = tokens * res.count;
    total += delta;
    detail.push({
      key,
      kind: ev.kind,
      file: ev.file,
      tokens,
      newIterations: res.count,
      delta,
      accumulated: (wm?.accumulated || 0) + delta,
      lastAt: res.lastAt,
      lastKey: res.lastKey,
      session: ev.session,
      at: Number(ev.at),
      source: isUuidSession(ev.session) ? 'agent-usage' : 'db',
    });
  }
  return { total, refund, detail };
}

/** 把增量记进当日桶(originalTokens 与 savedTokens 同增,compressedTokens 不动)。锁内读改写:
 * 金额大(会话累计差额),与入口一次/addReadInputTokens 并发时互相覆盖丢账不可接受;短重试拿锁,拿不到就放弃本笔(下轮 applySessionAccumulation 按水位差自愈)。 */
export function addAccumulatedSavings(extra) {
  const delta = Math.round(Number(extra) || 0);
  if (!delta) return;
  const lockPath = SAVINGS_PATH + '.lock';
  let locked = false;
  for (let i = 0; i < 5 && !locked; i++) {
    locked = takeJsonLock(lockPath);
    if (!locked) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (!locked) return;
  try {
    const state = readSavingsState();
    const date = state.date || dayKey(Date.now());
    const days = { ...(state.days || {}) };
    const bucket = bucketOf(days[date]);
    bucket.originalTokens = Math.max(0, bucket.originalTokens + delta);
    bucket.savedTokens = Math.max(0, bucket.savedTokens + delta);
    days[date] = bucket;
    try { writeDoc({ updatedAt: Date.now(), days }); } catch { /* 写失败不影响本次 */ }
  } finally { releaseJsonLock(lockPath); }
}

/**
 * 水位化持久累计入口:把"自上次以来新发生的 iteration"折算的节约滚进账本,并推进水位。
 * 已入账部分永久留在账本里,rollout 轮换后数字不回落;新增 iteration 只补差额,不重复计。
 * 跨日连续:读全部事件(不限当日),会话累计不因午夜中断;增量计入"今天实际发生的节约"。
 */
export function applySessionAccumulation() {
  const events = attributeSearchEvents(readReadEvents(READ_EVENTS_PATH, null));
  const watermarks = readWatermarks();
  const { total, refund, detail } = computeAccumulation(events, watermarks);
  let changed = false;
  for (const d of detail) {
    if (d.unclaimed) continue;
    if (d.voided) {
      const prev = watermarks[d.key] || {};
      watermarks[d.key] = {
        ...prev,
        at: d.at,
        session: d.session,
        kind: d.kind,
        file: d.file,
        tokens: d.tokens,
        counted: 0,
        lastAt: d.at || 0,
        lastKey: '',
        accumulated: 0,
        voided: true,
        entryRefunded: true,
      };
      changed = true;
      continue;
    }
    if (d.rolloutMissing) {
      // 数据源不可用:不放大,但入口一次仍要留痕(会话总计要含这一笔)。
      // 口径声明(PU-004 选项 B,2026-11-18):Cursor 无 usage 喂入(agent-usage 仅 ZCode/qoder 行),
      // 其会话恒走本分支=只计入口一次、不计会话放大;Qoder 有 qoder-usage 行覆盖放大。非缺陷,显式口径。
      if (!watermarks[d.key]) {
        watermarks[d.key] = { at: d.at, session: d.session, kind: d.kind, file: d.file, tokens: d.tokens, counted: 0, lastAt: d.at || 0, lastKey: '', accumulated: 0, voided: false };
        changed = true;
      }
      continue;
    }
    const prev = watermarks[d.key] || {};
    if (!d.newIterations && prev.counted != null) continue; // 已有水位且无新增 → 不动
    watermarks[d.key] = {
      ...prev,
      at: d.at,
      session: d.session,
      kind: d.kind,
      file: d.file,
      tokens: d.tokens,
      counted: (Number(prev.counted) || 0) + d.newIterations,
      lastAt: d.newIterations ? d.lastAt : (Number.isFinite(prev.lastAt) ? prev.lastAt : d.at),
      lastKey: d.newIterations ? d.lastKey : (prev.lastKey || ''),
      accumulated: d.accumulated,
      voided: false,
    };
    changed = true;
  }
  if (changed) writeWatermarks(watermarks);
  if (total) addAccumulatedSavings(total);
  if (refund) addAccumulatedSavings(-refund);
  return { total, refund, detail };
}

let encodePromise = null;
async function cacheTokenizer(model) {
  const entry = lookupModel(model);
  if (!entry || entry.source !== 'hf') return;
  const tokPath = path.join(TOKEN_CACHE, `${model}.json`);
  const cfgPath = path.join(TOKEN_CACHE, `${model}.config.json`);
  const files = [['tokenizer.json', tokPath], ['tokenizer_config.json', cfgPath]];
  fs.mkdirSync(TOKEN_CACHE, { recursive: true });
  for (const [name, dest] of files) {
    if (fileReady(dest)) continue;
    let err;
    for (const host of ['https://huggingface.co', 'https://hf-mirror.com']) {
      try {
        const res = await fetch(`${host}/${entry.repo}/resolve/${entry.sha}/${name}`, { signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        JSON.parse(text);
        atomicWriteFileSync(dest, text); // 原子写(2026-11-10 二次审计 P1-3+M2 漏列)
        err = null;
        break;
      } catch (e) { err = e; }
    }
    if (!fileReady(dest)) throw err;
  }
}
function encoder() {
  if (!encodePromise) {
    encodePromise = cacheTokenizer(TOKEN_MODEL).then(() => loadTokenizer(TOKEN_MODEL, TOKEN_CACHE)).then((tok) => {
      if (!tok) throw new Error(`无法加载 ${TOKEN_MODEL} tokenizer`);
      return (text) => (text ? tok.encode(text).ids.length : 0);
    }).catch((err) => { encodePromise = null; throw err; });
  }
  return encodePromise;
}

/** 成对计 token:原文、压缩后(精确 qwen 口径)。 */
export async function countInputTokensPair(originalText, compressedText) {
  const count = await encoder();
  return { original: count(String(originalText || '')), compressed: count(String(compressedText || '')) };
}

/** 先计原文 token,再计压缩后 token,差额并入当日累计。 */
export async function measureInputSavings(originalText, compressedText) {
  if (!String(originalText || '')) return readSessionSavings();
  const { original, compressed } = await countInputTokensPair(originalText, compressedText);
  return addInputSavings(original, compressed);
}

/** 节约量文本(只给绝对值)。压缩率已下线:累计增量只加 original/saved 不加 compressed,该比率无意义。 */
export function formatSavedClause(state) {
  const saved = Math.max(0, Math.round(state?.savedTokens || 0));
  return `${formatTokenCount(saved)} tokens`;
}

function formatTokenCount(n) {
  const v = Math.max(0, Math.round(n || 0));
  if (v < 10000) return String(v);
  // 百万单位(2026-11-22 用户定档):状态句大数字读得清——634 万 → 6.34 百万,76949 万 → 769.49 百万;
  // 两位小数,尾零舍去;万以下(<1 万)仍显原数(面板"节约 700 tokens"类小值不受影响)。
  const mil = v / 1e6;
  const text = mil.toFixed(2).replace(/\.?0+$/, '');
  return `${text} 百万`;
}

/** 读嵌入进度(2026-11-14 用户定案:状态句给具体进度,不再只说"建立中"):
 *  尾读 embed.log 最后一条 [progress] 嵌入 X/Y(spawnLogged 双流落盘,稳定存在)。
 *  返回 {done,total,pct} 或 null(无日志/无进度行)。纯读,64KB 尾窗防大文件。 */
export function readEmbedProgress(logFile = path.join(DATA_DIR, 'embed.log')) {
  try {
    const st = fs.statSync(logFile);
    const start = Math.max(0, st.size - 64 * 1024);
    const tail = fs.readFileSync(logFile, { encoding: 'utf8', start, end: st.size });
    const hits = tail.match(/\[progress\] 嵌入 (\d+)\/(\d+)/g);
    if (!hits || !hits.length) return null;
    const m = hits[hits.length - 1].match(/(\d+)\/(\d+)/);
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (!(total > 0)) return null;
    return { done, total, pct: Math.min(100, Math.round((done / total) * 100)) };
  } catch { return null; }
}

function likelyReason(p, emb, rr) {
  const embedProgress = () => {
    const g = readEmbedProgress();
    return g ? `向量索引嵌入中 ${g.done}/${g.total}(${g.pct}%)` : '向量索引正在建立';
  };
  if (p.modelIn === 'local') {
    if (p.embedPid && !p.indexOk) return embedProgress();
    if (!p.chunks) return '代码块清单未建立';
    if (p.indexError) return 'index.json 无法解析';
    if (!p.indexOk) return 'local 向量索引未建立,检索降级 bm25';
    if (p.backend !== 'local' || p.indexModel !== p.models.localEmbedding) return `索引仍是 ${p.indexModel || p.backend || '旧路径'},尚未切换到 local`;
    // 签名过期 ≠ 检索失败(2026-11-11):快照自洽时 search 用嵌入快照继续向量检索;
    // 只有快照也坏了(向量与块清单错位且无法切快照)才是真降级。嵌入进行中同理(部分快照自洽可用)。
    if (p.signatureStale && p.snapshotOk === false) return '向量与嵌入快照不一致,检索已降级 bm25';
    if (!p.localEmbeddingReady) return `嵌入模型 ${p.models.localEmbedding} 的权重不在 hf-cache`;
    if (!p.localRerankerReady) return `精排模型 ${p.models.localReranker} 的权重不在 hf-cache`;
    if (!p.residentReady) return 'local 常驻进程未拉起';
    if (p.decisionWanted === true && p.decisionOk !== true) return `决策模型 ${p.models.localDecision} 拉起失败(判定弃权 fail-open)`;
    return 'local 嵌入模型未就绪';
  }
  if (p.ollama === 'down') return 'Ollama 未启动';
  if (p.ollama === 'process-only') return `Ollama 没有在 ${p.base} 响应`;
  if (p.embedPid && !p.indexOk) return embedProgress();
  if (p.embedInstalled === null || p.rerankInstalled === null) return 'Ollama 未响应,无法确认模型是否已下载';
  if (p.embedInstalled === false) return `嵌入模型 ${emb} 未下载`;
  if (p.rerankInstalled === false) return `精排模型 ${rr} 未下载`;
  if (!p.chunks) return '代码块清单未建立';
  if (p.indexError) return 'index.json 无法解析';
  if (!p.indexOk) return '向量索引未建立';
  if (p.backend === 'local') return `当前索引是 ${p.indexModel},与配置的 ollama 嵌入路径不一致`;
  if (p.indexModel !== emb) return `索引模型 ${p.indexModel} 与配置的嵌入模型不一致`;
  if (p.signatureStale && p.snapshotOk === false) return '向量与嵌入快照不一致,检索已降级 bm25';
  if (p.psLoadingWindow) return '模型冷加载中(探针让行,稍后自动确认)'; // 2026-11-25:比"无法确认"可读,更不误读成掉线
  if (p.embedRunning == null || p.rerankRunning == null) return '无法确认模型是否已拉起';
  if (!p.embedRunning && !p.rerankRunning) return `嵌入模型 ${emb} 与精排模型 ${rr} 都未拉起`;
  if (!p.embedRunning) return `嵌入模型 ${emb} 未拉起`;
  if (!p.rerankRunning) return `精排模型 ${rr} 未拉起`;
  if (p.decisionWanted === true) {
    if (p.decisionInstalled !== true) return `决策模型 ${p.models.decision} 未下载`;
    if (p.decisionRunning !== true) return `决策模型 ${p.models.decision} 未拉起`;
  }
  return '模型未就绪';
}

function installedSet(tags) {
  const set = new Set();
  for (const m of tags?.models || []) {
    if (m?.name) set.add(m.name);
    if (m?.model) set.add(m.model);
  }
  return set;
}

/** 全名命中,或双方只差未写标签 / :latest。别的标签不算同一个模型。 */
function modelListed(set, wanted) {
  if (set.has(wanted)) return true;
  const colon = wanted.lastIndexOf(':');
  const bare = colon > 0 ? wanted.slice(0, colon) : wanted;
  return set.has(bare) || set.has(`${bare}:latest`);
}

/** /api/tags 或 /api/ps 的模型列表里是否有 wanted(含未写标签与 :latest)。 */
export function ollamaHasModel(tags, wanted) {
  return modelListed(installedSet(tags), wanted);
}

/** 对外只留一句:句首【当前远程模型名】、是否启动成功、两个模型名、失败原因或今日/总计两个 tokens 数。 */
export function renderModelStatus(p) {
  const wantLocal = p.modelIn === 'local';
  const emb = wantLocal ? p.models.localEmbedding : p.models.embedding;
  const rr = wantLocal ? p.models.localReranker : p.models.reranker;
  // 决策模型显示名(2026-11-08):显式远程时显示远程配置的模型名并标注(远程),否则显示模型 id
  const decId = wantLocal ? p.models.localDecision : p.models.decision;
  const dec = String(p.decisionModelLabel || '').trim() || decId;
  const names = `嵌入模型 ${emb},精排模型 ${rr},决策模型:${dec || '未配置'}`;
  // 过期/嵌入中不判失败(2026-11-11):快照自洽时检索照常工作,只有快照损坏(snapshotOk=false)才算降级
  const healthy = wantLocal
    ? (p.chunks && p.indexOk && p.backend === 'local' && p.indexModel === p.models.localEmbedding && p.localEmbeddingReady && p.localRerankerReady && p.residentReady && p.snapshotOk !== false && !p.indexError
      && (p.decisionWanted !== true || p.decisionOk === true))
    : (p.ollama === 'up'
      && p.embedInstalled === true
      && p.rerankInstalled === true
      && p.chunks && p.indexOk
      && p.backend !== 'local'
      && p.indexModel === emb
      && p.snapshotOk !== false
      && p.embedRunning === true
      && p.rerankRunning === true
      && (p.decisionWanted !== true || (p.decisionInstalled === true && p.decisionRunning === true))
      && !p.indexError);
  // 节约数字:今日/总计两段(2026-11-04 用户定稿:"本会话累计"段撤下,句首加【当前远程模型】)。
  const today = Math.max(0, Math.round(Number(p.savedTokens) || 0));
  const total = Number.isFinite(p.totalAllDays) ? Math.max(0, Math.round(p.totalAllDays)) : today;
  // 【】段相位标注(2026-11-20 用户定案):UserPromptSubmit/会话开始注入=【上轮:…】(本轮请求
  // 尚未发出,取最近完成轮);轮内工具后注入=【本轮:…】(本轮实际路由到的真实模型);
  // 无相位(CLI 直跑/旧断言)保持裸名,向后兼容。
  const phasePre = p.remoteModelPhase === 'prev' ? '上轮:' : p.remoteModelPhase === 'curr' ? '本轮:' : '';
  const modelTag = p.remoteModel ? `【${phasePre}${p.remoteModel}】` : '';
  // 嵌入进行中 → 两种形态的句尾都带具体进度(2026-11-14 用户定案:不再只说"建立中")
  const progClause = p.embedPid && !p.indexOk
    ? (() => { const g = readEmbedProgress(); return g ? `;向量索引嵌入中 ${g.done}/${g.total}(${g.pct}%)` : ''; })()
    : '';
  const relay = healthy
    ? `⚙ ${modelTag}本地模型已启动成功，今日累计节约 ${formatTokenCount(today)} tokens，总计节约 ${formatTokenCount(total)} tokens(${names})${progClause}`
    : `⚙ ${modelTag}本地模型未启动成功,最可能原因:${likelyReason(p, emb, rr)};今日累计节约 ${formatTokenCount(today)} tokens，总计节约 ${formatTokenCount(total)} tokens(${names})${progClause}`;
  return { relay, detail: relay, healthy };
}

export async function assessModelStatus({ sessionId = null, phase = null } = {}) {
  const cfg = loadConfig();
  const models = cfg.models;
  // 自愈补拉节流(2026-11-14 用户定案:用户级可配;2026-11-16 默认回退改 60000 与 config.mjs 同步双点):最小 1000ms 防 0/负值风暴
  const warmMinIntervalMs = Math.max(1000, Math.floor(Number(cfg.warmMinIntervalMs) || 60000));
  const modelIn = activeBackend();
  const base = resolveBase();
  let ollama = 'down';
  let embedInstalled = null;
  let rerankInstalled = null;
  let embedRunning = null;
  let rerankRunning = null;
  let decisionInstalled = null;
  let decisionRunning = null;
  let decisionOk = null;
  let residentReady = false;
  let psLoadingWindow = false; // 2026-11-25:ollama 分支置位(探针撞冷加载窗口);local 分支恒 false
  if (modelIn === 'local') {
    const health = await residentHealth();
    residentReady = !!(health?.embedOk && health?.rerankOk);
    decisionOk = decisionLocalWanted() ? (health?.decisionOk === true) : null;
    // local 常驻自愈(2026-11-03):常驻进程 2h 空闲自退或崩溃后,原设计靠下次检索懒拉起(冷启动数秒);
    // 这里借每轮健康评估判定,缺位即 detached 后台跑 warm.mjs(其 local 分支=ensureLocalResident);fail-open。
    // 2026-11-08:decisionOk 并入判定——嵌入/精排就绪但决策模型未拉起时周期补预热;
    // decisionWanted=false(开关关/显式远程)时不传决策字段 → 决策闸整体失效,不因"预期无决策"反复补拉。
    const decisionWanted = decisionLocalWanted();
    try { maybeWarmReranker({ health: { modelIn, embedOk: health?.embedOk === true, rerankOk: health?.rerankOk === true, decisionWanted, decisionOk: decisionWanted ? (health?.decisionOk == null ? undefined : health.decisionOk === true) : undefined, localDecisionReady: decisionWanted ? localOnnxCached(models.localDecision) : undefined }, minIntervalMs: warmMinIntervalMs }); } catch { /* 拉起失败不影响状态句 */ }
  } else {
    // 2026-11-25 修复(加载窗口容错):/api/ps 2s 竞速探针在模型冷加载窗口会被 sched 锁阻塞必超时,
    // 旧代码把 psRes.ok=false 直接跳过自愈两闸 → 下轮重试撞同一窗口;且 tags/version 活着=服务在,
    // 加载窗口里"ps 拿不到"不等于"模型掉了"。改为:tags 活着而 ps 超时 → 视为 loading(不算 down),
    // 跳过本轮 warm 补拉与 heal(加载窗口判定已把 heal 挡住,双保险),状态句 embedRunning/rerankRunning
    // 维持上次缓存(读取方已按可得字段降级),不误报"未拉起"。
    const [tagsRes, versionUp, psRes] = await Promise.all([
      getJson(`${base}/api/tags`, 2000).then(j => ({ ok: true, j })).catch(() => ({ ok: false })),
      getJson(`${base}/api/version`, 2000).then(() => true).catch(() => false),
      getJson(`${base}/api/ps`, 2000).then(j => ({ ok: true, j })).catch(() => ({ ok: false })),
    ]);
    if (tagsRes.ok || versionUp) ollama = 'up';
    else if (ollamaProcessesRunning()) ollama = 'process-only';
    const psLoading = (tagsRes.ok || versionUp) && !psRes.ok; // 服务活而 ps 探针超时=极可能正冷加载
    psLoadingWindow = psLoading;
    if (tagsRes.ok) {
      const names = installedSet(tagsRes.j);
      embedInstalled = modelListed(names, models.embedding);
      rerankInstalled = modelListed(names, models.reranker);
      if (decisionLocalWanted()) decisionInstalled = modelListed(names, models.decision);
      else decisionInstalled = null;
    }
    if (psRes.ok) {
      const running = installedSet(psRes.j);
      embedRunning = modelListed(running, models.embedding);
      rerankRunning = modelListed(running, models.reranker);
      decisionRunning = decisionLocalWanted() ? modelListed(running, models.decision) : null;
      // 精排自愈(2026-11-03):精排只有会话启动预热与显式 --rerank 两个加载点,会话中段被驱逐
      // (显存挤占/服务重启/keep_alive 到期)后无人再拉——嵌入有检索持续保活而精排没有。
      // 这里借每轮健康评估(缓存 5 分钟)轻量判定,缺位即 detached 后台补预热(warm.mjs 幂等,双模型对齐);fail-open。
      // 2026-11-08:决策模型(tev1)同轨并入——已下载未驻留时同样补预热;显式远程/开关关时不带决策字段,不加决策闸。
      try { maybeWarmReranker({ health: decisionLocalWanted() ? { modelIn, ollama, rerankInstalled, rerankRunning, decisionInstalled, decisionRunning } : { modelIn, ollama, rerankInstalled, rerankRunning }, minIntervalMs: warmMinIntervalMs }); } catch { /* 拉起失败不影响状态句 */ }
      // Ollama runner 异常自愈(2026-11-17 用户定案,默认开):llm server error 连判两轮 + 过冷却 ⇒ 重启 serve 回拉
      try { ollamaRunnerSelfHeal({ running, models, decisionWanted: decisionLocalWanted() }); } catch { /* 自愈失败不影响状态句 */ }
    } else if (psLoadingWindow) {
      // 加载窗口:本轮不补拉不 heal(加载完成前补拉只会再撞窗口);embedRunning 等维持 null=未知,
      // 状态句读方已按"无法确认"降级,不会误报未拉起
    }
  }

  const meta = readVectorMeta(modelIn);
  let indexError = null;
  if (fileReady(IDX_PATH)) {
    try { JSON.parse(fs.readFileSync(IDX_PATH, 'utf8')); }
    catch (e) { indexError = e.message; }
  }
  const embeddings = fileReady(vectorPaths(modelIn).emb);
  const health = {
    ollama,
    base,
    embedInstalled,
    rerankInstalled,
    embedRunning,
    rerankRunning,
    chunks: fileReady(CHUNKS_PATH),
    indexOk: !!(embeddings && meta?.model) && !indexError,
    indexError,
    indexModel: meta?.model || null,
    backend: meta?.backend || null,
    signatureStale: vectorSignatureStale(meta),
    snapshotOk: pairedSnapshotUsable(modelIn),
    residentReady,
    embedPid: readEmbedPid(),
    models,
    modelIn,
    localEmbeddingReady: localOnnxCached(models.localEmbedding),
    localRerankerReady: localOnnxCached(models.localReranker),
    decisionWanted: decisionLocalWanted(),
    decisionOk,
    decisionInstalled,
    decisionRunning,
    decisionModelLabel: null, // v4:远程链已删,恒 null(状态句决策模型名走本地后端名)
    psLoadingWindow, // 2026-11-25:探针撞冷加载窗口(sched 锁阻塞)——状态句说"加载中"而非"无法确认/未拉起"
  };
  writeHealthCache(health);
  return renderStatusWith(health, sessionId, { phase });
}

/** 健康缓存(避免每轮探针的 HTTP 开销);只缓存健康字段,节约数字永远现算。 */
const HEALTH_CACHE_PATH = path.join(DATA_DIR, 'model-health-cache.json');
function readHealthCache() {
  try {
    const j = JSON.parse(fs.readFileSync(HEALTH_CACHE_PATH, 'utf8'));
    if (j && j.at && j.health) return j;
  } catch { /* 无缓存 */ }
  return null;
}
function writeHealthCache(health) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicWriteFileSync(HEALTH_CACHE_PATH, JSON.stringify({ at: Date.now(), health })); // 原子写(2026-11-10 二次审计 P1-3)
  } catch { /* 缓存失败不影响 */ }
}

/**
 * 展示层:健康字段 + 现算的节约数字(当日桶+总计)+ 当前远程模型(句首【】段,按会话查)。
 * sessionId 省略时不带【模型】段。
 */
export function renderStatusWith(health, sessionId = null, { phase = null } = {}) {
  try { applySessionAccumulation(); } catch { /* 入账失败按入口一次口径 */ }
  const savings = readSavingsState();
  const totalAllDays = Object.values(savings.days || {}).reduce((s, d) => s + (Math.max(0, Math.round(Number(d?.savedTokens) || 0)) || 0), 0);
  let remoteModel = null;
  try { remoteModel = sessionId ? currentRemoteModel(sessionId) : null; } catch { /* 查不到省略【】段 */ }
  return renderModelStatus({ ...health, ...savings, totalAllDays, remoteModel, remoteModelPhase: phase });
}

/** 每轮实时状态句:健康走缓存(健康快照 TTL 5 分钟;**未健康快照 30s**——2026-11-14 用户定案 B:
 *  自愈补拉/预热完成后,状态句最多 30s 内翻正,不再吃最长 5 分钟的陈旧"未拉起"),节约现算。供 UserPromptSubmit 注入。 */
// ---------- 精排自愈(2026-11-03):缺位即后台补预热 ----------

/** 健康快照的"健康"判定(B 的 TTL 分档依据,纯函数)。对齐 renderModelStatus 的拉起三件套:
 *  ollama=up ∧ 嵌入/精排已驻留 ∧(带决策字段时)决策已驻留;local=常驻就绪 ∧ 双模型未缺席。 */
export function healthIsHealthy(h) {
  if (!h || typeof h !== 'object') return false;
  if (h.modelIn === 'local') {
    return h.residentReady === true && h.embedRunning !== false && h.rerankRunning !== false;
  }
  return h.ollama === 'up'
    && h.embedRunning === true
    && h.rerankRunning === true
    && (h.decisionRunning == null || h.decisionRunning === true);
}

/** 预热补拉判定(纯函数,测试密闭)。ollama:网关可达 ∧ 模型已下载 ∧ 未驻留;local:常驻缺位/未就绪。
 * 决策模型(2026-11-08)并入同一自愈判定:仅当健康数据带 decision 字段时才加闸(旧状态/测试夹具缺字段走原逻辑)。距上次拉起 ≥ minInterval 才补。 */
export function rerankerWarmDue(health, lastAt, now = Date.now(), minIntervalMs = 10 * 60 * 1000) {
  if (!health || typeof health !== 'object') return { due: false, reason: '无健康数据' };
  if (health.modelIn === 'local') {
    // local 常驻进程 2h 空闲自退/崩溃后,原设计靠下次检索懒拉起(冷启动数秒)——这里主动补,免掉那笔冷启动
    if (health.embedOk === true && health.rerankOk === true) {
      // 决策模型闸只在 decisionWanted=true(本地判定通电)时生效;开关关/显式远程 = 决策缺席属预期,不补
      if (health.decisionWanted === true) {
        if (health.decisionOk !== false) return { due: false, reason: '常驻双模型就绪' };
        if (health.localDecisionReady !== true) return { due: false, reason: '决策模型权重未下载,不重复补拉' };
        if (Number(lastAt) <= now && Number(lastAt) > now - minIntervalMs) return { due: false, reason: '节流窗口内' }; // 负龄(时钟回拨)放行补拉自愈(2026-11-10 夜审 S5-F3)
        return { due: true, reason: '常驻决策模型未就绪,补预热' };
      }
      return { due: false, reason: '常驻双模型就绪' };
    }
    // 常驻缺位(嵌入/精排没起来)= 检索直接降级 bm25 的空窗,补拉节流放宽到 60s(warm 幂等且起得快,
    // 原 10 分钟节流会让缺位状态挂整整一轮节流窗,2026-11-08 修);决策类补拉(要重启常驻)仍用原节流
    if (Number(lastAt) <= now && Number(lastAt) > now - Math.min(minIntervalMs, 60000)) return { due: false, reason: '节流窗口内' }; // 负龄放行(2026-11-10 夜审 S5-F3)
    return { due: true, reason: '常驻缺位/未就绪,补预热' };
  }
  if (health.modelIn !== 'ollama') return { due: false, reason: '非 ollama 模式' };
  if (health.ollama !== 'up') return { due: false, reason: 'ollama 不可达' };
  const hasDecision = Object.prototype.hasOwnProperty.call(health, 'decisionInstalled');
  const decisionNeeded = hasDecision && health.decisionInstalled === true && health.decisionRunning !== true;
  if (health.decisionInstalled === false) return { due: false, reason: '决策模型未下载,不补(避免无效拉起)' };
  if (health.rerankInstalled !== true && !decisionNeeded) return { due: false, reason: '精排模型未下载' };
  if (health.rerankRunning === true && !decisionNeeded) return { due: false, reason: '精排已驻留' };
  if (Number(lastAt) <= now && Number(lastAt) > now - minIntervalMs) return { due: false, reason: '节流窗口内' }; // 负龄放行(2026-11-10 夜审 S5-F3)
  return { due: true, reason: decisionNeeded ? '决策模型已下载未驻留,补预热' : '已下载未驻留,补预热' };
}

/**
 * 每轮轻量检查(assessModelStatus 的 ollama/local 分支调用):判定过了就 detached 后台跑 warm.mjs
 * (按 modelIn 自分支:ollama=双模型放置;local=ensureLocalResident 拉起常驻)。幂等。
 * 节流=状态文件 mtime(data/usage/rr-warm.last)+ 健康缓存 5 分钟双层。fail-open。
 */
export function maybeWarmReranker({ health = null, dataDir = DATA_DIR, now = Date.now(), minIntervalMs = 10 * 60 * 1000, spawnFn = null, warmPath = null } = {}) {
  try {
    const stateFile = path.join(dataDir, 'usage', 'rr-warm.last');
    let lastAt = 0;
    try { lastAt = fs.statSync(stateFile).mtimeMs; } catch { /* 无记录=从未拉起过 */ }
    const d = rerankerWarmDue(health, lastAt, now, minIntervalMs);
    if (!d.due) return { spawned: false, reason: d.reason };
    const here = warmPath || path.join(path.dirname(fileURLToPath(import.meta.url)), 'warm.mjs');
    const sp = spawnFn || spawn;
    const child = sp(process.execPath, [here], { cwd: path.dirname(here), stdio: 'ignore', detached: true, windowsHide: true });
    child.unref?.();
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, String(now)); fs.utimesSync(stateFile, new Date(now), new Date(now)); } catch { /* 节流记录失败只影响频控 */ }
    return { spawned: true, reason: d.reason };
  } catch { return { spawned: false, reason: '异常,fail-open' }; }
}

export async function assessModelStatusCached(sessionId = null, { healthMaxAgeMs = 300000, phase = null } = {}) {
  const cached = readHealthCache();
  // 模型后端缺位时不吃缓存:每轮现算(本地=轻量常驻 /health 探测),让自愈补拉与状态句即时反映,不留空窗(2026-11-08 修)
  const backendDown = cached?.health && (cached.health.modelIn === 'local'
    ? cached.health.residentReady !== true
    : cached.health.ollama !== 'up');
  // B(2026-11-14 用户定案):未健康快照的 TTL 压到 30s——自愈/预热把模型拉回后,状态句
  // 最多 30s 内翻正;健康快照维持原 5 分钟(省每轮探针)。
  const maxAge = healthIsHealthy(cached?.health) ? healthMaxAgeMs : Math.min(healthMaxAgeMs, 30000);
  if (cached && Date.now() - cached.at < maxAge && !backendDown) {
    return renderStatusWith(cached.health, sessionId, { phase });
  }
  return assessModelStatus({ sessionId, phase });
}

// ---------- Ollama runner 异常自愈(2026-11-17 用户定案,默认开) ----------

/** 解析 server.log 行首时间戳(本地时区数构)为毫秒;缺时间戳返回 null。 */
export function ollamaLogTs(line) {
  const m = String(line || '').match(/^time=(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

/** 近 windowMs 内 "llm server error" 行数(无时间戳的 error 行保守计 1)。
 *  2026-11-25 修复:紧邻行是「client connection closed / Load failed … context canceled」的 error
 *  不计数——那是调用方短超时主动断开造成的加载中止(自愈探针自己也会造这种),不是 runner 故障,
 *  误计会让 heal 在冷加载窗口把整只 Ollama 杀掉重启(自咬循环,实测 2026-11-25 日志 2392 条 error
 *  绝大多数属此类)。纯函数供单测。 */
export function ollamaLogErrCount(text, now = Date.now(), windowMs = 5 * 60 * 1000) {
  const lines = String(text || '').split(/\r?\n/);
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('llm server error')) continue;
    // 紧邻下文(≤2 行内)出现客户端断开特征 → 客户端中止,非 runner 故障,不计
    const follow = lines.slice(i + 1, i + 3).join('\n');
    if (/client connection closed|Load failed.*context canceled/.test(follow)) continue;
    const ts = ollamaLogTs(lines[i]);
    if (ts == null || now - ts <= windowMs) n += 1;
  }
  return n;
}

/** 日志尾是否处于「模型加载窗口」(纯函数,供单测):近 loadWindowMs 内有 loading/waiting 起始行。
 *  加载窗口内 /api/ps 会被 sched 锁阻塞、短探针必超时,error 行多为加载等待——heal 此刻既不该判
 *  unhealthy 也不该 restart(2026-11-25 修复:冷加载窗口杀 Ollama=自咬循环的放大器)。 */
export function ollamaLoadingWindow(logText, now = Date.now(), windowMs = 90 * 1000) {
  const lines = String(logText || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && (now - (ollamaLogTs(lines[i]) ?? now)) <= windowMs; i--) {
    if (/loading model via llama-server|starting llama-server|waiting for llama-server/.test(lines[i])) return true;
  }
  return false;
}

/** runner 异常判定(纯函数):有期望模型缺驻留 且 日志近期 err ≥ minErr。
 *  2026-11-25 修复:加载窗口内一律不判 unhealthy(缺驻留=正在加载,不是掉了)。 */
export function ollamaRunnerUnhealthy({ missingModels = [], logText = '', now = Date.now(), errWindowMs = 5 * 60 * 1000, minErr = 2 } = {}) {
  if (!missingModels.length) return { unhealthy: false, reason: '驻留齐全', errCount: 0, missing: [] };
  if (ollamaLoadingWindow(logText, now)) return { unhealthy: false, reason: '加载窗口(冷加载中不判异常)', errCount: 0, missing: missingModels };
  const errCount = ollamaLogErrCount(logText, now, errWindowMs);
  const unhealthy = errCount >= minErr;
  return { unhealthy, errCount, missing: missingModels, reason: unhealthy ? `runner 异常(近期 llm server error ×${errCount})` : '仅空闲卸载(无 runner 异常)' };
}

/** 重启决策(纯函数):连判 ≥2 且过冷却(冷却后连判计数清零)。 */
export function decideOllamaRestart({ unhealthy, streak = 0, lastRestartAt = 0, now = Date.now(), cooldownMs = 30 * 60 * 1000, auto = true } = {}) {
  if (!auto) return { restart: false, streak: 0, reason: '自动重启已关(仅检测留痕)' };
  if (!unhealthy) return { restart: false, streak: 0, reason: '健康' };
  const next = streak + 1;
  if (next < 2) return { restart: false, streak: next, reason: '连判 1/2' };
  if (lastRestartAt && now - lastRestartAt < cooldownMs) return { restart: false, streak: 0, reason: '冷却中' };
  return { restart: true, streak: 0, reason: '连判≥2 且过冷却' };
}

// S14-F3(20261118):dataDir 可注入(默认 DATA_DIR)——自愈回归测试必须密闭,不写真实 data。
const ollamaHealthStatePath = (dataDir = DATA_DIR) => path.join(dataDir, 'routing', 'ollama-health.json');
const ollamaRestartLogPath = (dataDir = DATA_DIR) => path.join(dataDir, 'routing', 'ollama-restart.log');

function readOllamaHealthState(dataDir = DATA_DIR) {
  try { const j = JSON.parse(fs.readFileSync(ollamaHealthStatePath(dataDir), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
function writeOllamaHealthState(s, dataDir = DATA_DIR) {
  try { fs.mkdirSync(path.dirname(ollamaHealthStatePath(dataDir)), { recursive: true }); atomicWriteFileSync(ollamaHealthStatePath(dataDir), JSON.stringify(s)); } catch { /* 状态写失败不影响 */ }
}
function logOllamaRestart(rec, dataDir = DATA_DIR) {
  try { fs.mkdirSync(path.dirname(ollamaRestartLogPath(dataDir)), { recursive: true }); fs.appendFileSync(ollamaRestartLogPath(dataDir), JSON.stringify(rec) + '\n'); } catch { /* 留痕失败不影响 */ }
}

/** Ollama server.log 路径(Windows: %LOCALAPPDATA%\Ollama\server.log;非 win 走 ~/.ollama/logs)。 */
export function ollamaServerLogPath(home = os.homedir(), env = process.env) {
  if (process.platform !== 'win32') return path.join(home, '.ollama', 'logs', 'server.log');
  return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Ollama', 'server.log');
}

/** 定长尾读(S3-F3/S14-F2 20261118 P2):readFileSync 无 {start,end} 选项语义——此前生产行静默忽略
 *  坐标参数整读 server.log(MB/GB 级,每轮健康评估一次)。openSync+readSync 只取末 maxBytes;
 *  文件缺失/读失败返回 ''(调用方按"无 runner 异常证据"处理)。 */
export function readFileTail(lp, maxBytes = 64 * 1024) {
  try {
    const st = fs.statSync(lp);
    const from = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(lp, 'r');
    try {
      const len = st.size - from;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, from);
      return buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/** 触发重启:Windows 下 taskkill serve(托盘自动拉回,2026-11-17 实测路径);随后 detached warm 回拉。 */
export function restartOllamaNow({ now = Date.now(), spawnFn = null, taskkillFn = null, dataDir = DATA_DIR } = {}) {
  if (process.platform !== 'win32') return { restarted: false, reason: '非 Windows,跳过(交系统服务管理)' };
  try {
    const r = taskkillFn ? taskkillFn() : spawnSync('taskkill', ['//F', '//IM', 'ollama.exe'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    logOllamaRestart({ at: now, status: r?.status === 0 || r?.status == null ? 'killed' : `taskkill rc=${r?.status}`, note: 'ollama runner 异常自愈(默认开)' }, dataDir);
    writeOllamaHealthState({ unhealthyStreak: 0, lastRestartAt: now }, dataDir);
    console.error('[ollama-heal] 已重启 ollama serve(托盘自动拉回),随后后台回拉模型');
    const warmPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'warm.mjs');
    try {
      const sp = spawnFn || spawn;
      const child = sp(process.execPath, [warmPath], { cwd: path.dirname(warmPath), stdio: 'ignore', detached: true, windowsHide: true });
      child.unref?.();
    } catch { /* warm 回拉失败下轮再自愈 */ }
    return { restarted: true };
  } catch (e) { return { restarted: false, reason: `异常:${e && e.message}` }; }
}

/** 每轮健康评估触发(ollama=up 分支):读状态→检测→决策→执行。注入 spawnFn/taskkillFn 供测试密闭。 */
export function ollamaRunnerSelfHeal({ running, models, decisionWanted, now = Date.now(), spawnFn = null, taskkillFn = null, dataDir = DATA_DIR } = {}) {
  const c = loadConfig();
  if (c.ollamaAutoRestart === false) return { action: 'off' };
  const want = decisionWanted ? [models.embedding, models.reranker, models.decision] : [models.embedding, models.reranker];
  const missing = want.filter((m) => !modelListed(running, m));
  let logText = '';
  try {
    const lp = ollamaServerLogPath();
    logText = readFileTail(lp, 64 * 1024); // S3-F3/S14-F2(20261118):定长尾读替代 readFileSync{start,end} 静默整读
  } catch { /* 无日志=无 runner 异常证据 */ }
  const probe = ollamaRunnerUnhealthy({ missingModels: missing, logText, now, errWindowMs: 5 * 60 * 1000 });
  // S14-F3(20261118):读-判-写原为无锁 RMW——两路并发(代理自愈 + 托盘轮询)可各读到旧 streak,
  // 双双判 restart → 双重 taskkill 生产 ollama + 双预热。改为持锁(锁语义:wx 优先 + 陈旧接管 + 所有权释放)。
  const lockPath = `${ollamaHealthStatePath(dataDir)}.lock`;
  if (!takeJsonLock(lockPath)) return { action: 'locked', reason: '并发自愈进行中,本次跳过', ...probe };
  try {
    const prev = readOllamaHealthState(dataDir);
    const cooldown = Math.max(1000, Math.floor(Number(c.ollamaRestartCooldownMs) || 30 * 60 * 1000));
    const dec = decideOllamaRestart({ unhealthy: probe.unhealthy, streak: Number(prev.unhealthyStreak) || 0, lastRestartAt: Number(prev.lastRestartAt) || 0, now, cooldownMs: cooldown });
    if (dec.restart) { restartOllamaNow({ now, spawnFn, taskkillFn, dataDir }); return { action: 'restarted', ...probe, decision: dec.reason }; }
    if (dec.streak !== (Number(prev.unhealthyStreak) || 0)) writeOllamaHealthState({ unhealthyStreak: dec.streak, lastRestartAt: Number(prev.lastRestartAt) || 0 }, dataDir);
    if (probe.unhealthy) console.error(`[ollama-heal] runner 异常候选(缺 ${probe.missing.join(',')};${dec.reason})`);
    return { action: 'probe', ...probe, decision: dec.reason };
  } finally { releaseJsonLock(lockPath, process.pid); }
}
