#!/usr/bin/env node
/**
 * 抽取式上下文 A/B:A=全文,B=系统+最近一轮+按余弦留下的历史。
 * 用当前 Ollama 嵌入模型,tokenizer-core 计 token。不写入 session-savings.json。
 *
 *   node test/extractive-ab.mjs
 *   node test/extractive-ab.mjs --rollout <jsonl> --cursor <jsonl>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gpuOptions, resolveBase } from '../../code-index/ollamaGuard.mjs';
import { loadConfig, DATA_DIR, OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX } from '../../code-index/config.mjs';

const { loadTokenizer, lookupModel } = createRequire(new URL('../../code-index/package.json', import.meta.url))('tokenizer-core');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const KEEP_K = 12;
const MIN_SCORE = 0.2;
const KEEP_TAIL = 2;
const INSTRUCT = 'Instruct: Given the current user request, retrieve relevant prior conversation turns and tool results\nQuery: ';
const TOKEN_CACHE = path.join(DATA_DIR, 'tokenizers');
const TOKEN_MODEL = 'qwen';
const CHECKPOINTS = [80, 160, 240, 400];

function textOf(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => {
      if (typeof p === 'string') return p;
      if (p?.text) return p.text;
      if (p?.type === 'tool_use') return `[tool ${p.name || ''}] ${JSON.stringify(p.input || {}).slice(0, 800)}`;
      if (p?.type === 'tool_result') return `[result] ${String(p.content ?? p.text ?? '').slice(0, 2000)}`;
      return p?.content ? String(p.content) : '';
    }).join('\n');
  }
  if (c && typeof c === 'object') return JSON.stringify(c);
  return String(m?.text || m?.message || '');
}

function cursorMessages(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const j = JSON.parse(line);
    return { role: j.role || 'user', content: textOf(j.message || j) };
  }).filter((m) => m.content.trim());
}

function snapshot(history, j, label) {
  return {
    label,
    n: history.length,
    src: j.querySource || '',
    usageIn: Number(j.response?.usage?.inputTokens) || 0,
    history: history.map((m) => ({ role: m.role, content: textOf(m) })),
  };
}

function reconstructZcode(file) {
  const picked = [];
  let history = [];
  let lastMain = null;
  let cp = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j?.type && j.type !== 'model_io') continue;
    const req = j.request || {};
    const msgs = req.messages;
    if (!Array.isArray(msgs) || !msgs.length) continue;
    history = history.slice(0, Number(req.messageOffset || 0)).concat(msgs);
    if ((j.querySource || '') !== 'main_turn') continue;
    lastMain = j;
    while (cp < CHECKPOINTS.length && history.length >= CHECKPOINTS[cp]) {
      picked.push(snapshot(history, j, String(CHECKPOINTS[cp])));
      cp += 1;
    }
  }
  if (lastMain && history.length) picked.push(snapshot(history, lastMain, 'last'));
  return picked;
}

function lastUser(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && msgs[i].content.trim()) return { i, text: msgs[i].content };
  }
  return { i: msgs.length - 1, text: msgs.at(-1)?.content || '' };
}

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

async function embedBatch(model, inputs) {
  const base = resolveBase();
  const out = [];
  const batch = 16;
  for (let i = 0; i < inputs.length; i += batch) {
    const slice = inputs.slice(i, i + batch);
    const resp = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: slice,
        options: { num_ctx: OLLAMA_NUM_CTX, ...gpuOptions() },
        keep_alive: OLLAMA_KEEP_ALIVE,
      }),
    });
    if (!resp.ok) throw new Error(`embed HTTP ${resp.status}: ${await resp.text()}`);
    const json = await resp.json();
    out.push(...json.embeddings);
  }
  return out;
}

async function encoder() {
  const entry = lookupModel(TOKEN_MODEL);
  const tokPath = path.join(TOKEN_CACHE, `${TOKEN_MODEL}.json`);
  if (!fs.existsSync(tokPath)) throw new Error(`缺少 tokenizer 缓存 ${tokPath}`);
  const tok = await loadTokenizer(TOKEN_MODEL, TOKEN_CACHE);
  if (!tok) throw new Error(`无法加载 ${TOKEN_MODEL} tokenizer (${entry?.repo || ''})`);
  return (text) => (text ? tok.encode(text).ids.length : 0);
}

function tokensOf(count, msgs) {
  return msgs.reduce((s, m) => s + count(`${m.role}\n${m.content}`), 0);
}

function selectB(msgs, scores, userIdx) {
  const keep = new Set();
  msgs.forEach((m, i) => { if (m.role === 'system') keep.add(i); });
  keep.add(userIdx);
  for (let i = Math.max(0, msgs.length - KEEP_TAIL); i < msgs.length; i++) keep.add(i);
  const ranked = scores
    .map((score, i) => ({ score, i }))
    .filter((x) => !keep.has(x.i) && x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, KEEP_K);
  for (const x of ranked) keep.add(x.i);
  return msgs.filter((_, i) => keep.has(i));
}

async function runCorpus(name, snaps, model, count) {
  const rows = [];
  for (const snap of snaps) {
    const msgs = snap.history.filter((m) => String(m.content || '').trim());
    if (msgs.length < 4) continue;
    const { i: userIdx, text: query } = lastUser(msgs);
    if (!query.trim()) continue;
    const embedTexts = msgs.map((m, i) => {
      const body = m.content.slice(0, 1800);
      return i === userIdx ? `${INSTRUCT}${query.slice(0, 1800)}` : body;
    });
    const vecs = await embedBatch(model, embedTexts);
    const q = vecs[userIdx];
    const scores = vecs.map((v, i) => (i === userIdx ? 1 : cosine(q, v)));
    const kept = selectB(msgs, scores, userIdx);
    const original = tokensOf(count, msgs);
    const compressed = tokensOf(count, kept);
    const saved = Math.max(0, original - compressed);
    rows.push({
      corpus: name,
      label: snap.label,
      messages: msgs.length,
      kept: kept.length,
      original,
      compressed,
      saved,
      pct: original ? +(saved / original * 100).toFixed(1) : 0,
      vendorIn: snap.usageIn || 0,
      maxScore: +Math.max(...scores.filter((_, i) => i !== userIdx)).toFixed(3),
    });
    process.stdout.write(`[ok] ${name} ${snap.label}: ${msgs.length}→${kept.length}  ${original}→${compressed}  节约 ${rows.at(-1).pct}%\n`);
  }
  return rows;
}

const cfg = loadConfig();
const model = cfg.models.embedding;
const rollout = path.resolve(opt('--rollout', path.join(os.homedir(), '.zcode/cli/rollout/model-io-session_235064ebe4a4a670f993210d0851bee5.jsonl')));
const cursor = path.resolve(opt('--cursor', path.join(os.homedir(), '.cursor/projects/d-HbuilderX-Project-TokenSaver/agent-transcripts/d4715fff-37e7-440d-b2b9-eacbba50f5f5/d4715fff-37e7-440d-b2b9-eacbba50f5f5.jsonl')));

const count = await encoder();
const probe = await embedBatch(model, [`${INSTRUCT}ping`, 'ping']);
if (cosine(probe[0], probe[1]) < 0.5) {
  console.error('[err] 自检失败:相同文本余弦过低,嵌入模型不可用');
  process.exit(1);
}

const rows = [];
if (fs.existsSync(rollout)) {
  rows.push(...await runCorpus('zcode-session', reconstructZcode(rollout), model, count));
} else {
  console.error(`[warn] 没有 ZCode rollout: ${rollout}`);
}
if (fs.existsSync(cursor)) {
  const msgs = cursorMessages(cursor);
  const cuts = CHECKPOINTS.filter((n) => n <= msgs.length).concat(msgs.length);
  const snaps = [...new Set(cuts)].map((n) => ({ label: n === msgs.length ? 'last' : String(n), history: msgs.slice(0, n) }));
  rows.push(...await runCorpus('cursor-chat', snaps, model, count));
} else {
  console.error(`[warn] 没有 Cursor 会话: ${cursor}`);
}

if (!rows.length) {
  console.error('[err] 没有可比较的样本');
  process.exit(1);
}

const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
const out = {
  model,
  tokenizer: TOKEN_MODEL,
  keepK: KEEP_K,
  minScore: MIN_SCORE,
  rows,
  totals: {
    original: sum('original'),
    compressed: sum('compressed'),
    saved: sum('saved'),
    pct: +(sum('saved') / Math.max(1, sum('original')) * 100).toFixed(1),
  },
};
const dest = path.join(root, 'data/ab/extractive-ab.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('\n# 抽取式 A/B');
console.log(`- 嵌入 ${model},计 token ${TOKEN_MODEL}`);
console.log(`- A=全文,B=系统+最近${KEEP_TAIL}条+余弦前${KEEP_K}(≥${MIN_SCORE})`);
console.log('| 语料 | 点 | 消息 | 留下 | A tokens | B tokens | 节约 |');
console.log('|---|---|---:|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(`| ${r.corpus} | ${r.label} | ${r.messages} | ${r.kept} | ${r.original} | ${r.compressed} | ${r.pct}% |`);
}
console.log(`\n合计 A ${out.totals.original} → B ${out.totals.compressed},节约 ${out.totals.pct}%`);
console.log(`[ok] ${dest}`);
