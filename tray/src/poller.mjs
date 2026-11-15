/**
 * 轮询双通道(tray 方案 §16.2/§18-E2):快通道读数据文件(mtime 变才重解析),慢通道 spawn status.mjs。
 * 节奏:空闲 5s / 嵌入中(embedPid)1s / 慢刷新 ≥60s / 缓存 >10min 进 stale 立即慢刷 /
 * powerMonitor resume 由壳层调 slowRefresh('resume')。不替钩子补 warm(只有菜单「立即保鲜」才触发)。
 * IO 与 spawn 全部依赖注入(node 直跑单测,零 electron 依赖);读侧失败回退上次值(§20.2-P3-3)。
 */
import * as defaultIo from './util/statusFile.mjs';
import { computeLamps, knnLayerPaths } from './util/lamps.mjs';

export const FAST_IDLE_MS = 5_000;
export const FAST_EMBEDDING_MS = 1_000;
export const SLOW_INTERVAL_MS = 60_000;
export const STALE_AFTER_MS = 10 * 60_000;

/** 快通道间隔(纯函数):嵌入中 1s,空闲 5s。 */
export function nextDelayMs(health) { return health?.embedPid != null ? FAST_EMBEDDING_MS : FAST_IDLE_MS; }

/** 缓存陈旧判定(纯函数):>10min(或从未拿到过)即 stale → 立即慢刷。 */
export function isCacheStale(cachedAtMs, nowMs = Date.now()) { return cachedAtMs == null || nowMs - cachedAtMs > STALE_AFTER_MS; }

/** 慢通道到期判定(纯函数):stale 或距上次慢刷 ≥60s。 */
export function shouldSlowRefresh({ lastSlowAt = 0, nowMs, stale = false, intervalMs = SLOW_INTERVAL_MS } = {}) {
  return stale || nowMs - lastSlowAt >= intervalMs;
}

/** 模型灯过期判定(2026-11-15 用户裁决 B):非绿且缓存龄 >60s → 值得一次慢刷。
 *  资源取舍:不新增 probe 通道(每 5s 打 /api/ps 既持续耗 CPU 又判不出红黄),
 *  复用 status.mjs 全量判定;调用方须再套 60s 慢刷节流防风暴。 */
export const LAMP_STALE_MS = 60_000;
export function needsLampRefresh(lamps, cachedAtMs, nowMs = Date.now()) {
  const m = lamps?.models || {};
  const anyNonGreen = ['embedding', 'reranker', 'decision'].some((k) => m[k] && m[k] !== 'green');
  return anyNonGreen && cachedAtMs != null && nowMs - cachedAtMs > LAMP_STALE_MS;
}

