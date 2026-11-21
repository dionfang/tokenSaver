/**
 * local 精排:Xenova/bge-reranker-base(q8,约 279MB)。
 * 只在 init.mjs --model-in local 时使用。常驻进程和本进程回退都会加载它,不访问 Ollama。
 * 查询与代码块成对输入,取单标签 logit 的 sigmoid 作为相关性(0~1)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { HF_CACHE_DIR } from './config.mjs';
import { onnxWeightsJson } from './onnxWeights.mjs';

/** 权重是否已在 hf-cache 且字节数完整(20261120 测试机回归:双写竞态/懒下载中断留半截文件,
 *  存在性门放过→onnx 原生崩 0xC0000005、探针误判静默死)。期望字节单源 onnx-weights.json
 *  (S14-F3 20261120 夜:原三处字面量双写收敛;tray weightsOnline 字面量由 embedProbe.test 三方一致性门对账);
 *  strands 为 q4f16 external-data 双件(图 528KB+同目录 _data 1.09GB,缺一不可)。
 *  未知模型(清单外)维持旧口径:存在且非零。 */
const WEIGHTS = onnxWeightsJson();
const ONNX_BYTES = Object.fromEntries(Object.entries(WEIGHTS).filter(([k]) => !k.startsWith('strands:')));
const STRANDS_BYTES = WEIGHTS['strands:strands-decider-2B-hobson-v19'] || {};

export function localOnnxCached(modelId) {
  const s = String(modelId);
  if (s.startsWith('strands:')) {
    const dir = path.join(HF_CACHE_DIR, s.slice('strands:'.length));
    return Object.entries(STRANDS_BYTES).every(([f, n]) => {
      try { return fs.statSync(path.join(dir, f)).size === n; } catch { return false; }
    });
  }
  const expect = ONNX_BYTES[s];
  const dir = path.join(HF_CACHE_DIR, ...s.split('/'));
  if (!expect) {
    try { return fs.statSync(path.join(dir, 'onnx', 'model_quantized.onnx')).size > 0; } catch { return false; }
  }
  return Object.entries(expect).every(([f, n]) => {
    try { return fs.statSync(path.join(dir, f)).size === n; } catch { return false; }
  });
}

async function loadOnce(modelId) {
  const { env, AutoTokenizer, AutoModelForSequenceClassification } = await (await import('./transformersLoader.mjs')).loadTransformers();
  env.cacheDir = HF_CACHE_DIR;
  env.allowLocalModels = true; // S4-F2(20261120 夜):与 2026-11-19 embed 修同口径统一——本地 cacheDir 命中优先,离线/受限网络不强制远端解析
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'q8' });
  return { tokenizer, model };
}

export async function loadLocalReranker(modelId, onWarn = console.error) {
  try {
    return await loadOnce(modelId);
  } catch (e) {
    onWarn(`[warn] HuggingFace 下载失败(${e.message}),切换 hf-mirror.com 重试...`);
    const { env } = await (await import('./transformersLoader.mjs')).loadTransformers();
    env.remoteHost = 'https://hf-mirror.com';
    return await loadOnce(modelId);
  }
}

function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const z = Math.exp(x);
  return z / (1 + z);
}

/** 单条相关性。bge-reranker-base 只有 1 个标签,logit 越大越相关。 */
export async function scorePair(tokenizer, model, query, doc) {
  const inputs = await tokenizer(query, {
    text_pair: doc,
    truncation: true,
    max_length: 512,
  });
  const { logits } = await model(inputs);
  const data = logits?.data;
  if (!data?.length) throw new Error('精排输出缺少 logits');
  return sigmoid(Number(data[0]));
}
