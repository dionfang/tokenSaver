/**
 * 每条用户消息触发一次。钩子进程立刻退出,签名检查放到分离的 --check。
 * 整文件 md5 要数秒,Cursor beforeSubmitPrompt 超时 10s,算完再拉起 auto 会被杀掉。
 *   向量与块清单一致 → --check 静默退出
 *   不一致且无嵌入进程 → 分离后台拉起 auto.mjs
 * 语义预取(UserPromptSubmit):用 bm25 快路径对用户原话查索引,把 top 命中作为
 * additionalContext 注入,让 agent 第一步就带着 file:行号开工。只走 bm25(无模型、
 * 零联网、~百毫秒),且不写 session-savings(预取不是 agent 主动检索,避免记账重复)。
 * Cursor beforeSubmitPrompt 复用本脚本,其转发器只回 continue,不受输出变化影响。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR } from './config.mjs';
import { vectorStoreNeedsEmbed, wantEmbedModel } from './vectorStore.mjs';
import { pidAlive, spawnLogged, LOCK_TTL_MS } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);
const autoAbs = path.resolve(here, 'auto.mjs');

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
  const hits = bm25Prefetch(chunks, prompt, k);
  if (!hits.length) return null;
  try { fs.writeFileSync(statePath, JSON.stringify({ sha, at: Date.now() })); } catch { /* 记不上就不去重 */ }
  return `[code-index] 与提问相关的索引命中(直接按行号区间读,不必再检索):\n${formatHits(hits)}`;
}

// ---------- 主流程 ----------

function embedRunning() {
  try {
    const { pid, ts } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.embed.pid'), 'utf8'));
    if (!pidAlive(pid)) return false;
    return Number.isFinite(ts) && Date.now() - ts < LOCK_TTL_MS;
  } catch { return false; }
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

  let ctx = null;
  try { ctx = prefetchContext(JSON.parse(raw || '{}')); } catch { /* 预取失败静默 */ }
  // 必须输出 {additionalContext} 对象;裸字符串宿主解析不出注入字段
  process.stdout.write(JSON.stringify(ctx ? { additionalContext: ctx } : {}) + '\n');
  process.exit(0);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self);
if (directRun && !process.argv.includes('--check')) {
  main();
}

if (process.argv.includes('--check')) {
  try {
    const { backend: wantBackend, model: wantModel } = wantEmbedModel(loadConfig());
    const check = vectorStoreNeedsEmbed(wantBackend, wantModel);
    if (!check.need || embedRunning()) process.exit(0);
    spawnLogged(autoAbs, path.join(DATA_DIR, 'auto.log'), here);
  } catch { /* 不阻断已经返回的钩子 */ }
  process.exit(0);
}
