/**
 * 发行钉扎自检(tray 方案 §16.5/§19.6-4,M5 2026-11-17):上传前必跑,任一不符拒绝封装。
 * 钉扎清单=构建期注入常量(dev 期与 TSServer build/allowlist.json 成对表同步;生产随签名 manifest 轮换)。
 * 运行态事实经 spawn `node code-index/pinFacts.mjs` 获取(托盘禁 import code-index,§18-E1)。
 * 零 electron、零 code-index import;纯函数判定 + 常量 pins。
 */

/** dev-pins(§19.4-②/§19.6-5):upload-2026Q4 公钥=服务器公钥(公开值);私钥只在服务器。
 *  decisionParamsSha256=代码默认档案表稳定哈希(server 层空);base 包带 profiles 后须随 manifest 轮换 pins。 */
export const UPLOAD_PINS = {
  dev: true,
  kid: 'upload-2026Q4',
  publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApQbU4Ia/vl8GBFhCbP9pMWZLO399aSB/KDUnxDSXxQsNVyLopcYnA4QvXHLbBmTVRCvsaUKnY2ap1PB63hgVNEOYww4yEZ2XGk2tpROJ8e2K255W6iRFWLIl+13ySVGaHuP4oJ2oMvgCpC2b6iO2uZenilZTB4/H4Uj670wzHRHxnWky7MjlsbDfPorKJAMeO63+VCiK7+uTgUL16CDvUrxl3NjAiRu5vq7++m/xLL1Uz8TmZd4xjO9H5aIEaBky5YLQ8UC42eJ14HN579PtyOdfJMAXrO5kvcEZ7uJdPD8F/qI+e8zHkpLdBzYTbzIWtUdl9WDJlaRRO/gANkT5SQIDAQAB',
  decisionParamsSha256: 'a74a5256656e6bad43220ebbd8221eb765f05ceddb52a3b24c4ee6a1e5ecff12',
  pairs: [
    { fp: 'ollama/qwen3-embedding:0.6b', dim: 1024, decisionModelVersion: 'tev1:0.8b' },
    { fp: 'local/Xenova/jina-embeddings-v2-base-zh', dim: 768, decisionModelVersion: 'strands:strands-decider-2B-hobson-v19:q4f16' },
  ],
};

/**
 * 钉扎比对(纯)。facts=pinFacts 微 CLI 输出。
 * @returns {ok:true, pair} | {ok:false, mismatches:[{field,expected,got}]}
 */
export function checkPins(facts, pins = UPLOAD_PINS) {
  const mismatches = [];
  const f = facts || {};
  if (Number(f.knnSchemaVersion) !== 1) mismatches.push({ field: 'knnSchemaVersion', expected: 1, got: f.knnSchemaVersion ?? null });
  if (f.decisionParamsSha256 !== pins.decisionParamsSha256) mismatches.push({ field: 'decisionParamsSha256', expected: pins.decisionParamsSha256, got: f.decisionParamsSha256 ?? null });
  const pair = (pins.pairs || []).find((p) => p.fp === f.embedModelSlug) || null;
  if (!pair) mismatches.push({ field: 'embedModelSlug', expected: (pins.pairs || []).map((p) => p.fp), got: f.embedModelSlug ?? null });
  else {
    if (Number(f.embedDim) !== Number(pair.dim)) mismatches.push({ field: 'embedDim', expected: pair.dim, got: f.embedDim ?? null });
    if (f.decisionModelVersion !== pair.decisionModelVersion) mismatches.push({ field: 'decisionModelVersion', expected: pair.decisionModelVersion, got: f.decisionModelVersion ?? null });
  }
  return mismatches.length ? { ok: false, mismatches } : { ok: true, pair };
}