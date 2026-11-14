#!/usr/bin/env node
/**
 * 模型预热:按 init.mjs --model-in 选定的嵌入路径加载模型。
 *   ollama —— 探测已开的 Ollama(绝不拉起服务)并加载嵌入模型 + 精排 + 本地决策模型(models.decision)。
 *             keep_alive 与嵌入 num_ctx 用 config.mjs 的同一组,避免后续请求把驻留改短或触发重载。
 *   local  —— 分离常驻进程加载 jina、bge 精排与本地决策模型(models.localDecision,ONNX)。本脚本退出后
 *             模型仍留在该进程,后续检索和嵌入复用,空闲时限与 Ollama keep_alive 相同。
 * 嵌入或精排任一没拉起则以失败退出,检索降级 bm25,不改换另一条路径(决策模型拉不起只提示,不拖垮预热)。
 * 可手动运行。会话 hook 调用的是 auto.mjs,由它再调用本脚本。
 * 注意:日志走 stderr、stdout 保持空——hook 机制会把 stdout 当严格 JSON 解析,非空即判失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureOllama, resolveBase, gpuOptions, resolveGpuMode, ensureModelPlacement, releaseReplacedOllamaModels, rememberWarmedModels } from './ollamaGuard.mjs';
import { loadConfig, DATA_DIR, OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX, decisionLocalWanted } from './config.mjs';
import { loadLocalReranker, scorePair } from './localRerank.mjs';
import { warmDecisionModel } from './localDecision.mjs';
import { ensureLocalResident, stopLocalResident } from './localResident.mjs';
import { registerWarmed } from './warmedRegistry.mjs';
import { embedBusy } from './embedGate.mjs'; // S4-F3(2026-11-11 夜审):busy 判定单源化
import { pidAlive } from './proc.mjs';

const cfg = loadConfig();
const MODELS_CFG = cfg.models;
const backend = cfg.modelIn === 'local' ? 'local' : 'ollama';
const base = resolveBase();

// S4-F3(2026-11-11 夜审):busy 判定单源化——本地副本已删,统一走 embedGate.embedBusy
// (embed.mjs 同口径:pid+TTL 双条件,死 pid/超时陈旧锁一律视为空闲)。

const t0 = Date.now();
let embedOk = false;
let rerankOk = false;
if (backend === 'local') {
  if (embedBusy()) {
    embedOk = true;
    console.error('[info] 嵌入进程正在加载 local 模型,预热不另起常驻进程');
    try {
      const { tokenizer, model } = await loadLocalReranker(MODELS_CFG.localReranker);
      await scorePair(tokenizer, model, 'warm', 'warm');
      rerankOk = true;
      console.error(`[ok] ${MODELS_CFG.localReranker} 可加载;嵌入结束后的预热会把它留在常驻进程`);
    } catch (e) {
      console.error(`[fail] local 精排模型拉起失败(${e.message}),精排将跳过`);
    }
  } else {
    const health = await ensureLocalResident(console.error, { retryDecision: true });
    embedOk = !!health?.embedOk;
    rerankOk = !!health?.rerankOk;
    if (embedOk) console.error(`[ok] ${MODELS_CFG.localEmbedding} 已留在常驻进程(不依赖 Ollama)`);
    else console.error(`[fail] local 嵌入模型拉起失败,检索将降级 bm25`);
    if (rerankOk) console.error(`[ok] ${MODELS_CFG.localReranker} 已留在常驻进程`);
    else console.error(`[fail] local 精排模型拉起失败,精排将跳过`);
    if (!decisionLocalWanted()) console.error('[info] 决策模型走显式远程/开关关,常驻不加载本地决策模型');
    else if (health?.decisionOk) console.error(`[ok] ${MODELS_CFG.localDecision} 已留在常驻进程(本地决策判定)`);
    else console.error(`[warn] local 决策模型未就绪,决策票将弃权(fail-open;首次使用会下载权重,可重跑 warm 探测)`);
  }
  if (embedOk && rerankOk) {
    await releaseReplacedOllamaModels([], console.error);
    rememberWarmedModels({ backend: 'local', embedding: MODELS_CFG.localEmbedding, reranker: MODELS_CFG.localReranker, decision: decisionLocalWanted() ? MODELS_CFG.localDecision : null });
    // 登记到预热登记表:切换模型后靠它认出"切换前拉起的那几个"并卸掉(只增不减)
    registerWarmed({ backend: 'local', embedding: MODELS_CFG.localEmbedding, reranker: MODELS_CFG.localReranker, decision: decisionLocalWanted() ? MODELS_CFG.localDecision : null });
  }
} else {
  const g = await ensureOllama({ base, onInfo: console.error });
  if (!g.up) {
    console.error('[fail] Ollama 嵌入路径不可用(不自动拉起服务,也不改换 local),检索将降级 bm25');
    process.exit(1);
  }
  await stopLocalResident();
  const gpu = resolveGpuMode();
  console.error(`[gpu] ${gpu.reason}`);
  const decisionWanted = decisionLocalWanted();
  const keep = decisionWanted ? [MODELS_CFG.embedding, MODELS_CFG.reranker, MODELS_CFG.decision] : [MODELS_CFG.embedding, MODELS_CFG.reranker];
  await releaseReplacedOllamaModels(keep, console.error);
  await ensureModelPlacement(keep, console.error);
  try {
    const e = await fetch(`${base}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODELS_CFG.embedding, input: ['warm'], options: { num_ctx: OLLAMA_NUM_CTX, ...gpuOptions() }, keep_alive: OLLAMA_KEEP_ALIVE }),
      signal: AbortSignal.timeout(240000), // 首装冷加载可数分钟;超时=服务半挂,直接判失败(2026-11-10 审计修复)
    });
    embedOk = e.ok;
    console.error(e.ok ? `[ok] ${MODELS_CFG.embedding} 已加载(${gpu.mode.toUpperCase()})`
      : `[warn] 嵌入模型预热失败 HTTP ${e.status}${e.status === 404 ? `(${MODELS_CFG.embedding} 未安装,请手工执行: ollama pull ${MODELS_CFG.embedding})` : ''}`);
  } catch (e) { console.error('[warn] 嵌入模型预热异常:', e.message); }
  try {
    const r = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODELS_CFG.reranker,
        prompt: 'yes', raw: true, stream: false, think: false,
        options: { num_predict: 1, ...gpuOptions() }, keep_alive: OLLAMA_KEEP_ALIVE,
      }),
      signal: AbortSignal.timeout(240000), // 同嵌入:冷加载可慢,服务半挂才该判败(2026-11-10 审计修复)
    });
    rerankOk = r.ok;
    console.error(r.ok ? `[ok] ${MODELS_CFG.reranker} 已加载(${gpu.mode.toUpperCase()})`
      : `[warn] 精排模型预热失败 HTTP ${r.status}${r.status === 404 ? `(${MODELS_CFG.reranker} 未安装,请手工执行: ollama pull ${MODELS_CFG.reranker})` : ''}`);
  } catch (e) { console.error('[warn] 精排模型预热异常:', e.message); }
  if (decisionWanted) {
    // decision 能力模型(tev1:0.8b)只吃 systemone 端点:/api/generate 会被 Ollama 直接拒("does not support generate"),
    // 用 /api/generate 预热永远拉不起 → 模型不驻留 → 状态句误报"未拉起"。
    const d = await warmDecisionModel({ base, model: MODELS_CFG.decision });
    console.error(d.ok ? `[ok] ${MODELS_CFG.decision} 已加载(本地决策判定,${gpu.mode.toUpperCase()})`
      : `[warn] 决策模型预热失败(${d.error})${d.status === 404 ? `(${MODELS_CFG.decision} 未安装,请手工执行: ollama pull ${MODELS_CFG.decision})` : ''}`);
  } else {
    console.error('[info] 决策模型走显式远程/开关关,不预热本地决策模型');
  }
  if (embedOk && rerankOk) {
    rememberWarmedModels({ backend: 'ollama', embedding: MODELS_CFG.embedding, reranker: MODELS_CFG.reranker, decision: decisionWanted ? MODELS_CFG.decision : null });
    // 登记到预热登记表:切换模型后靠它认出"切换前拉起的那几个"并卸掉(只增不减)
    registerWarmed({ backend: 'ollama', embedding: MODELS_CFG.embedding, reranker: MODELS_CFG.reranker, decision: decisionWanted ? MODELS_CFG.decision : null });
  }
}

console.error(`[done] 预热完成,耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
// 嵌入或精排没拉起 → 失败退出。状态句以 modelStatus 的现场判定为准,不单凭这个退出码。
// A(2026-11-14 用户定案):预热收尾当场跑一次真实健康评估——assessModelStatus 内部会写健康缓存,
// 消除"预热把模型拉回、状态句还吃最长 5 分钟陈旧'未拉起'快照"的空窗;下轮状态句立即翻正。
if (embedOk && rerankOk) {
  try {
    const { assessModelStatus } = await import('./modelStatus.mjs');
    await assessModelStatus();
  } catch { /* 缓存刷新失败不影响预热结果 */ }
}
process.exit(embedOk && rerankOk ? 0 : 1);
