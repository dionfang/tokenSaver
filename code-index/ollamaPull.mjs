#!/usr/bin/env node
/**
 * ollama 模型拉取微 CLI(tray 方案 §16.12-7/M3,2026-11-17):
 *   node ollamaPull.mjs [model ...]     # 缺省=配置三件套(决策开关关时不含决策);只拉未安装的
 * stdout 行契约(托盘/调用方解析):
 *   [skip] <model>(已安装) / [progress] 拉取 <model> <pct>% / [ok] <model> / [fail] <model>: <原因>
 * exit 0=全部成功(含跳过);1=任一失败。单模型失败不阻断其余(B2 口径)。
 * 防挂死:120s 无进度即 abort(S14-F1 同口径,有进度续命);/api/pull NDJSON 流式真百分比。
 * 纯函数 pullMissing 依赖注入 fetchFn/onLine,可单测(假 http 源);不 import tray/**。
 */
import path from 'node:path';
import { loadConfig, decisionLocalWanted } from './config.mjs';
import { resolveBase, sameOllamaName } from './ollamaGuard.mjs';

/** 拉取缺失模型。返回 { ok, results:[{model,status:'ok'|'skipped'|'failed',error?}] }。 */
export async function pullMissing({ models, base = resolveBase(), fetchFn = fetch, onLine = () => {}, stallMs = 120_000 } = {}) {
  const results = [];
  let installed = null;
  try {
    const r = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) installed = ((await r.json()).models || []).map((m) => m.name);
  } catch { /* 服务不可达 → 全部尝试拉取,失败逐条报 */ }
  for (const name of models || []) {
    if (installed && installed.some((n) => sameOllamaName(n, name))) {
      results.push({ model: name, status: 'skipped' });
      onLine(`[skip] ${name}(已安装)`);
      continue;
    }
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(new Error(`拉取超时(${Math.round(stallMs / 1000)}s 无进度)`)), stallMs);
    try {
      const resp = await fetchFn(`${base}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal: ac.signal });
      if (!resp.ok || !resp.body) { results.push({ model: name, status: 'failed', error: `HTTP ${resp.status}` }); onLine(`[fail] ${name}: HTTP ${resp.status}`); continue; }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '', lastPct = -1, okLine = false, errMsg = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(timer); timer = setTimeout(() => ac.abort(new Error(`拉取超时(${Math.round(stallMs / 1000)}s 无进度)`)), stallMs);
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j.error) { errMsg = j.error; continue; }
            if (j.total && j.completed != null) {
              const pct = Math.floor((j.completed / j.total) * 100);
              if (pct !== lastPct) { lastPct = pct; onLine(`[progress] 拉取 ${name} ${pct}%`); }
            } else if (j.status === 'success') okLine = true;
          } catch { /* 半行,等下一段 */ }
        }
      }
      if (errMsg) { results.push({ model: name, status: 'failed', error: errMsg }); onLine(`[fail] ${name}: ${errMsg}`); }
      else if (okLine) { results.push({ model: name, status: 'ok' }); onLine(`[ok] ${name}`); }
      else { results.push({ model: name, status: 'failed', error: '流结束未确认 success' }); onLine(`[fail] ${name}: 流结束未确认 success`); }
    } catch (e) {
      const msg = String(e?.message || e);
      results.push({ model: name, status: 'failed', error: msg });
      onLine(`[fail] ${name}: ${msg}`);
    } finally { clearTimeout(timer); }
  }
  return { ok: results.every((r) => r.status !== 'failed'), results };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (directRun) {
  const cfg = loadConfig();
  const models = process.argv.slice(2).length ? process.argv.slice(2)
    : [cfg.models.embedding, cfg.models.reranker, ...(decisionLocalWanted() ? [cfg.models.decision] : [])];
  const r = await pullMissing({ models, onLine: (l) => console.log(l) });
  process.exit(r.ok ? 0 : 1);
}
