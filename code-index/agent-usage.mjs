/**
 * afterAgentResponse 记账(model-routing.md #12/#15):把每轮响应的 token 用量追加到
 * data/usage/agent-usage.jsonl,作为 Cursor 端健康层/用量报表的数据源(afterAgentResponse
 * 自带 input/output/cache_read/cache_write tokens,不依赖 ZCode 的 db.sqlite)。
 * 只追加、只落盘、永不抛出——记账失败不影响会话。
 * stdin 为宿主 JSON:{conversation_id,model,text,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,...}
 * 同进程入口:runAgentUsage({stdinText,tool,dataDir});直呼本脚本也可(读 stdin,回 '{}')。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';

const self = fileURLToPath(import.meta.url);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 解析并追加一条用量记录。dataDir 可注入以便测试密闭。返回是否写入。 */
export function runAgentUsage({ stdinText = '', tool = 'unknown', dataDir = DATA_DIR } = {}) {
  let evt = {};
  try { evt = JSON.parse(String(stdinText || '{}')); } catch { evt = {}; }
  if (typeof evt !== 'object' || evt === null || Array.isArray(evt)) evt = {};
  const model = typeof evt.model === 'string' && evt.model ? evt.model : null;
  const inputTokens = num(evt.input_tokens);
  const outputTokens = num(evt.output_tokens);
  const cacheReadTokens = num(evt.cache_read_tokens);
  const cacheWriteTokens = num(evt.cache_write_tokens);
  const hasTokens = inputTokens != null || outputTokens != null || cacheReadTokens != null || cacheWriteTokens != null;
  if (!model && !hasTokens) return false; // 空载荷不记空账
  const rec = {
    ts: Date.now(),
    tool,
    conversationId: typeof evt.conversation_id === 'string' ? evt.conversation_id : null,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
  try {
    const file = path.join(dataDir, 'usage', 'agent-usage.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return true;
  } catch { return false; } // 记不上就算了
}

/** Qoder 用户级配置目录(CN ~/.qoder-cn / 国际 ~/.qoder;语义与 init.mjs qoderUserDir 一致)。 */
export function qoderUserDirLike(home) {
  const cn = path.join(home, '.qoder-cn');
  const intl = path.join(home, '.qoder');
  if (fs.existsSync(intl) && !fs.existsSync(cn)) return intl;
  return cn;
}

function listSegmentFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl') && path.basename(path.dirname(p)) === 'segments') out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** ~/.qoder-cn/projects/<项目>/<sessionId>.jsonl(项目 transcript,每会话一个文件)。 */
export function listTranscriptFiles(root) {
  const out = [];
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(root, p.name);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(dir, e.name));
  }
  return out;
}

/** 单行解析 auto-compact 边界;压缩会把已省下的上下文一并清掉。非边界行返回 null。 */
function parseCompactLine(line) {
  if (!line || !line.includes('compact_boundary')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o?.type !== 'system' || o?.subtype !== 'compact_boundary') return null;
  const ts = Date.parse(typeof o.timestamp === 'string' ? o.timestamp : '');
  if (!Number.isFinite(ts)) return null;
  return { ts, preTokens: num(o.compactMetadata?.preTokens), postTokens: num(o.compactMetadata?.postTokens) };
}

/** transcript 里的 auto-compact 边界(整文件扫,只在首次/补齐时用;常规轮次走增量收集)。 */
export function readCompactionBoundaries(fp) {
  let text;
  try { text = fs.readFileSync(fp, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const b = parseCompactLine(line);
    if (b) out.push(b);
  }
  return out;
}

/** 合并写 data/usage/qoder-compaction.json:{<sessionId>:[{ts,preTokens,postTokens}]},按 ts 去重。返回新增条数。 */
function writeCompactionMap(dataDir, foundBySession) {
  const file = path.join(dataDir, 'usage', 'qoder-compaction.json');
  let map = {};
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) map = j;
  } catch { /* 无旧文件 */ }
  let added = 0;
  for (const [sid, list] of Object.entries(foundBySession)) {
    const prev = Array.isArray(map[sid]) ? map[sid] : [];
    const seen = new Set(prev.map((b) => Number(b?.ts)));
    const fresh = (list || []).filter((b) => !seen.has(b.ts));
    if (!fresh.length) continue;
    added += fresh.length;
    map[sid] = [...prev, ...fresh].sort((a, b) => Number(a.ts) - Number(b.ts));
  }
  if (!added) return 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map));
  } catch { return 0; }
  return added;
}

