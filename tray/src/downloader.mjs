/**
 * 串行下载器(tray 方案 §16.6/§18-A3/C3/C4,2026-11-15 M2):
 *  - http/deps 项:Range 断点续传写 *.part → sha256 校验通过才原子改名;失败同一 URL 重试 3 次后换 urls[] 镜像;
 *    暂停=断开保留 .part;取消=终止当前项保留 .part 供续传(重开向导已过校验项不重下)。
 *  - ollama-pull 项:POST 本机 Ollama /api/pull NDJSON 流式进度(status/pull 的 completed/total),同一进度通道。
 *  - 进度事件 {itemId,pct,bytesDone,bytesTotal,phase:fetching|resume|verify|pull|done}。
 * 零 npm 依赖(node:http/https/crypto);不 import code-index/**(§18-E1)。镜像数组硬约束:官方源直连不可用是实测教训。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

export const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';
const RETRIES_PER_URL = 3;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** http(s) 请求(依赖注入点:单测用本地 node:http 假源)。resolve 于响应头;body 由调用方消费流。 */
export function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, res, req });
    });
    req.on('timeout', () => { req.destroy(new Error(`请求超时(${timeoutMs}ms)`)); });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/** 文件 sha256(流式)。 */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** dest 越界防护(纯):dest 必须落在 baseDir 内,拒绝绝对路径与 .. 逃逸。 */
export function safeDest(baseDir, dest) {
  const p = path.resolve(baseDir, dest);
  const b = path.resolve(baseDir);
  return p === b || p.startsWith(b + path.sep) ? p : null;
}

/** 原子落位:优先直接 rename;仅当目标已存在时再删旧重试。禁止「先删终名再失败」导致两头皆空。 */
function atomicRename(part, final) {
  try {
    fs.renameSync(part, final);
    return;
  } catch {
    /* Windows 目标已存在时常 EPERM/EEXIST → 删旧再试 */
  }
  try { fs.unlinkSync(final); } catch { /* 无旧文件 */ }
  fs.renameSync(part, final);
}

/** Ollama 服务在听探测(§17.2/B1 硬门禁口径:GET /api/version,默认 2s 超时)。 */
export async function probeOllama({ base = DEFAULT_OLLAMA_BASE, timeoutMs = 2_000, httpReq = httpRequest } = {}) {
  try {
    const { status, res } = await httpReq(`${base}/api/version`, { timeoutMs });
    let txt = '';
    res.setEncoding('utf8');
    for await (const c of res) txt += c;
    if (status !== 200) return { ok: false, reason: 'bad-status', status };
    try { return { ok: true, version: JSON.parse(txt)?.version ?? null }; } catch { return { ok: true, version: null }; }
  } catch (e) { return { ok: false, reason: /超时|timeout/i.test(String(e?.message || e)) ? 'timeout' : 'unreachable' }; }
}

