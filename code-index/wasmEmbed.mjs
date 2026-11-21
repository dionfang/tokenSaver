/**
 * wasmEmbed.mjs — 纯 wasm 嵌入后路(20261120 用户裁定修)。
 *
 * 背景:测试机(典型=安全软件注入环境)onnxruntime-node 原生 .node 在会话创建/推理必崩
 * (0xC0000005/静默死),transformers v4 node 构建无可用 wasm 后端,cpu 回退仍走原生库。
 * 本模块绕开 transformers 全家桶:tokenizers(原生分词,该类环境正常)+ onnxruntime-web
 * (纯 wasm,零 .node)直推 model_quantized.onnx → last_hidden_state → mask-aware mean
 * pooling + L2 normalize,与 transformers 的 pooling:'mean',normalize:true 同口径。
 * 仅服务「native 原生崩」标志时的嵌入后路;正常环境仍走原生高速路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const MAX_LEN = 500; // jina 8192 上限下保守截断;与短块匹配

function l2(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** 从 tokenizer.json 构造分词器(tokenizers node API:fromFile > fromString 兜底)。 */
function loadTokenizer(jsonPath) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  try { return req('tokenizers').Tokenizer.fromFile(jsonPath); }
  catch {
    try { return req('tokenizers').Tokenizer.fromString(JSON.stringify(data)); }
    catch (e) { throw new Error(`分词器加载失败:${e.message}`); }
  }
}

/**
 * 创建纯 wasm 嵌入器。返回 {dim, embed(texts)};失败抛错(调用方 fail-open 回 bm25)。
 * 单样本循环推理(后路定位=可用优先于吞吐);截断 MAX_LEN 防超长块。
 */
export async function createWasmEmbedder({ modelId, cacheDir, threads = 2 } = {}) {
  const ort = await import('onnxruntime-web');
  const modelDir = path.join(cacheDir, modelId);
  const bytes = fs.readFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx'));
  // wasm 资源路径指向 ort-web 包 dist(exports 不暴露 package.json,从主入口取目录)
  let distDir;
  try { distDir = path.join(path.dirname(req.resolve('onnxruntime-web/package.json')), 'dist'); }
  catch { distDir = path.dirname(req.resolve('onnxruntime-web')); }
  if (!fs.existsSync(path.join(distDir, 'ort-wasm-simd-threaded.jsep.mjs')) && !fs.existsSync(path.join(distDir, 'ort-wasm-simd-threaded.mjs'))) {
    throw new Error(`ort-web wasm 资源目录定位失败(${distDir} 无 ort-wasm*.mjs)`);
  }
  ort.env.wasm.wasmPaths = pathToFileURL(distDir + path.sep).href; // Windows node 下动态 import 后端 .mjs 只认 file:// URL(裸盘符路径报 ERR_UNSUPPORTED_ESM_URL_SCHEME)
  ort.env.wasm.numThreads = Math.max(1, Number(threads) || 1);
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const tok = loadTokenizer(path.join(modelDir, 'tokenizer.json'));
  const enc = await tok.encode('dim probe'); // tokenizers 0.23 encode()=thenable,不 await 拿到空壳(getIds 缺失→空序列→全零向量)
  const ids = Array.from(enc.getIds?.() ?? enc.ids ?? []);
  const mask = Array.from(enc.getAttentionMask?.() ?? ids.map(() => 1));
  const mk = (arr) => BigInt64Array.from(arr.map((x) => BigInt(x)));
  const feeds = { input_ids: new ort.Tensor('int64', mk(ids), [1, ids.length]), attention_mask: new ort.Tensor('int64', mk(mask), [1, mask.length]) };
  const out = await session.run(feeds);
  const entry = Object.entries(out).find(([, t]) => t.dims?.length === 3);
  if (!entry) throw new Error('last_hidden_state 缺失(输出名不识别)');
  const dim = entry[1].dims[2];
  return {
    model: modelId, dim,
    async embed(texts) {
      const rows = [];
      for (const t of texts) {
        const e = await tok.encode(String(t).slice(0, 4000));
        let i0 = Array.from(e.getIds?.() ?? e.ids ?? []);
        let m0 = Array.from(e.getAttentionMask?.() ?? i0.map(() => 1));
        if (i0.length > MAX_LEN) { i0 = i0.slice(0, MAX_LEN); m0 = m0.slice(0, MAX_LEN); }
        const f = { input_ids: new ort.Tensor('int64', mk(i0), [1, i0.length]), attention_mask: new ort.Tensor('int64', mk(m0), [1, m0.length]) };
        const r = await session.run(f);
        const hs = r[entry[0]].data; // Float32Array [1, seq, dim]
        const seq = m0.length; const v = new Float32Array(dim);
        for (let s = 0; s < seq; s++) if (m0[s]) for (let d = 0; d < dim; d++) v[d] += hs[s * dim + d];
        rows.push(l2(v));
      }
      return rows;
    },
  };
}