export function createPoller(deps) {
  const {
    paths,
    cmdRun,
    onSnapshot = () => {},
    io = defaultIo,
    hfWeightCached = () => null,
    now = () => Date.now(),
    slowIntervalMs = SLOW_INTERVAL_MS,
  } = deps;

  const state = {
    cache: null, cacheKey: '',            // {at, health}
    chunks: { key: '', lines: null },
    meta: { key: '', value: null },
    knn: { key: '', base: null, local: null },
    golden: { key: '', value: null },   // 黄金集行数(决策向量对齐进度分母,2026-11-15)
    consent: { key: '', value: { uploadLocalKnn: false, consentedAt: null } },
    hooks: null,
    statusLine: null,
    lastSlowAt: 0,
    slowInFlight: false,
    lastFailReason: null,
  };

  const fileKey = (p) => { const s = io.statOf(p); return s ? `${s.mtimeMs}:${s.size}` : null; };

  function readCache() {
    const p = `${paths.dataDir}/model-health-cache.json`;
    const key = fileKey(p);
    if (key != null && key === state.cacheKey && state.cache) return state.cache;
    const j = paths.dataDir != null ? io.readHealthCache(paths.dataDir) : null;
    if (j) { state.cache = j; state.cacheKey = key ?? ''; }
    else if (key == null && state.lastFailReason !== 'no-cache') {
      // 文件消失/损坏:回退上次值(§20.2);首次无缓存保留 null 触发慢刷
      if (!state.cache) state.lastFailReason = 'no-cache';
    }
    return state.cache;
  }

  function readChunks() {
    const p = `${paths.dataDir}/chunks.jsonl`;
    const key = fileKey(p);
    if (key === state.chunks.key) return state.chunks.lines;
    const lines = paths.dataDir != null ? io.countChunksLines(paths.dataDir) : null;
    if (lines != null || key == null) { state.chunks = { key: key ?? '', lines }; }
    return state.chunks.lines;
  }

  function readMeta(backend) {
    const p = `${paths.dataDir}/vectors/${backend === 'local' ? 'local' : 'ollama'}/meta.json`;
    const key = fileKey(p);
    if (key === state.meta.key) return state.meta.value;
    const v = paths.dataDir != null ? io.readVectorMetaAt(paths.dataDir, backend) : null;
    if (v != null || key == null) state.meta = { key: key ?? '', value: v };
    return state.meta.value;
  }

  function readKnn(health) {
    const pth = knnLayerPaths(paths.dataDir, health);
    const kb = fileKey(pth.base);
    const kl = fileKey(pth.local);
    const key = `${kb}|${kl}|${pth.slug}`;
    if (key === state.knn.key && state.knn.base) return state.knn;
    const base = io.readKnnLayer(pth.base);
    const local = io.readKnnLayer(pth.local);
    state.knn = { key, base, local };
    return state.knn;
  }

  /** 黄金集行数(对齐进度分母);mtime 门控缓存。 */
  function readGolden() {
    const p = `${paths.dataDir}/routing/golden-set.jsonl`;
    const key = fileKey(p);
    if (key === state.golden.key && key != null) return state.golden.value;
    const v = paths.dataDir != null ? io.countGoldenLines(paths.dataDir) : null;
    state.golden = { key: key ?? '', value: v };
    return v;
  }

  function readConsent() {
    const p = `${paths.dataDir}/tray-consent.json`;
    const key = fileKey(p);
    if (key === state.consent.key && key != null) return state.consent.value;
    const v = paths.dataDir != null ? io.readConsentFile(paths.dataDir) : null;
    state.consent = { key: key ?? '', value: v };
    return v;
  }

  /** 快通道:只读文件,组快照。返回快照对象;同时按需发起慢刷(不 await)。
   *  allowSlow=false 供慢刷自身收尾复用快照组装——禁止再触发慢刷(缓存仍缺时 stale 恒真,
   *  否则微任务链 status→fastTick→status 无限自旋饿死定时器;慢刷只由外部节拍发起,天然退避)。 */
  function fastTick(allowSlow = true) {
    const cache = readCache();
    const health = cache?.health ?? null;
    const backend = health?.modelIn === 'local' ? 'local' : 'ollama';
    const chunksLines = readChunks();
    const vectors = {
      embExists: paths.dataDir != null ? io.embeddingsExists(paths.dataDir, backend) : false,
      meta: readMeta(backend),
    };
    const knnL = readKnn(health);
    const consent = readConsent();
    const progress = health?.embedPid != null && paths.dataDir != null
      ? io.readEmbedProgress(`${paths.dataDir}/embed.log`)
      : null;
    const localWeights = backend === 'local'
      ? {
        embedding: hfWeightCached(paths.hfCacheDir, health?.models?.localEmbedding),
        reranker: hfWeightCached(paths.hfCacheDir, health?.models?.localReranker),
        decision: hfWeightCached(paths.hfCacheDir, health?.models?.localDecision),
      }
      : {};
    const lamps = computeLamps({ health, vectors, chunksLines, knn: knnLayerInput(knnL), hooks: state.hooks, consent, progress, localWeights, goldenCount: readGolden() });
    if (state.statusLine == null && paths.dataDir != null) state.statusLine = io.readLastStatus(paths.dataDir);
    const stale = isCacheStale(cache?.at ?? null, now());
    const snapshot = {
      at: now(),
      lamps,
      statusLine: state.statusLine,
      progress,
      healthAt: cache?.at ?? null,
      stale,
      degraded: !paths.dataDir,
      embedPid: health?.embedPid ?? null,
      modelIn: health?.modelIn ?? null,
      consent,
    };
    onSnapshot(snapshot);
    if (allowSlow) {
      const due = shouldSlowRefresh({ lastSlowAt: state.lastSlowAt, nowMs: now(), stale, intervalMs: slowIntervalMs });
      const lampDue = needsLampRefresh(lamps, cache?.at ?? null, now()) && now() - state.lastSlowAt >= slowIntervalMs; // 灯黄且缓存旧:受 60s 节流防风暴
      if (due || lampDue) slowRefresh(lampDue && !due ? 'lamp' : 'tick');
    }
    return snapshot;
  }

  const knnLayerInput = (k) => (k ? {
    baseExists: k.base?.exists === true,
    localExists: k.local?.exists === true,
    baseEntries: k.base?.entries ?? null,
    localEntries: k.local?.entries ?? null,
  } : null);

  /** 慢通道:spawn status.mjs(30s 超时)刷新缓存与 last-status;失败回退读 last-status.txt。
   *  同时刷新三端钩子灯(spawn hooksStatus,失败保留上次)。 */
  async function slowRefresh(reason = 'manual') {
    if (state.slowInFlight) return { skipped: true };
    state.slowInFlight = true;
    try {
      let ok = false;
      if (paths.codeIndexRoot && paths.nodeBin) {
        const res = await cmdRun('status', paths.nodeBin, [`${paths.codeIndexRoot}/status.mjs`], { cwd: paths.codeIndexRoot });
        if (res.skipped) return { skipped: true };
        if (res.code === 0 && res.stdout.trim()) {
          state.statusLine = res.stdout.split('\n').find((l) => l.trim())?.trim() ?? state.statusLine;
          ok = true;
        }
        const hooksRes = await cmdRun('hooksStatus', paths.nodeBin, [`${paths.codeIndexRoot}/hooksStatus.mjs`], { cwd: paths.codeIndexRoot });
        if (!hooksRes.skipped && hooksRes.code === 0 && hooksRes.stdout.trim()) {
          try { state.hooks = JSON.parse(hooksRes.stdout); } catch { /* 保留上次 */ }
        }
      }
      if (!ok && paths.dataDir != null) {
        const fb = io.readLastStatus(paths.dataDir);
        if (fb) state.statusLine = fb;
        state.lastFailReason = `status.mjs 失败(${reason}),回退 last-status.txt`;
      } else if (ok) {
        state.lastFailReason = null;
        state.cacheKey = ''; // status.mjs 刚重写缓存,强制下次重读
      }
      state.lastSlowAt = now();
    } finally {
      state.slowInFlight = false;
    }
    return fastTick(false);
  }

  return { fastTick, slowRefresh, nextDelayMs: () => nextDelayMs(state.cache?.health), get state() { return state; } };
}