function parseQoderLine(line, fp) {
  if (!line.includes('model.response.completed')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  const d = o && typeof o === 'object' ? o.data : null;
  if (!d || typeof d !== 'object') return null;
  const inputTokens = num(d.input_tokens);
  const outputTokens = num(d.output_tokens);
  if ((inputTokens ?? 0) === 0 && (outputTokens ?? 0) === 0) return null; // 零载荷(未上报用量)跳过
  const conv = path.basename(path.dirname(path.dirname(fp))); // .../<sessionId>/segments/x.jsonl
  const ts = Date.parse(typeof o.ts === 'string' ? o.ts : '');
  return {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    tool: 'qoder',
    conversationId: conv,
    model: typeof d.model === 'string' && d.model ? d.model : null, // Qoder 记的是内部 UUID,原值保留
    inputTokens,
    outputTokens,
    cacheReadTokens: num(d.cache_read_input_tokens),
    cacheWriteTokens: num(d.cache_creation_input_tokens),
  };
}

/**
 * 项目 transcript 的 assistant.message.usage 带服务端计量 credits(内置 provider 的 token 字段恒为 0)。
 * 返回 {rec,key};key=request_id(压缩重写文件时用于跨重扫去重)。
 */
function parseQoderCreditLine(line, fp) {
  if (!line.includes('"credits"')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  const m = o && typeof o === 'object' ? o.message : null;
  const u = m && typeof m === 'object' ? m.usage : null;
  if (!u || typeof u !== 'object') return null;
  const credits = num(u.credits);
  const originalCredits = num(u.original_credits);
  if (!(credits > 0) && !(originalCredits > 0)) return null;
  const ts = Date.parse(typeof o.timestamp === 'string' ? o.timestamp : '');
  const rec = {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    tool: 'qoder',
    conversationId: path.basename(fp, '.jsonl'),
    model: typeof m.model === 'string' && m.model ? m.model : null,
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    credits,
    originalCredits,
    billable: typeof u.billable === 'boolean' ? u.billable : null,
    contextUsageRatio: num(u.context_usage_ratio),
    requestId: typeof u.request_id === 'string' && u.request_id ? u.request_id : null,
  };
  const key = rec.requestId || `${rec.ts}|${rec.credits}|${rec.model || ''}`;
  return { rec, key };
}

/**
 * Qoder 增量记账(model-routing.md #12):两路数据源,均追加到 data/usage/agent-usage.jsonl(tool='qoder')。
 *   1. logs/sessions/**\/segments/*.jsonl 的 model.response.completed:token 用量(内置 provider 当前恒为 0,留待上报);
 *   2. projects/<项目>/<sessionId>.jsonl 的 message.usage.credits:服务端按请求计量的真实 credits
 *      (billable=false 表示套餐内计入,并非无消耗)。
 * Qoder 无 afterAgentResponse 钩子,记账入口是 SessionStart + 每轮 UserPromptSubmit(prompt-guard 调本函数)。
 * 按 file offset 断点续读(半行留待下次);
 * transcript 被整体重写(如压缩)时 offset 回退重扫,再按 request_id 去重。state 存
 * data/usage/qoder-scan-state.json;幂等——重复运行不产生重复记录。home/dataDir/stateFile 可注入以便测试密闭。
 */
export function scanQoderUsage({ home = os.homedir(), dataDir = DATA_DIR, stateFile = null } = {}) {
  const qdir = qoderUserDirLike(home);
  const logsRoot = path.join(qdir, 'logs', 'sessions');
  const projRoot = path.join(qdir, 'projects');
  const statePath = stateFile || path.join(dataDir, 'usage', 'qoder-scan-state.json');
  let state = { files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') state = parsed;
  } catch { /* 无 state/坏 state → 从头扫 */ }
  const files = listSegmentFiles(logsRoot);
  const transcripts = listTranscriptFiles(projRoot);
  const alive = new Set([...files, ...transcripts]);
  const pending = [];

  const scanFile = (fp, parse, dedupe, onBoundary) => {
    const saved = Number(state.files[fp]?.offset) || 0;
    const keep = state.files[fp]?.bswept === true ? { bswept: true } : {}; // 整读过压缩边界的标记不能被增量写丢掉
    let st;
    try { st = fs.statSync(fp); } catch { return; }
    const prev = st.size < saved ? 0 : saved; // 文件被重写(压缩/整理)→ 从头扫,靠 requestId 去重
    const seen = dedupe ? new Set(Array.isArray(state.files[fp]?.seen) ? state.files[fp].seen : []) : null;
    if (st.size <= prev) {
      state.files[fp] = { ...keep, ...(seen ? { offset: prev, seen: [...seen] } : { offset: prev }) };
      return;
    }
    let buf;
    try {
      buf = Buffer.alloc(st.size - prev);
      const fd = fs.openSync(fp, 'r');
      fs.readSync(fd, buf, 0, buf.length, prev);
      fs.closeSync(fd);
    } catch { return; }
    const lastNl = buf.lastIndexOf(0x0a);
    const consumed = lastNl >= 0 ? prev + lastNl + 1 : prev; // 半行(无结尾换行)留待下次
    if (lastNl >= 0) {
      const text = buf.subarray(0, lastNl + 1).toString('utf8');
      for (const line of text.split('\n')) {
        if (onBoundary) { const b = parseCompactLine(line); if (b) onBoundary(b); }
        const parsed = parse(line, fp);
        if (!parsed) continue;
        if (seen) {
          if (seen.has(parsed.key)) continue;
          seen.add(parsed.key);
          pending.push(parsed.rec);
        } else {
          pending.push(parsed);
        }
      }
    }
    state.files[fp] = { ...keep, ...(seen ? { offset: consumed, seen: [...seen].slice(-5000) } : { offset: consumed }) };
  };

  const foundBySession = {};
  const pushBoundary = (sid, sink) => (b) => { (sink[sid] ||= []).push(b); };
  for (const fp of files) scanFile(fp, parseQoderLine, false);
  for (const fp of transcripts) {
    const sid = path.basename(fp, '.jsonl');
    const st0 = state.files[fp];
    // 增量读只覆盖新尾;首次(或升级后)整读一次补齐历史,之后只从新尾收压缩边界
    const fullSweep = !(Number(st0?.offset) > 0 && st0?.bswept === true);
    scanFile(fp, parseQoderCreditLine, true, fullSweep ? null : pushBoundary(sid, foundBySession));
    if (fullSweep) {
      const bs = readCompactionBoundaries(fp);
      if (bs.length) (foundBySession[sid] ||= []).push(...bs);
      if (state.files[fp]) state.files[fp] = { ...state.files[fp], bswept: true };
    }
  }
  for (const k of Object.keys(state.files)) if (!alive.has(k)) delete state.files[k];
  let written = 0;
  if (pending.length) {
    try {
      const out = path.join(dataDir, 'usage', 'agent-usage.jsonl');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.appendFileSync(out, pending.map((r) => JSON.stringify(r)).join('\n') + '\n');
      written = pending.length;
    } catch { written = 0; }
  }
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch { /* state 写不进下次会重扫,靠幂等语义兜底 */ }
  const boundaries = writeCompactionMap(dataDir, foundBySession);
  return { scanned: files.length + transcripts.length, written, boundaries };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self);
if (directRun) {
  if (process.argv.includes('--scan-qoder')) {
    const r = scanQoderUsage({});
    process.stdout.write(JSON.stringify(r) + '\n');
  } else {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      try { runAgentUsage({ stdinText: raw, tool: process.env.AGENT_USAGE_TOOL || 'unknown' }); } catch { /* 不阻断 */ }
      process.stdout.write('{}');
    });
  }
}
