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

/** data/routing/exemplars.json 样本条数(决策向量装填分母)。缺失或损坏返回 null。
 *  优先 stats.total(与 exemplars 数组等长);没有该字段时数数组。 */
export function countExemplars(dataDir) {
  const txt = readTextOnce(path.join(dataDir, 'routing', 'exemplars.json'));
  if (txt == null) return null;
  try {
    const j = JSON.parse(txt);
    if (Number.isFinite(j?.stats?.total)) return j.stats.total;
    if (Array.isArray(j?.exemplars)) return j.exemplars.length;
    return null;
  } catch { return null; }
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
  if (!existsSyncSafe(file)) return { exists: false, entries: null, builtAt: null };
  const txt = readTextOnce(file);
  if (txt == null) return { exists: true, entries: null, builtAt: null };
  try {
    const j = JSON.parse(txt);
    const n = Number.isFinite(j?.ok) ? j.ok : j?.vectors && typeof j.vectors === 'object' ? Object.keys(j.vectors).length : null;
    return { exists: true, entries: n, builtAt: typeof j?.builtAt === 'string' ? j.builtAt : null };
  } catch { return { exists: true, entries: null, builtAt: null }; }
}

/** 与 code-index/proc.mjs LOCK_TTL_MS 一致:超 6 小时或进程已死的 .embed.pid 不算在嵌。 */
const EMBED_LOCK_TTL_MS = 6 * 60 * 60 * 1000;

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** data/.embed.pid 实时读。快通道不走 health-cache,嵌入一开始按钮就能显示同步中。 */
export function readLiveEmbedPid(dataDir) {
  const txt = readTextOnce(path.join(dataDir, '.embed.pid'));
  if (!txt) return null;
  try {
    const j = JSON.parse(txt);
    if (!pidAlive(j?.pid) || !Number.isFinite(j?.ts) || Date.now() - j.ts >= EMBED_LOCK_TTL_MS) return null;
    return j.pid;
  } catch { return null; }
}

/** data/routing/build-vectors.progress.json。只在 pid 与当前锁一致时由轮询采用。 */
export function readBuildVectorsProgress(dataDir) {
  const txt = readTextOnce(path.join(dataDir, 'routing', 'build-vectors.progress.json'));
  if (!txt) return null;
  try {
    const j = JSON.parse(txt);
    const covered = Number(j?.covered);
    const pid = Number(j?.pid);
    if (!Number.isFinite(covered) || covered < 0 || !Number.isInteger(pid)) return null;
    return { covered, total: Number.isFinite(Number(j?.total)) ? Number(j.total) : null, pid };
  } catch { return null; }
}

/** data/embed-progress.json(代码索引嵌入实时进度,embed.mjs 每批落盘,2026-11-21)。
 *  只在 pid 与当前嵌入锁一致时由轮询采用;损坏/缺失=null。done=复用+已嵌(总体口径,不假满)。 */
export function readEmbedProgressFile(dataDir) {
  const txt = readTextOnce(path.join(dataDir, 'embed-progress.json'));
  if (!txt) return null;
  try {
    const j = JSON.parse(txt);
    const done = Number(j?.done);
    const pid = Number(j?.pid);
    if (!Number.isFinite(done) || done < 0 || !Number.isInteger(pid)) return null;
    return { done, total: Number.isFinite(Number(j?.total)) ? Number(j.total) : null, pid };
  } catch { return null; }
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
