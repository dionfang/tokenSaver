/**
 * 两套向量分开存放,切换 modelIn 不覆盖另一条路径:
 *   data/vectors/ollama/  embeddings.bin + chunks.paired.jsonl + meta.json
 *   data/vectors/local/   同上(transformers.js)
 * 块清单 data/chunks.jsonl 与 data/index.json 仍是切块产物,两条路径共用。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, loadConfig } from './config.mjs';
import { atomicWriteFileSync } from './proc.mjs';

export function activeBackend(cfg = null) {
  // S1-F1(20261120 夜):后台/钩子路径一律 soft——坏 JSON 按默认档回落,不再 process.exit 击穿调用方
  const c = cfg || loadConfig({ soft: true });
  return c.modelIn === 'local' ? 'local' : 'ollama';
}

/** 当前路径要嵌入的模型名(local 用 jina,ollama 用 config.models.embedding)。 */
export function wantEmbedModel(cfg = null) {
  const merged = cfg || loadConfig({ soft: true }); // S1-F1:soft 化(坏 JSON 回落默认档)
  const backend = activeBackend(merged);
  return { backend, model: backend === 'local' ? merged.models.localEmbedding : merged.models.embedding };
}

export function vectorPaths(backend) {
  const name = backend === 'local' ? 'local' : 'ollama';
  const dir = path.join(DATA_DIR, 'vectors', name);
  return {
    dir,
    emb: path.join(dir, 'embeddings.bin'),
    paired: path.join(dir, 'chunks.paired.jsonl'),
    meta: path.join(dir, 'meta.json'),
  };
}

export function readVectorMeta(backend) {
  try { return JSON.parse(fs.readFileSync(vectorPaths(backend).meta, 'utf8')); }
  catch { return null; }
}

export function writeVectorMeta(backend, meta) {
  const p = vectorPaths(backend);
  fs.mkdirSync(p.dir, { recursive: true });
  atomicWriteFileSync(p.meta, JSON.stringify(meta, null, 2));
}

/** 块清单 md5。读不到清单时返回 null。search 与 status 用它判断向量是否过期。 */
export function chunksSignature() {
  const chunksPath = path.join(DATA_DIR, 'chunks.jsonl');
  try {
    return crypto.createHash('md5').update(fs.readFileSync(chunksPath)).digest('hex');
  } catch { return null; }
}

/** meta 写了签名且与当前块清单不同。没有签名的旧向量不判过期。 */
export function vectorSignatureStale(meta) {
  if (!meta?.signature) return false;
  const sig = chunksSignature();
  return sig != null && sig !== meta.signature;
}

/** 配对快照与 embeddings.bin 是否逐位置自洽(块数×dim×4 = 字节数,±4 容差)。
 *  签名过期 ≠ 不可检索:快照自洽时 search 把语料切到快照继续向量检索(2026-11-11),
 *  这里是"快照可用"的单一判定源(search.mjs 内联同逻辑,因它本就要读快照记录)。 */
export function pairedSnapshotUsable(backend) {
  try {
    const meta = readVectorMeta(backend);
    if (!meta?.dim) return false;
    const pairedN = fs.readFileSync(vectorPaths(backend).paired, 'utf8').split('\n').filter(Boolean).length;
    if (!pairedN) return false;
    return Math.abs(fs.statSync(vectorPaths(backend).emb).size - pairedN * Number(meta.dim) * 4) <= 4;
  } catch { return false; }
}

/** 当前路径的向量是否还要对着现有块清单做一次嵌入(另一条路径不参与判断)。 */
export function vectorStoreNeedsEmbed(backend, wantModel) {
  const meta = readVectorMeta(backend);
  const emb = vectorPaths(backend).emb;
  if (!meta || meta.model !== wantModel || !fs.existsSync(emb)) return { need: true, meta };
  if (vectorSignatureStale(meta)) return { need: true, meta };
  // S12-C11(2026-11-10 落地):meta.dim 与 embeddings.bin 实际字节数自洽校验(f32le:pairedN*dim*4)。
  // 夜审实测:手改 meta.dim 后需要重嵌却照常放行 → 检索按错维切片,静默产出垃圾相似度。
  try {
    const pairedN = fs.readFileSync(vectorPaths(backend).paired, 'utf8').split('\n').filter(Boolean).length;
    const expectBytes = pairedN * Number(meta.dim) * 4;
    if (Math.abs(fs.statSync(emb).size - expectBytes) > 4) return { need: true, meta, reason: 'dim 与 embeddings.bin 字节数不符' };
  } catch { /* paired 清单缺失等场景:维持现行为 */ }
  return { need: false, meta };
}
