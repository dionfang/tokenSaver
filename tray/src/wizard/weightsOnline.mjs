/** 全在线模式 CPU 权重清单(2026-11-17 用户拍板:安装包只含基础依赖,三权重装后在线下载)。
 *  三源实测有效(hf-mirror HEAD 字节数确认):Xenova/jina-embeddings-v2-base-zh、
 *  Xenova/bge-reranker-base、onnx-community/strands-decider-2B-hobson-v19-ONNX。
 *  strands 为 external-data 分离格式:图(model_q4f16.onnx 0.5MB)+权重(model_q4f16.onnx_data
 *  1093105664B)须同目录(onnxruntime 自动解析 sibling _data);tokenizer.json 供 strandsAlign。
 *  jina/bge 落 transformers.js 缓存布局 Xenova/<name>/…(localResident env.cacheDir 同落点,
 *  且 localResident:73 已有 hf-mirror 回退,首用懒下载与本清单互为兜底)。
 *  urls 镜像优先(国内 HF 直连常被墙);sha256 不预置(HTTPS 完整性),大文件带 bytes 供续传/size 门。 */
const HF = 'https://huggingface.co/';
const MIR = 'https://hf-mirror.com/';
const u = (repo, p) => [`${MIR}${repo}/resolve/main/${p}`, `${HF}${repo}/resolve/main/${p}`];

export const WEIGHT_MODELS = [
  {
    key: 'embed', rowId: 'w-嵌入模型', label: '嵌入模型 jina-embeddings-v2-base-zh',
    files: [
      { remote: 'onnx/model_quantized.onnx', dest: 'Xenova/jina-embeddings-v2-base-zh/onnx/model_quantized.onnx', bytes: 161565239 },
      { remote: 'tokenizer.json', dest: 'Xenova/jina-embeddings-v2-base-zh/tokenizer.json', bytes: 2030772 },
      { remote: 'config.json', dest: 'Xenova/jina-embeddings-v2-base-zh/config.json' },
      { remote: 'tokenizer_config.json', dest: 'Xenova/jina-embeddings-v2-base-zh/tokenizer_config.json' },
    ],
    repo: 'Xenova/jina-embeddings-v2-base-zh',
  },
  {
    key: 'rerank', rowId: 'w-精排模型', label: '精排模型 bge-reranker-base',
    files: [
      { remote: 'onnx/model_quantized.onnx', dest: 'Xenova/bge-reranker-base/onnx/model_quantized.onnx', bytes: 279301077 },
      { remote: 'tokenizer.json', dest: 'Xenova/bge-reranker-base/tokenizer.json', bytes: 17098079 },
      { remote: 'config.json', dest: 'Xenova/bge-reranker-base/config.json' },
      { remote: 'tokenizer_config.json', dest: 'Xenova/bge-reranker-base/tokenizer_config.json' },
    ],
    repo: 'Xenova/bge-reranker-base',
  },
  {
    key: 'decision', rowId: 'w-决策模型', label: '决策模型 strands-decider-2B(q4f16)',
    files: [
      { remote: 'onnx/model_q4f16.onnx', dest: 'strands-decider-2B-hobson-v19/model_q4f16.onnx', bytes: 527999 },
      { remote: 'onnx/model_q4f16.onnx_data', dest: 'strands-decider-2B-hobson-v19/model_q4f16.onnx_data', bytes: 1093105664 },
      { remote: 'tokenizer.json', dest: 'strands-decider-2B-hobson-v19/tokenizer.json', bytes: 19989592 },
    ],
    repo: 'onnx-community/strands-decider-2B-hobson-v19-ONNX',
  },
];

/** 缺哪些模型(按 ENVCHECK 行 id 映射)。 */
export function missingModels(envChecks) {
  const bad = new Set((envChecks || []).filter((c) => String(c.id).startsWith('w-') && c.ok !== true).map((c) => c.id));
  return WEIGHT_MODELS.filter((m) => bad.has(m.rowId));
}

/** 逐模型逐文件下载(串行,单文件失败不阻断其余文件/模型;调用方收口后重跑自检)。 */
export async function downloadWeights({ models, downloader, baseDir, onLine = () => {} }) {
  const results = [];
  for (const m of models) {
    onLine(`[weights] 开始下载 ${m.label}`);
    for (const f of m.files) {
      const item = { id: `${m.key}:${f.remote}`, urls: u(m.repo, f.remote), dest: f.dest, bytes: f.bytes ?? null };
      const r = await downloader.downloadFileItem(item, { baseDir, standalone: false });
      results.push({ model: m.key, file: f.remote, status: r.status, error: r.error });
      onLine(r.status === 'ok' ? `[ok] ${m.key}/${f.remote}${r.skipped ? '(已存在跳过)' : ''}` : `[fail] ${m.key}/${f.remote}: ${r.error || r.status}`);
    }
  }
  return { ok: results.every((r) => r.status === 'ok'), results };
}
