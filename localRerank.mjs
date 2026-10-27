/**
 * local 精排:Xenova/bge-reranker-base(q8,约 279MB)。
 * 只在 init.mjs --model-in local 时使用。常驻进程和本进程回退都会加载它,不访问 Ollama。
 * 查询与代码块成对输入,取单标签 logit 的 sigmoid 作为相关性(0~1)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { HF_CACHE_DIR } from './config.mjs';

/** transformers.js q8 权重是否已在 hf-cache。嵌入(jina)与精排(bge)共用。 */
export function localOnnxCached(modelId) {
  const file = path.join(HF_CACHE_DIR, ...String(modelId).split('/'), 'onnx', 'model_quantized.onnx');
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

async function loadOnce(modelId) {
  const { env, AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
  env.cacheDir = HF_CACHE_DIR;
  env.allowLocalModels = false;
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'q8' });
  return { tokenizer, model };
}

export async function loadLocalReranker(modelId, onWarn = console.error) {
  try {
    return await loadOnce(modelId);
  } catch (e) {
    onWarn(`[warn] HuggingFace 下载失败(${e.message}),切换 hf-mirror.com 重试...`);
    const { env } = await import('@huggingface/transformers');
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
