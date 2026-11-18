/** 模型下载进度登记簿(2026-11-18 交互同步):wizard 权重下载/托盘自动补/gpu pull 三路共用,
 *  ①环境自检行与下一步门禁(下载中=可跳过不拦);②托盘面板模型行显示「下载中 pct%」替代未安装。
 *  纯登记(无 electron/无 code-index import);事件停更 15s 视为结束(失败/成功均自然衰减回未安装,
 *  成功由调用方显式 done→100% 保留至 staleMs 过期,重跑自检时行已转绿)。 */
const KEYS = ['embedding', 'reranker', 'decision'];
const STALE_MS = 15_000;

export function keyOfItemId(id) {
  const s = String(id || '');
  if (s.startsWith('embed:')) return 'embedding';
  if (s.startsWith('rerank:')) return 'reranker';
  if (s.startsWith('decision:')) return 'decision';
  return null;
}

export function createDownloadRegistry({ now = () => Date.now(), onChange = () => {}, staleMs = STALE_MS } = {}) {
  const items = new Map(); // key -> {pct, bytesDone, bytesTotal, file, phase, at}
  function snap() {
    const out = {};
    for (const k of KEYS) if (alive(k)) out[k] = { ...items.get(k) };
    return out;
  }
  const fire = () => { try { onChange(snap()); } catch { /* 回调异常不影响登记 */ } };

  function upsert(key, patch) {
    const prev = items.get(key) || {};
    items.set(key, { ...prev, ...patch, at: now() });
    fire();
  }
  function alive(key) {
    const it = items.get(key);
    if (!it) return false;
    if (now() - it.at > staleMs) { items.delete(key); fire(); return false; }
    return true;
  }

  return {
    /** downloader onProgress(逐文件):itemId 形如 embed:onnx/model_quantized.onnx */
    update(item) {
      const key = keyOfItemId(item?.itemId);
      if (!key) return;
      upsert(key, { pct: item.pct ?? null, bytesDone: item.bytesDone ?? null, bytesTotal: item.bytesTotal ?? null, file: String(item.itemId).split(':').slice(1).join(':'), phase: item.phase || '' });
    },
    /** gpu ollama pull(NDJSON 真百分比);tag 名→模型键由调用方映射 */
    pull(key, pct, file = '') {
      if (!KEYS.includes(key)) return;
      upsert(key, { pct: Number.isFinite(Number(pct)) ? Number(pct) : null, bytesDone: null, bytesTotal: null, file, phase: 'pull' });
    },
    /** 显式完成(100% 保留至 stale 过期,重跑自检时行已按真实状态转绿) */
    done(key) { if (KEYS.includes(key) && items.has(key)) upsert(key, { pct: 100, phase: 'done' }); },
    clear(key) { if (items.delete(key)) fire(); },
    isDownloading(key) { return KEYS.includes(key) && alive(key); },
    /** 行展示快照 {embedding:{pct,file,...},...};仅含仍在下载的键 */
    snapshot: () => snap(),
    KEYS,
  };
}