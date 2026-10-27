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

export function activeBackend() {
  return loadConfig().modelIn === 'local' ? 'local' : 'ollama';
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
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2));
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

/** 当前路径的向量是否还要对着现有块清单做一次嵌入(另一条路径不参与判断)。 */
export function vectorStoreNeedsEmbed(backend, wantModel) {
  const meta = readVectorMeta(backend);
  const emb = vectorPaths(backend).emb;
  if (!meta || meta.model !== wantModel || !fs.existsSync(emb)) return { need: true, meta };
  if (vectorSignatureStale(meta)) return { need: true, meta };
  return { need: false, meta };
}
