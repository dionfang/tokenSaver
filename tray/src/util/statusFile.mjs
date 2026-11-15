/**
 * 数据文件纯读(tray 方案 §16.1/§20.2-P3-3):health-cache / last-status.txt / embed.log 尾窗 /
 * chunks 行数 / 向量 meta / KNN 双层 / consent。零 code-index import;读侧健壮性(§20.2):
 * JSON.parse 失败返回 null 由调用方回退上次值;短开短读容忍 EPERM(Windows rename 竞态,重试一次)。
 */
import fs from 'node:fs';
import path from 'node:path';

const RETRY_ERRNOS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const syncSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 短开短读+EPERM 单次重试(rename 覆盖竞态窗口极小,25ms 后再开一次)。 */
export function readTextOnce(file, { attempts = 2, delayMs = 25 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (!RETRY_ERRNOS.has(e?.code) || i === attempts - 1) return null; }
    syncSleep(delayMs);
  }
  return null;
}

export function statOf(file) { try { const s = fs.statSync(file); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } }
export function existsSyncSafe(file) { try { return fs.existsSync(file); } catch { return false; } }

/** data/model-health-cache.json → {at, health};缺失/损坏返回 null(调用方回退上次值)。 */
export function readHealthCache(dataDir) {
  const txt = readTextOnce(path.join(dataDir, 'model-health-cache.json'));
  if (!txt) return null;
  try { const j = JSON.parse(txt); return j && j.at && j.health ? j : null; } catch { return null; }
}

export function readLastStatus(dataDir) {
  const txt = readTextOnce(path.join(dataDir, 'last-status.txt'));
  return txt ? txt.split('\n').find((l) => l.trim())?.trim() ?? null : null;
}

/** embed.log 尾读最后一条 [progress] 嵌入 X/Y(modelStatus.mjs readEmbedProgress 的镜像,
 *  64KB 尾窗;测试与真源互验)。仅展示,不参与灯判定(§5.3.2 铁律)。 */
export function readEmbedProgress(logFile) {
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

/** data/chunks.jsonl 行数(全量真值的分母);无文件返回 null(roots=0 → 嵌入灯 empty)。 */
export function countChunksLines(dataDir) {
  const txt = readTextOnce(path.join(dataDir, 'chunks.jsonl'));
  if (txt == null) return null;
  return txt.length ? txt.trimEnd().split('\n').length : 0;
}

/** data/vectors/<local|ollama>/meta.json(镜像 vectorStore.readVectorMeta,纯读按路径)。 */
export function readVectorMetaAt(dataDir, backend) {
  const txt = readTextOnce(path.join(dataDir, 'vectors', backend === 'local' ? 'local' : 'ollama', 'meta.json'));
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

export function embeddingsExists(dataDir, backend) {
  return existsSyncSafe(path.join(dataDir, 'vectors', backend === 'local' ? 'local' : 'ollama', 'embeddings.bin'));
}

/** KNN 双层文件实况:存在性+条数(条数取 ok 字段,兜底 vectors 键数)。 */
export function readKnnLayer(file) {
  if (!existsSyncSafe(file)) return { exists: false, entries: null };
  const txt = readTextOnce(file);
  if (txt == null) return { exists: true, entries: null };
  try {
    const j = JSON.parse(txt);
    const n = Number.isFinite(j?.ok) ? j.ok : j?.vectors && typeof j.vectors === 'object' ? Object.keys(j.vectors).length : null;
    return { exists: true, entries: n };
  } catch { return { exists: true, entries: null }; }
}

/** data/tray-consent.json(§6 getConsent 契约);缺失/损坏=null(未配置≠已拒绝)。
 * 2026-11-15 用户裁决:缺文件不得伪 false——否则未跑向导的机器面板误显「未同意上传」互惠文案。 */
export function readConsentFile(dataDir) {
  const txt = readTextOnce(path.join(dataDir, 'tray-consent.json'));
  if (!txt) return null;
  try {
    const j = JSON.parse(txt);
    return { uploadLocalKnn: j?.uploadLocalKnn === true, consentedAt: j?.consentedAt ?? null };
  } catch { return null; }
}
