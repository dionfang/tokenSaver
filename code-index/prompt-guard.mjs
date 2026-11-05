/**
 * 每条用户消息触发一次。钩子进程立刻退出,签名检查放到分离的 --check。
 * 整文件 md5 要数秒,Cursor beforeSubmitPrompt 超时 10s,算完再拉起 auto 会被杀掉。
 *   向量与块清单一致 → --check 静默退出
 *   不一致且无嵌入进程 → 分离后台拉起 auto.mjs
 * 语义预取(UserPromptSubmit):用 bm25 快路径对用户原话查索引,把 top 命中作为
 * additionalContext 注入,让 agent 第一步就带着 file:行号开工。只走 bm25(无模型、
 * 零联网、~百毫秒),且不写 session-savings(预取不是 agent 主动检索,避免记账重复)。
 * Cursor beforeSubmitPrompt 复用本脚本,其转发器只回 continue,不受输出变化影响。
 *
 * 宿主门控(2026-11-01 用户决策):**动态模型路由只支持 ZCode**——路由分类注入、routing-log
 * 与代理保活仅在 --host zcode 时执行;Cursor/Qoder 仍做预取/意图/状态句(这些是 TokenSaver 本体
 * 功能,与路由无关)。宿主身份由 init 生成的钩子显式传入(--host),直呼(测试/手动)默认 zcode。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR } from './config.mjs';
import { classifyPrompt, routingEnabled, routingContextLine, logRouting } from './classify.mjs';
import { classifyDifficulty, loadTierCalibration } from './tierClassify.mjs';
import { vectorStoreNeedsEmbed, wantEmbedModel } from './vectorStore.mjs';
import { pidAlive, spawnLogged, LOCK_TTL_MS } from './proc.mjs';
import { embedIntent } from './rangePick.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);
const autoAbs = path.resolve(here, 'auto.mjs');

/** 宿主身份:--host 参数优先,其次 CODE_INDEX_HOST 环境变量,直呼默认 zcode(保持既有行为)。 */
export function hostFromArgv(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--host');
  if (i >= 0 && typeof argv[i + 1] === 'string' && argv[i + 1].trim()) return argv[i + 1].trim().toLowerCase();
  const env = String(process.env.CODE_INDEX_HOST || '').trim().toLowerCase();
  return env || 'zcode';
}

/**
 * 生效的路由宿主范围(2026-11-03 用户终裁:hosts 配置项已废,**恒按用户级目录自动检测**):
 * 用户级配置存在(~/.zcode/cli/config.json / ~/.qoder-cn|~/.qoder/settings.json)即纳入该宿主;
 * 检测不到 = 该机没部署对应宿主(路由面不含它),重新部署 init 即恢复——不再有显式清单,也不兜底。
 * cfg 参数保留以兼容调用方签名,已不消费。
 */
export function routingHostsOf(cfg, { home = os.homedir(), exists = fs.existsSync } = {}) {
  const detected = [];
  if (exists(path.join(home, '.zcode', 'cli', 'config.json'))) detected.push('zcode');
  if (exists(path.join(home, '.qoder-cn', 'settings.json')) || exists(path.join(home, '.qoder', 'settings.json'))) detected.push('qoder');
  return detected;
}

/** 该宿主是否在生效范围内。 */
export function routingHostEnabled(host, cfg, opts) {
  return routingHostsOf(cfg, opts).includes(String(host || '').trim().toLowerCase());
}