export function createDownloader(deps = {}) {
  const {
    onProgress = () => {},
    sleep = defaultSleep,
    httpReq = httpRequest,
    now = () => Date.now(),
    progressMinIntervalMs = 100,
  } = deps;
  let control = { requested: null }; // 'pause' | 'cancel'
  let active = null;                 // 当前 { req, res? } 便于 pause/cancel 即时断开
  const emit = (p) => onProgress(p);
  const throttled = (() => { let last = 0; return (p) => { const t = now(); if (p.phase !== 'fetching' && p.phase !== 'pull' || t - last >= progressMinIntervalMs) { last = t; emit(p); } }; })();

  function abortCurrent() {
    try { active?.res?.destroy(); } catch { /* 已断 */ }
    try { active?.req?.destroy(); } catch { /* 已断 */ }
  }

  function pause() { control.requested = 'pause'; abortCurrent(); }
  function cancel() { control.requested = 'cancel'; abortCurrent(); }
  const stopped = () => control.requested;

  /** 单个 http/deps 项的完整下载(含重试换源)。返回 {status:'ok'|'paused'|'cancelled'|'failed', error?}。 */
  async function downloadFileItem(item, { baseDir, standalone = true }) {
    if (standalone) control = { requested: null }; // 直调入口(如向导内代下 Ollama 安装包)不继承上一轮的暂停/取消
    const final = safeDest(baseDir, item.dest);
    if (!final) return { status: 'failed', error: `dest 越界:${item.dest}` };
    // 重入跳过:终名已存在且 sha256 通过(§16.4 已校验通过项跳过,不重复下载);
    // 2026-11-17 全在线:sha256 可选(HF 在线权重无预置哈希,HTTPS 保完整性),无 sha 时按期望字节数判完整
    if (fs.existsSync(final)) {
      if (item.sha256) {
        const got = await sha256File(final).catch(() => null);
        if (got === item.sha256.toLowerCase()) {
          emit({ itemId: item.id, pct: 100, bytesDone: item.bytes ?? null, bytesTotal: item.bytes ?? null, phase: 'done', skipped: true });
          return { status: 'ok', skipped: true };
        }
      } else if (item.bytes != null && fs.statSync(final).size === Number(item.bytes)) {
        emit({ itemId: item.id, pct: 100, bytesDone: item.bytes, bytesTotal: item.bytes, phase: 'done', skipped: true });
        return { status: 'ok', skipped: true };
      } else if (!item.sha256 && item.bytes == null) {
        // 小文件(config/tokenizer_config)无预置哈希与字节数:终名只在校验/size 门通过后改名,存在即完整
        emit({ itemId: item.id, pct: 100, bytesDone: null, bytesTotal: null, phase: 'done', skipped: true });
        return { status: 'ok', skipped: true };
      }
    }
    const part = final + '.part';
    fs.mkdirSync(path.dirname(final), { recursive: true });
    let lastErr = null;
    for (const url of item.urls) {
      for (let attempt = 1; attempt <= RETRIES_PER_URL; attempt++) {
        if (stopped()) return { status: stopped() };
        try {
          await fetchOnce(item, url, part, final);
          return { status: 'ok' };
        } catch (e) {
          if (stopped()) return { status: stopped() };
          lastErr = e;
          if (attempt < RETRIES_PER_URL) await sleep(500 * 2 ** (attempt - 1)); // 指数退避(§16.4)
        }
      }
    }
    return { status: 'failed', error: `全部源重试失败:${String(lastErr?.message || lastErr)}` };
  }

  /** .part 已完整时直接校验改名,避免对「已下满」再发 Range → HTTP 416 死循环。 */
  async function finalizeIfComplete(item, part, final) {
    emit({ itemId: item.id, pct: 100, bytesDone: fs.statSync(part).size, bytesTotal: item.bytes ?? null, phase: 'verify' });
    if (item.sha256) {
      const got = await sha256File(part);
      if (got !== item.sha256.toLowerCase()) {
        try { fs.unlinkSync(part); } catch { /* 尽力 */ }
        throw new Error(`sha256 校验失败(期望 ${item.sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…)`);
      }
    } else if (item.bytes != null && fs.statSync(part).size !== Number(item.bytes)) {
      const got = fs.statSync(part).size;
      try { fs.unlinkSync(part); } catch { /* 尽力 */ }
      throw new Error(`字节数不符(期望 ${item.bytes} 实得 ${got})`);
    }
    atomicRename(part, final);
    emit({ itemId: item.id, pct: 100, bytesDone: item.bytes ?? null, bytesTotal: item.bytes ?? null, phase: 'done' });
  }

  /** 单次尝试:Range 续传 + 流式落 .part + 校验 + 原子改名。 */
  function fetchOnce(item, url, part, final) {
    return new Promise((resolve, reject) => {
      (async () => {
        let startFrom = 0;
        try { startFrom = fs.existsSync(part) ? fs.statSync(part).size : 0; } catch { startFrom = 0; }
        // 已知期望大小且 .part 已满(或更大):不再发 Range,直接校验;坏件删掉重下
        if (startFrom > 0 && item.bytes != null && startFrom >= Number(item.bytes)) {
          try { await finalizeIfComplete(item, part, final); return resolve(); }
          catch (e) { startFrom = 0; }
        }
        const headers = startFrom > 0 ? { Range: `bytes=${startFrom}-` } : {};
        const { status, headers: rh, res, req } = await httpReq(url, { headers });
        active = { req, res };
        if (stopped()) { res.destroy(); return reject(new Error('aborted')); }
        let append = false;
        let bytesTotal = null;
        if (status === 206 && startFrom > 0) {
          append = true; // 服务端支持续传
          const cr = String(rh['content-range'] || '');
          const m = cr.match(/\/(\d+)\s*$/);
          bytesTotal = m ? Number(m[1]) : null;
          emit({ itemId: item.id, pct: 0, bytesDone: startFrom, bytesTotal: bytesTotal ?? item.bytes ?? null, phase: 'resume' });
        } else if (status === 200) {
          startFrom = 0; // 源不支持续传(或无 .part):整文件重下
          bytesTotal = Number(rh['content-length']) || item.bytes || null;
          emit({ itemId: item.id, pct: 0, bytesDone: 0, bytesTotal, phase: 'fetching' });
        } else if (status === 416 && startFrom > 0) {
          // 服务端认为 Range 越界(= .part 往往已完整);关连接后走本地校验,失败再删 .part 让外层重试整下
          res.destroy();
          try { await finalizeIfComplete(item, part, final); return resolve(); }
          catch (e) { return reject(e); }
        } else {
          res.destroy();
          return reject(new Error(`HTTP ${status}`));
        }
        if (bytesTotal == null) bytesTotal = item.bytes ?? null;
        const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
        let done = startFrom;
        let ended = false;
        let aborted = false; // 暂停/取消/连接错误已置位:在途 chunk 回调一律短路,不再写(将)销毁的流
        // ws 自毁(abortWs)后已排队 write 会异步报 ERR_STREAM_DESTROYED——那是我们主动丢弃尾部块的产物,非丢数据:
        // fs WriteStream 保序,destroy 只丢未落盘尾部 → .part 恒为真实内容的字节前缀,续传按 statSync(.part).size
        // 起跳,最终 sha256 是唯一放行门。真 IO 错(非 aborted,如 EPERM/盘满)则按失败拒收。
        ws.on('error', (e) => { if (!aborted) reject(e); });
        const abortWs = () => { aborted = true; try { ws.destroy(); } catch { /* 已关 */ } };
        res.on('data', (d) => {
          if (aborted) return; // 竞态短路:destroy 与在途 data 回调的窗口
          done += d.length;
          ws.write(d);
          throttled({ itemId: item.id, pct: bytesTotal ? Math.min(100, Math.floor((done / bytesTotal) * 100)) : null, bytesDone: done, bytesTotal, phase: append ? 'resume' : 'fetching' });
        });
        res.on('error', (e) => { abortWs(); reject(e); });
        res.on('close', () => {
          // 暂停/取消/连接中断:destroy 后只有 close(无 error/end),必须在这里收口,否则 promise 悬挂
          if (!ended) { abortWs(); reject(new Error(stopped() ? 'aborted' : 'connection closed')); }
        });
        res.on('end', () => {
          ended = true;
          ws.end(async () => {
            if (stopped()) return reject(new Error('aborted'));
            try {
              emit({ itemId: item.id, pct: 100, bytesDone: done, bytesTotal, phase: 'verify' });
              const got = await sha256File(part);
              if (got !== item.sha256.toLowerCase()) {
                try { fs.unlinkSync(part); } catch { /* 尽力 */ }
                return reject(new Error(`sha256 校验失败(期望 ${item.sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…)`));
              }
              atomicRename(part, final);
              emit({ itemId: item.id, pct: 100, bytesDone: done, bytesTotal, phase: 'done' });
              resolve();
            } catch (e) { reject(e); }
          });
        });
      })().catch(reject);
    });
  }

  /** ollama-pull 项:POST /api/pull NDJSON 流(status/pull 的 completed/total → 同一进度通道)。 */
  async function ollamaPullItem(item, { ollamaBase = DEFAULT_OLLAMA_BASE }) {
    control = { requested: null }; // 同上:直调入口不继承旧中止态
    const body = JSON.stringify({ model: item.model, stream: true });
    const { status, res, req } = await httpReq(`${ollamaBase}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      body,
    });
    active = { req, res };
    if (status !== 200) { res.destroy(); return { status: 'failed', error: `/api/pull HTTP ${status}` }; }
    let buf = '';
    res.setEncoding('utf8');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => { if (settled) return; settled = true; active = null; resolve(r); };
      res.on('data', (d) => {
        if (settled) return;
        if (stopped()) { try { res.destroy(); } catch { /* 已断 */ } return finish({ status: stopped() }); }
        buf += d;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let j = null;
          try { j = JSON.parse(line); } catch { continue; }
          if (j.error) { res.destroy(); return finish({ status: 'failed', error: String(j.error) }); }
          if (typeof j.completed === 'number' && typeof j.total === 'number' && j.total > 0) {
            throttled({ itemId: item.id, pct: Math.min(100, Math.floor((j.completed / j.total) * 100)), bytesDone: j.completed, bytesTotal: j.total, phase: 'pull' });
          }
          if (j.status === 'success') { res.destroy(); emit({ itemId: item.id, pct: 100, bytesDone: null, bytesTotal: null, phase: 'done' }); return finish({ status: 'ok' }); }
        }
      });
      res.on('error', () => finish(stopped() ? { status: stopped() } : { status: 'failed', error: '流中断' }));
      res.on('end', () => finish(stopped() ? { status: stopped() } : { status: 'failed', error: '流意外结束(未见 success)' }));
      // pause/cancel 的 destroy() 通常只触发 close、无 error/end → 必须在此收口,否则 Promise 悬挂
      res.on('close', () => {
        if (!settled) finish(stopped() ? { status: stopped() } : { status: 'failed', error: 'connection closed' });
      });
    });
  }

  /** 串行队列(C4):逐项下载;暂停/取消即停止后续项;每项结果回传。返回逐项结果数组。 */
  async function runQueue(items, { baseDir, ollamaBase } = {}) {
    control = { requested: null };
    const results = [];
    for (const item of items) {
      if (stopped()) { results.push({ itemId: item.id, status: stopped() }); break; }
      const r = item.type === 'ollama-pull'
        ? await ollamaPullItem(item, { ollamaBase })
        : await downloadFileItem(item, { baseDir, standalone: false });
      results.push({ itemId: item.id, ...r });
      if (r.status !== 'ok') break; // 失败/暂停/取消都停队列(失败重试由 UI 逐项发起)
    }
    return { results, stopped: stopped() };
  }

  return { runQueue, pause, cancel, downloadFileItem, ollamaPullItem, isStopped: () => control.requested };
}
