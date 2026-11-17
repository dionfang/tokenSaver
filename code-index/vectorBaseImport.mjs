#!/usr/bin/env node
/**
 * 服务器 KNN 包导入器(v3 方案 §5.1 客户端侧,2026-11-14):
 *   把服务器清洗产出的 BASE 包落进向量库 **base 层**(`exemplars-vectors.base.<slug>.json`,客户端只读;
 *   local 层为本地增量,loadVectors 双层合并、同 pkey local 优先、authority 控制标签权威)。
 *
 * BASE 包格式(两种皆收):
 *   ① doc 形(与向量库同构,推荐):{ model, dim, builtAt, source?, vectors: { <pkey>: { v:[...], label, rule?, domain? } } }
 *   ② 分件形:pack.meta.json({model,dim,builtAt}) + pack.vectors.jsonl(每行 {pkey,label,v,rule?,domain?})
 * 校验(四防线同源哲学):指纹(model 须===当前嵌入模型,不符**整包拒收**)、dim 一致、label 值域白名单、v 长度、pkey 非空。
 * 结构级验收:条数/拒绝原因/近重复率(与本地层 cosine≥0.98 条目数)/导入后 layers 状态;
 *   语义级验收(双轴 acc 并入前后对比)用 `scoreGoldenDual` 手工跑,提示见输出。
 *
 * 跑法:node vectorBaseImport.mjs --import <pack.json|pack.meta.json 所在目录> [--data <dataDir>]
 * 服务器上传/下发协议未建(plan §5.1,外部系统)——本工具只吃**已落在本地**的包文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { vectorsLayerPaths, currentEmbedModel } from './vectorLayers.mjs';
import { loadVectors } from './modelRoute.mjs';

const LABEL_RE = /^(multi|routine|light)$/i;
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};
const atomicWrite = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true }); // 首装 dataDir 可能无 routing/(2026-11-17 M4 审查)
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};

/** 解析 pack → { model, dim, builtAt, vectors } 或 { error }。 */
export function parsePack(input) {
  try {
    const st = fs.statSync(input);
    if (st.isDirectory()) {
      const metaF = path.join(input, 'pack.meta.json');
      const jsonlF = path.join(input, 'pack.vectors.jsonl');
      const meta = JSON.parse(fs.readFileSync(metaF, 'utf8'));
      const vectors = {};
      for (const line of fs.readFileSync(jsonlF, 'utf8').split('\n').filter(Boolean)) {
        const r = JSON.parse(line);
        vectors[String(r.pkey)] = { v: r.v, label: r.label, rule: r.rule, domain: r.domain };
      }
      return { model: meta.model || meta.embeddingModel, dim: Number(meta.dim) || 0, builtAt: meta.builtAt || null, source: meta.source || 'server-pack', vectors };
    }
    const doc = JSON.parse(fs.readFileSync(input, 'utf8'));
    if (!doc || typeof doc.vectors !== 'object') return { error: 'doc 形 pack 缺 vectors 对象' };
    return { model: doc.model || doc.embeddingModel, dim: Number(doc.dim) || 0, builtAt: doc.builtAt || null, source: doc.source || 'server-pack', vectors: doc.vectors };
  } catch (e) {
    return { error: `pack 不可读:${e.message}` };
  }
}

/** 导入:校验 → 落 base 层 → 结构级验收报告。 */
export function importServerPack({ packPath, dataDir = DATA_DIR } = {}) {
  const parsed = parsePack(packPath);
  if (parsed.error) return { ok: false, error: parsed.error };
  const want = currentEmbedModel();
  // 四防线①指纹:不符整包拒收(绝不与本地库混存,防语义空间污染)
  if (parsed.model !== want) return { ok: false, error: `指纹不符:pack.model=${parsed.model} ≠ 当前嵌入 ${want} —— 整包拒收(重嵌后重试)` };
  // loadVectors 无 base/local 时返回 null(首装/新 dataDir/切模式未重嵌)——2026-11-17 M4 实弹审查根因:
  // 直读 .vectors 抛 TypeError 致导入崩溃;空本地层按空库处理(近重复检测自然跳过)。
  const localLayer = loadVectors(dataDir) || { vectors: {}, dim: 0, layers: { local: false } };
  const dim = Number(parsed.dim) || (localLayer.dim || 0);
  const accept = {}, reject = { fingerprint: 0, label: 0, dim: 0, pkey: 0 };
  for (const [pkey, e] of Object.entries(parsed.vectors || {})) {
    if (!pkey || !e || !Array.isArray(e.v)) { reject.pkey += 1; continue; }
    if (!LABEL_RE.test(String(e.label || ''))) { reject.label += 1; continue; }
    if (dim && e.v.length !== dim) { reject.dim += 1; continue; }
    accept[String(pkey)] = { v: e.v, label: String(e.label).toLowerCase(), rule: e.rule || null, domain: e.domain || 'server', src: 'server-pack' };
  }
  // 结构级验收:近重复检测(pack 条目 vs 本地层 cosine≥0.98)
  let nearDup = 0;
  const localVecs = Object.values(localLayer.vectors || {}).map((e) => e.v);
  const sample = Object.values(accept).slice(0, 200);
  for (const e of sample) for (const lv of localVecs) { if (cosine(e.v, lv) >= 0.98) { nearDup += 1; break; } }
  // 落 base 层(slug 文件,原子写)
  const paths = vectorsLayerPaths(dataDir, parsed.model);
  const doc = { version: 1, model: parsed.model, dim, builtAt: parsed.builtAt || new Date().toISOString(), source: parsed.source, authority: 'base', ok: Object.keys(accept).length, vectors: accept };
  atomicWrite(paths.base.slugFile, JSON.stringify(doc));
  // 导入后状态
  const merged = loadVectors(dataDir, { model: parsed.model }) || { vectors: {}, layers: null };
  return {
    ok: true, baseFile: paths.base.slugFile,
    accepted: Object.keys(accept).length, rejected: reject, nearDupSample: nearDup,
    localEntries: Object.keys(localLayer.vectors || {}).length,
    mergedEntries: Object.keys(merged.vectors || {}).length,
    layers: merged.layers || { base: true, local: !!(localLayer.layers ? localLayer.layers.local : true) },
    hint: '语义级验收:并入前后各跑一次黄金集双轴打分(scoreGoldenDual),语义轴 acc 不降才转正;回滚=删除 base 层文件。',
  };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); // S14-P3(2026-11-14):fileURLToPath 自带解码(旧 pathname 手法遇空格/中文路径恒 false)
if (directRun) {
  const has = (f) => process.argv.includes(f);
  const val = (f) => (has(f) ? process.argv[process.argv.indexOf(f) + 1] : null);
  if (!has('--import') || !val('--import')) {
    console.error('用法:node vectorBaseImport.mjs --import <pack.json | pack 目录> [--data <dataDir>]');
    process.exit(1);
  }
  const r = importServerPack({ packPath: val('--import'), dataDir: val('--data') || DATA_DIR });
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 1);
}