/** 路由运行时开关:宿主在生效范围 ∧ 配置 enabled。 */
export function shouldRunRouting(host, cfg, opts) {
  return routingHostEnabled(host, cfg, opts) && routingEnabled(cfg);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

// ---------- 预取(bm25 快路径,与 search.mjs 同词法,不碰记账) ----------

/** 从载荷里取用户原话;键名各宿主不一,宽候选。 */
export function extractPrompt(payload) {
  const p = payload || {};
  for (const k of ['prompt', 'user_prompt', 'prompt_text', 'userPrompt', 'input', 'text', 'message']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 与 search.mjs 同口径:标识符拆分 + CJK 二元组。 */
export function tokenizeQuery(text) {
  const tokens = [];
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*|\d+/g)) {
    const w = m[0];
    tokens.push(w.toLowerCase());
    for (const part of w.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_\-\s]+/)) {
      if (part && part !== w) tokens.push(part.toLowerCase());
    }
  }
  for (const m of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) tokens.push(run);
    else for (let i = 0; i < run.length - 1; i++) tokens.push(run[i] + run[i + 1]);
  }
  return tokens;
}

function chunkBody(t) {
  const nl = String(t || '').indexOf('\n');
  return nl >= 0 ? t.slice(nl + 1) : String(t || '');
}

/** bm25 打分取 top-k。chunks: [{t}]。纯函数,便于测试。 */
export function bm25Prefetch(chunks, query, k = 3) {
  const qTokens = [...new Set(tokenizeQuery(String(query || '').slice(0, 500)))];
  if (!qTokens.length || !Array.isArray(chunks) || !chunks.length) return [];
  const docTokens = chunks.map(c => tokenizeQuery(chunkBody(c.t)));
  const N = docTokens.length || 1;
  const avgdl = docTokens.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docTokens) {
    for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  }
  const scores = [];
  for (let i = 0; i < N; i++) {
    const tf = new Map();
    for (const t of docTokens[i]) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const qt of qTokens) {
      const f = tf.get(qt);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(qt) || 0) + 0.5) / ((df.get(qt) || 0) + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + docTokens[i].length / avgdl));
    }
    if (score > 0) scores.push([i, score]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  return scores.slice(0, k).map(([i]) => chunks[i]);
}

export function formatHits(chunks) {
  return chunks
    .filter(c => c && c.p)
    .map((c, n) => `${n + 1}. ${c.p}:${c.s}-${c.e}`)
    .join('\n');
}

/**
 * 块指向的文件是否已不存在。p 形如 "<根名>/<相对路径>"(build.mjs 用 path.basename(root) 做前缀)。
 * 索引新鲜度对未入版本控制的目录(如 data/ab)无感:文件删了 HEAD 不变,块会一直留着,
 * 注入出去就是一个打不开的路径。根名对不上或 roots 为空时按"存在"处理,不误杀。
 */
export function chunkFileMissing(c, roots, exists = (f) => fs.existsSync(f)) {
  const p = String(c && c.p ? c.p : '');
  const i = p.indexOf('/');
  if (i <= 0) return false;
  const head = p.slice(0, i).toLowerCase();
  const rest = p.slice(i + 1);
  for (const r of Array.isArray(roots) ? roots : []) {
    const rr = String(r || '').replace(/[\\/]+$/, '');
    if (!rr || path.basename(rr).toLowerCase() !== head) continue;
    return !exists(path.join(rr, rest));
  }
  return false;
}

/** 同文件命中并区间:重叠或间距 ≤ gap 行(默认对齐 chunk.overlapLines=10)的块并为一条,
 *  省去按区间读时的重复行与多余 Read;组间按组内最高分成员的原名次排。纯函数,便于测试。 */
