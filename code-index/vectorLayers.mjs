/**
 * 向量库分层路径与模型 slug(2026-11-10 抽取共享,供 modelRoute 与 decisionModel 共用)。
 * base=服务器下发整包(客户端只读),local=本地增量层;文件名按嵌入模型 slug 分文件,
 * 避免 local↔ollama 切换时互相覆盖。
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, loadConfig } from './config.mjs';
import { wantEmbedModel } from './vectorStore.mjs';

export const VECTORS_BASE_FILE = 'exemplars-vectors.base.json';       // 旧固定名(迁移期兼容读)
export const VECTORS_LOCAL_FILE = 'exemplars-vectors.local.json';     // 旧固定名(迁移期兼容读)
export const VECTORS_LEGACY_FILE = 'exemplars-vectors.json';          // 更早期单文件(迁移期兜底)

/** 当前嵌入模型全名(backend/model),层级指纹与内容键都用它。 */
export function currentEmbedModel() {
  // S1-F1(20261120 夜):后台/钩子路径一律 soft——坏 JSON 按默认档回落,不再 process.exit 击穿调用方
  const emb = wantEmbedModel(loadConfig({ soft: true }));
  return `${emb.backend}/${emb.model}`;
}

/** 模型名 → 文件名 slug(小写、非安全字符转 -,附 8 位哈希防清洗后碰撞)。 */
export function vectorsSlug(model) {
  const raw = String(model || '');
  const clean = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'default';
  const h = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${clean}-${h}`;
}

/** 指定模型的分层文件路径(按优先级:slug 文件 → 旧固定名 → legacy)。 */
export function vectorsLayerPaths(dataDir = DATA_DIR, model = null) {
  const m = model || currentEmbedModel();
  const slug = vectorsSlug(m);
  const dir = path.join(dataDir, 'routing');
  return {
    slug, model: m,
    base: { slugFile: path.join(dir, `exemplars-vectors.base.${slug}.json`), fixedFile: path.join(dir, VECTORS_BASE_FILE) },
    local: { slugFile: path.join(dir, `exemplars-vectors.local.${slug}.json`), fixedFile: path.join(dir, VECTORS_LOCAL_FILE), legacyFile: path.join(dir, VECTORS_LEGACY_FILE) },
  };
}