export function mergeHitRanges(chunks, gap = 10) {
  const groups = [];
  (Array.isArray(chunks) ? chunks : []).forEach((c, i) => {
    if (!c || !c.p || !Number.isFinite(c.s) || !Number.isFinite(c.e)) return;
    const s = Math.min(c.s, c.e);
    const e = Math.max(c.s, c.e);
    const g = groups.find(x => x.p === c.p && s <= x.e + gap && x.s <= e + gap);
    if (g) {
      g.s = Math.min(g.s, s);
      g.e = Math.max(g.e, e);
      g.rank = Math.min(g.rank, i);
    } else {
      groups.push({ p: c.p, s, e, rank: i });
    }
  });
  return groups
    .sort((a, b) => a.rank - b.rank)
    .map(({ p, s, e }) => ({ p, s, e }));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 预取总入口:返回 additionalContext 文本;null = 本次不注入。statePath 可注入以便测试密闭。 */
export function prefetchContext(payload, { chunksPath = path.join(DATA_DIR, 'chunks.jsonl'), configPath = path.join(DATA_DIR, 'code-index.config.json'), statePath = path.join(DATA_DIR, '.prefetch-last.json') } = {}) {
  const cfg = readJson(configPath) || {};
  const pc = cfg.prefetch && typeof cfg.prefetch === 'object' ? cfg.prefetch : {};
  if (pc.enabled === false) return null;
  const k = Number.isFinite(Number(pc.k)) && Number(pc.k) > 0 ? Math.min(5, Number(pc.k)) : 3;
  const minChars = Number.isFinite(Number(pc.minChars)) && Number(pc.minChars) >= 0 ? Number(pc.minChars) : 12;
  const prompt = extractPrompt(payload);
  if (prompt.length < minChars) return null;
  // 相同原话 10 分钟内不重复注入
  const sha = crypto.createHash('sha1').update(prompt).digest('hex');
  const prev = readJson(statePath);
  if (prev && prev.sha === sha && Date.now() - prev.at < 10 * 60 * 1000) return null;
  if (!fs.existsSync(chunksPath)) return null;
  let chunks;
  try {
    chunks = fs.readFileSync(chunksPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return null; }
  // 多取候选再按存在性过滤:已删文件的块让位给次名,凑足 k 条
  const hits = bm25Prefetch(chunks, prompt, Math.min(k * 3, 12))
    .filter(c => !chunkFileMissing(c, cfg.roots))
    .slice(0, k);
  if (!hits.length) return null;
  try { fs.writeFileSync(statePath, JSON.stringify({ sha, at: Date.now() })); } catch { /* 记不上就不去重 */ }
  return `[code-index] 与提问相关的索引命中(直接按行号区间读,不必再检索):\n${formatHits(mergeHitRanges(hits))}`;
}

// ---------- 主流程 ----------

function embedRunning() {
  try {
    const { pid, ts } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.embed.pid'), 'utf8'));
    if (!pidAlive(pid)) return false;
    return Number.isFinite(ts) && Date.now() - ts < LOCK_TTL_MS;
  } catch { return false; }
}

/** 意图落盘:read-guard 的改写路径用它挑语义区间。best-effort,失败不注入也不报错。 */
async function storeIntentVector(payload) {
  try {
    const prompt = extractPrompt(payload);
    if (prompt.length < 12) return;
    const v = await embedIntent(prompt);
    if (!v) return;
    const sid = String(payload.sessionId || payload.session_id || payload.conversation_id || '_global').replace(/[^\w.-]/g, '_');
    const dest = path.join(DATA_DIR, 'read-guard', `${sid}.intent.json`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify({ v, text: prompt.slice(0, 1000), at: Date.now() }));
  } catch { /* 意图存不上不影响注入 */ }
}

/**
 * 每轮实时状态句:先增量扫一遍 Qoder 日志补上本轮新增的 iteration,再现算数字(健康走缓存),
 * 按会话 id 查最近服务的远程模型(句首【】段,2026-11-04 起"本会话累计"段撤下)。
 * 消除 SessionStart 快照导致的不刷新/拼接失真——模型只需原样搬运宿主刚生成的那句。
 */
async function liveStatusLine(payload) {
  try {
    const rawSid = String(payload.sessionId || payload.session_id || payload.conversation_id || '');
    const sid = rawSid.replace(/[^\w.-]/g, '_');
    try {
      const { scanQoderUsage } = await import('./agent-usage.mjs');
      scanQoderUsage({});
    } catch { /* 扫不动就按已有记录计,不拖注入 */ }
    const { assessModelStatusCached } = await import('./modelStatus.mjs');
    const { relay } = await assessModelStatusCached(sid || null);
    // 状态句落档(2026-11-04):轮内刷新/回合末结算用 prevTurnId 判定回合边界、拿前轮模型采样
    if (rawSid && relay) {
      try {
        const { recordAtPrompt } = await import('./turnStatus.mjs');
        recordAtPrompt({ sid: rawSid, relay });
      } catch { /* 落档失败不影响注入 */ }
    }
    return relay;
  } catch { return null; }
}

async function main() {
  const raw = await readStdin();
  // 签名检查分离后台拉起,不阻塞注入
  try {
    const child = spawn(process.execPath, [self, '--check'], {
      cwd: here,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch { /* 拉不起就不保鲜 */ }

  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* 坏载荷只跳过预取 */ }
  const host = hostFromArgv();
  const cfg = loadConfig();
  // 本地代理保活(ZCode/Qoder 路由宿主):选了虚拟档位 auto 的会话,请求必经 127.0.0.1:8117;
  // 代理没跑就直接 connection refused ⇒ 在请求发出之前把它拉起来(判据见 proxyKeepalive.mjs)。
  // fail-open:失败只留痕,不阻塞用户输入。
  if (routingHostEnabled(host, cfg)) {
    try {
      const { ensureProxyRunning, recordPayloadKeys } = await import('./proxyKeepalive.mjs');
      recordPayloadKeys(payload);
      const keep = await ensureProxyRunning({ payload });
      if (keep.state === 'started') {
        try {
          fs.mkdirSync(path.join(DATA_DIR, 'usage'), { recursive: true });
          fs.appendFileSync(path.join(DATA_DIR, 'usage', 'proxy-keepalive.jsonl'), JSON.stringify({ ts: Date.now(), state: keep.state, reason: keep.reason }) + '\n');
        } catch { /* 留痕失败不影响 */ }
      }
    } catch { /* 保活失败不影响注入 */ }
  }
  let ctx = null;
  try { ctx = prefetchContext(payload); } catch { /* 预取失败静默 */ }
  await storeIntentVector(payload);
  // L1 路由分类(model-routing.md #9 Step①):路由宿主(ZCode/Qoder 自动检测)+ modelRouting.enabled 门控;
  // 失败/关闭/非路由宿主都不影响预取注入
  let route = null;
  let diff = null;
  try {
    if (shouldRunRouting(host, cfg)) {
      const prompt = extractPrompt(payload);
      route = classifyPrompt(prompt);
      diff = classifyDifficulty(prompt, { calibration: loadTierCalibration() });
      logRouting({ dataDir: DATA_DIR, prompt, classification: route });
    }
  } catch { /* 分类失败不影响注入 */ }
  // 必须输出 {additionalContext} 对象;裸字符串宿主解析不出注入字段
  const parts = [];
  if (ctx) parts.push(ctx);
  // tierLive:role 模式已删(2026-11-03),代理恒为 tier 四档实弹——难度档真的驱动选模 → 注入行去 [影子] 标记
  const tierLive = true;
  const routeLine = route && routingContextLine(route, diff, { tierLive });
  if (routeLine) parts.push(routeLine);
  // 门控压缩建议(2026-11-05):代理门控拦截连击时注入一次(钩子回写 suggested ⇒ 同连击不重复);
  // 上下文压缩后连击从 1 重新计数,自然获得下一次注入资格
  const gateLine = gateNoticeLine();
  if (gateLine) parts.push(gateLine);
  // 每轮实时状态句(最新值,模型原样搬运;会话开始那句仅作首轮兜底);无 prompt 时不注入
  const statusLine = extractPrompt(payload) ? await liveStatusLine(payload) : null;
  if (statusLine) parts.push(`[code-index] 状态(本轮实时值,回复末尾原样附上):${statusLine}`);
  process.stdout.write(JSON.stringify(parts.length ? { additionalContext: parts.join('\n') } : {}) + '\n');
  process.exit(0);
}

/**
 * 门控压缩建议行(2026-11-05):读代理落盘的 data/usage/gate-notice.json——门控拦截连击中注入一次建议
 * (压缩上下文/新开会话),注入后回写 suggested=true 防刷屏;疲劳放行(released)或通知过期(30min)不注入。
 * fail-open:读不到/写不回都不影响主注入流。
 */
function gateNoticeLine() {
  try {
    const f = path.join(DATA_DIR, 'usage', 'gate-notice.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || j.released === true || j.suggested === true) return null;
    if (!(Number(j.count) >= 1)) return null;
    if (Date.now() - Number(j.at || 0) > 30 * 60 * 1000) return null; // 只对新鲜连击注入
    j.suggested = true;
    fs.writeFileSync(f, JSON.stringify(j));
    const estWan = Math.round(((Number(j.estLast) || Number(j.estFirst) || 0) / 10000) * 10) / 10;
    return `[model-routing] 升档已被切换税门控拦截 ${j.count} 次(上下文约 ${estWan} 万 tokens):建议压缩上下文(/compact)或新开会话后继续——压缩后即可正常升档;同会话连续拦截满 3 次将疲劳放行`;
  } catch { return null; }
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self);
if (directRun && !process.argv.includes('--check')) {
  main();
}

if (process.argv.includes('--check')) {
  // 结果形态驱动的规则自校准(2026-11-01):DB 比档案新、且距上次 ≥6h 才重建;
  // 只做两次 stat,失败静默,绝不阻塞钩子。
  try {
    const { maybeRecalibrate } = await import('./calibrateSignals.mjs');
    const r = maybeRecalibrate();
    if (r.state === 'built') {
      fs.appendFileSync(path.join(DATA_DIR, 'usage', 'calibration.log'), JSON.stringify({ ts: Date.now(), state: r.state, reason: r.reason, enabled: r.calib?.enabled === true }) + '\n');
    }
  } catch { /* 校准失败按原规则工作 */ }
  // 样本库自动增长(2026-11-02):routing-log 的真实 prompt → 对齐 db 取行为形态 → 并入样本库,
  // 变了才后台重建向量;并产出待签清单。默认 6h 一次,失败静默。
  try {
    const { maybeGrowPool } = await import('./autoExemplars.mjs');
    const grown = await maybeGrowPool();
    if (grown.state === 'grown') {
      // 待签清单已随四票自动代签废除(2026-11-02):此处不再产出 pending-review,只落运行留痕
      fs.appendFileSync(path.join(DATA_DIR, 'usage', 'autoexemplars.log'), JSON.stringify({ ts: Date.now(), ...grown }) + '\n');
    }
  } catch { /* 扩样失败不影响任何功能 */ }
  // 难度档迭代优化(2026-11-04):扩样之后跑一轮——学逐信号倍数 + 搜门槛小网格,折外代价过门控才落档案。
  // 需 modelRouting.tierOptimize.enabled 为真(默认关闭),档案落盘仍 enabled:false 不动现网;6h 节流,失败静默。
  try {
    const { maybeOptimizeTier } = await import('./tierOptimize.mjs');
    const opt = await maybeOptimizeTier();
    if (opt.state === 'done') {
      fs.appendFileSync(path.join(DATA_DIR, 'usage', 'tier-optimize.log'), JSON.stringify({ ts: Date.now(), ...opt.summary }) + '\n');
    }
  } catch { /* 优化失败按现网分类器工作 */ }
  try {
    const { backend: wantBackend, model: wantModel } = wantEmbedModel(loadConfig());
    const check = vectorStoreNeedsEmbed(wantBackend, wantModel);
    if (!check.need || embedRunning()) process.exit(0);
    spawnLogged(autoAbs, path.join(DATA_DIR, 'auto.log'), here);
  } catch { /* 不阻断已经返回的钩子 */ }
  process.exit(0);
}
