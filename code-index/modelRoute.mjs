/**
 * 动态模型路由核心(model-routing.md #9/#7/#8;学名「动态模型路由」):
 *   L2 向量分类 --build-vectors 构建 + cosine kNN(影子模式,只写 shadow 日志;**恒开**(2026-11-14 用户裁定)——
 *     历史口径备档:2026-11-01 实测此前所有入口都不传 embedFn,L2 从未运行过,故当时做成显式开关
 *     (--l2 / modelRouting.l2Shadow=true 才通电);现 l2ShadowEnabled 恒 true,开关键不再读取)
 *   L3 已取消(2026-11-03 用户定档:语义兜底由四档分档承担)——级联收敛为 L1→L2
 *   四档链派生 deriveTierChains(快照按 tierOfModel 分桶,档内品牌优先序+档位序数排序)
 *     + 级联解析 resolveTier(目标档起 R4→R3→R2→R1 逐档下滑;档内解析复用 resolveRole:
 *       裸名/家族匹配/@pin/"default"/providerPriority/健康冷却)
 *   健康冷却 model-health.json(--health-mark/--health-clear/--health-list)
 *   doctor --doctor(门控/四档链/inventory/健康/L2 状态逐项报告)
 * 独立模块:不改任何既有代码;prompt-guard 的 L1 注入路径与本模块解耦(L2/L3 走 shadow 日志)。
 * role 两档制已废(2026-11-03 用户终裁:tier 四档难度制唯一;deriveRoleChains/roles 映射随 routeMode 删除,
 * resolveRole 保留为通用链解析器,resolveTier 每档内复用)。
 * CLI:node modelRoute.mjs --build-vectors | --classify [--l2] "<prompt>" | --resolve --tier R3 [--current p/m]
 *      | --score-golden [--golden 文件] | --score-golden-dual [--golden 文件] | --doctor | --health-mark <provider/model> [--reason x] [--ttl 30m] | --health-clear <key> | --health-list
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, CONFIG_PATH, loadConfig, OLLAMA_KEEP_ALIVE } from './config.mjs';
import { L2_LAYER_WEIGHTS as THRESHOLD_L2_LAYER_WEIGHTS } from './thresholds.mjs'; // S14-F4(20261118):层权重单源
import { atomicWriteFileSync, takeJsonLock as procTakeJsonLock, releaseJsonLock as procReleaseJsonLock } from './proc.mjs';
import { normalizeType, L1_TYPES, classifyPrompt } from './classify.mjs';
import { classifyDifficulty, loadTierCalibration, TIER_FROM_TYPE } from './tierClassify.mjs';
import { tierTruthFromAxes } from './tierTruth.mjs';
import { promptKey, SEMANTIC_AXIS, INTENSITY_AXIS } from './buildExemplars.mjs'; // 双轴常量已下沉至 buildExemplars(不再反向依赖 autoLabel)
import { resolveZcodeV2Dir } from './virtualProvider.mjs'; // doctor 库存走 v2Dir 配置制(与快照同源,无循环)

const HOME = os.homedir();
// 向量库分层(2026-11-10 分发架构):base=服务器下发整包(客户端**只读**),local=本地增量层。
// 路径/slug 共享逻辑已抽到 vectorLayers.mjs(modelRoute 与 decisionModel 共用);此处只保留读写。
import { currentEmbedModel, vectorsSlug, vectorsLayerPaths } from './vectorLayers.mjs';
export { vectorsSlug, vectorsLayerPaths } from './vectorLayers.mjs';
const HEALTH_PATH = path.join(DATA_DIR, 'model-health.json');
const L2_MIN_SIM = 0.55;
const L2_MIN_CONF = 0.6; // 2026-11-02:与 init 骨架/本机配置对齐(黄金集扫描定档:0.6 覆盖 15/50 准确 93%;0.75 只覆盖 6/50)
const TYPES = ['multi', 'routine', 'light'];

const TYPE_DEFS = {
  multi: '多点改组(重构/迁移/批量/方案,建议档 R2)', routine: '例行工作(报错/单点编辑/审查/测试)',
  light: '询问杂务(问答/文档/chore)',
};

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// ---------- L2 向量分类 ----------

export function cosine(a, b) {
  // 2026-11-17 修(PU-001 验证中发现):decodeLayer 解出的向量是 Float32Array,旧 Array.isArray 守卫
  // 使其恒返 0 ⇒ 生产合并库上 knnClassify 恒 null(L2 票自 v_b64 编码落地起死票)。改为接受数组+TypedArray。
  const vec = (x) => !!x && typeof x.length === 'number' && x.length > 0 && (Array.isArray(x) || ArrayBuffer.isView(x));
  if (!vec(a) || !vec(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

const normPromptForKey = (p) => String(p || '').replace(/\s+/g, ' ').trim().toLowerCase();
/** 跨端内容键:sha256(model|完整归一 prompt) 前 24 hex。
 *  不用 promptKey(32 位 + 截 400 字,长 prompt 会碰键);base 包只带 key,不需原文(隐私)。 */
export function vectorKeyOf(prompt, model = null) {
  return crypto.createHash('sha256').update(`${model || currentEmbedModel()}|${normPromptForKey(prompt)}`).digest('hex').slice(0, 24);
}

// ---------- 向量编码(2026-11-10 省体积):Float32 + base64,约比十进制文本小 4 倍 ----------
/** 数组 → base64(Float32LE)。 */
export function encodeVector(arr) {
  const f = Float32Array.from(arr);
  const buf = Buffer.allocUnsafe(f.length * 4);
  for (let i = 0; i < f.length; i += 1) buf.writeFloatLE(f[i], i * 4);
  return buf.toString('base64');
}
/** base64 → Float32Array(长度按字节数整除 4)。 */
export function decodeVector(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  const len = Math.floor(buf.byteLength / 4);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) out[i] = buf.readFloatLE(i * 4);
  return out;
}
/** 条目取向量:兼容 v(旧明文数组/f32 数组)与 v_b64(base64)。 */
function entryVector(e) {
  if (!e || typeof e !== 'object') return null;
  if (Array.isArray(e.v) && e.v.length) return e.v;
  if (e.v_b64) { const v = decodeVector(e.v_b64); return v.length ? v : null; }
  return null;
}
/** 整层解码:把 v_b64 统一成 v(Float32Array),丢弃 b64 串以省内存;consumer 无需感知格式。 */
function decodeLayer(doc) {
  if (!doc || !doc.vectors) return doc;
  const vectors = {};
  for (const [k, e] of Object.entries(doc.vectors)) {
    const v = entryVector(e);
    vectors[k] = v ? { label: e.label, rule: e.rule || '', pkey: e.pkey || null, v } : { ...e };
  }
  return { ...doc, vectors };
}
let _vectorsCache = { key: '', data: null };
function readFirstExisting(paths = []) {
  for (const p of paths) { if (!p) continue; const d = readLayerPath(p); if (d) return d; }
  return null;
}
function readLayerPath(file) {
  const d = readJson(file);
  return d && d.vectors && typeof d.vectors === 'object' ? d : null;
}

/**
 * 向量库构建(2026-11-10 分层改造):只写 local 增量层,**永不覆盖 base**。
 *   - base 层 key 命中 → 复用向量(不嵌入);authority='local'(默认,= 项目当前自签模式)时,
 *     同键本地标签以 overrides 记录,加载时覆盖 base 标签;authority='base' 则保留服务器清洗结果。
 *   - 未命中 → 先复用本地上次向量(同模型),再嵌入 miss;已不在样本集的 local 条目自动裁剪。
 *   - 模型不一致:base/旧 local 均不复用,按当前模型重建 local(防 768/1024 混维)。
 * 返回 {ok(本地条目数), embedded, reusedBase, reusedLocal, fail, dim, model, out}。
 */
export async function buildVectors({ dataDir = DATA_DIR, embedFn, failFast = false, authority = null, model = null } = {}) {
  const exPath = path.join(dataDir, 'routing', 'exemplars.json');
  const ex = readJson(exPath);
  const want = model || currentEmbedModel(); // 可显式指定(测试/服务器离线构建);缺省跟运行配置
  if (!ex || !Array.isArray(ex.exemplars) || !ex.exemplars.length) {
    // 2026-11-19 修(测试机 0.2.1「立即同步」报错[err]样本库缺失或为空):空样本库=无事可做,不再硬失败——
    // 全新装机尚无代签样本属正常态;存量 local 层保留不动(空样本绝不覆盖现有向量库)。
    const p0 = vectorsLayerPaths(dataDir, want);
    const old0 = readFirstExisting([p0.local.slugFile, p0.local.fixedFile]);
    const oldOk0 = old0 && old0.model === want ? old0 : null;
    const keep = oldOk0?.vectors ? Object.keys(oldOk0.vectors).length : 0;
    console.log(`[info] 样本库为空(${exPath}),无需构建决策向量;现有 local 层 ${keep} 条保留不动`);
    return { ok: keep, embedded: 0, reusedBase: 0, reusedLocal: keep, fail: 0, out: null, dim: oldOk0?.dim || 0, model: want, authority: null, slug: p0.slug, empty: true };
  }
  const cfg = (() => { const c = loadConfig({ soft: true }); return c && !c._configError ? (c.exemplars || {}) : {}; })(); // S1-F1(20261120 夜):坏 config 时 loadConfig 的 process.exit 不可捕获,catch 兜底形同虚设——后台路径一律 soft
  const auth = authority || cfg.authority || 'local';
  const paths = vectorsLayerPaths(dataDir, want);
  const base = readFirstExisting([paths.base.slugFile, paths.base.fixedFile]);
  const baseOk = base && base.model === want ? base : null;
  const localOld = readFirstExisting([paths.local.slugFile, paths.local.fixedFile]);
  const legacyOld = base || localOld ? null : readLayerPath(paths.local.legacyFile); // 仅迁移期复用
  const oldOk = [localOld, legacyOld].find((d) => d && d.model === want) || null;

  const vectors = {};
  const overrides = {};
  const seen = new Set();
  let embedded = 0, reusedBase = 0, reusedLocal = 0, fail = 0, dim = 0;
  // 托盘快通道 5 秒读一次。进度文件按同一间隔落盘,不按条写。
  // covered 只计本地已复用+新嵌入。开头写一次 0,面板用 max(旧条数, covered),不会闪成 0。向量文件写完后删掉。
  const progressFile = path.join(dataDir, 'routing', 'build-vectors.progress.json');
  const PROGRESS_WRITE_MS = 5_000;
  let progressWrittenAt = 0;
  const noteProgress = (force = false) => {
    const t = Date.now();
    if (!force && progressWrittenAt && t - progressWrittenAt < PROGRESS_WRITE_MS) return;
    progressWrittenAt = t;
    try {
      fs.mkdirSync(path.dirname(progressFile), { recursive: true });
      fs.writeFileSync(progressFile, JSON.stringify({ covered: reusedLocal + embedded, total: ex.exemplars.length, pid: process.pid }));
    } catch { /* 进度失败不影响嵌入 */ }
  };
  let targetDim = 0; // 目标模型实测维度(S4-F1:dim 锚定到目标模型产出,旧档复用可能带历史污染)
  const put = (key, meta, v) => {
    if (!dim && v && v.length) dim = v.length;
    vectors[key] = { ...meta, v_b64: encodeVector(v) }; // 统一存 base64 Float32(省体积 ~4x)
  };
  // 嵌入函数与**目标模型**绑定(2026-11-10 修污染):不再经 embedIntent(它跟 config 后端走)——
  // 目标是 ollama/* 就直打 /api/embed,目标是 local/jina 才走常驻+进程内兜底。
  // 否则"config=local、构建目标=ollama"时会把 jina 768 向量冒充 ollama 库(实测污染事件)。
  const cfgAll = (() => { const c = loadConfig({ soft: true }); return c && !c._configError ? c : {}; })(); // S1-F1(20261120 夜):同上 soft 化,坏 JSON 回落默认 ollamaBase
  const ollamaBase = cfgAll.ollamaBase || 'http://localhost:11434';
  const ollamaName = want.startsWith('ollama/') ? want.slice('ollama/'.length) : null;
  const embedForWant = ollamaName
    ? async (t) => {
        try {
          const r = await fetch(`${ollamaBase}/api/embed`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: ollamaName, input: [t], keep_alive: OLLAMA_KEEP_ALIVE }), // S1-F4 家族(2026-11-13):原写死 '2h',调周期会漏这处——统一走 config 单源
            signal: AbortSignal.timeout(120_000),
          });
          if (!r.ok) return null;
          const j = await r.json();
          const v = j.embeddings && j.embeddings[0];
          return Array.isArray(v) && v.length ? v : null;
        } catch { return null; }
      }
    : async (t) => (await import('./rangePick.mjs')).embedIntentResilient(t, want);
  const embedForWantFinal = embedFn || embedForWant; // 显式注入(测试密闭)优先
  try {
  noteProgress(true);
  for (const e of ex.exemplars) {
    if (!e || !e.prompt) continue;
    const key = vectorKeyOf(e.prompt, want);
    if (seen.has(key)) continue; // 同内容去重(跨来源同 prompt 只留一条)
    seen.add(key);
    const meta = { label: e.label, rule: e.labelRule || '', pkey: e.pkey || promptKey(e.prompt) };
    const b = baseOk && baseOk.vectors[key] ? baseOk.vectors[key] : null;
    if (b && entryVector(b)) {
      reusedBase += 1;
      if (auth === 'local' && (b.label !== meta.label || b.rule !== meta.rule || b.pkey !== meta.pkey)) overrides[key] = meta;
      continue; // 向量留在 base,本地不重复存
    }
    const old = oldOk && oldOk.vectors[key] ? oldOk.vectors[key] : null;
    const oldV = entryVector(old);
    if (oldV) { put(key, meta, oldV); reusedLocal += 1; noteProgress(); continue; }
    try {
      const v = await embedForWantFinal(e.prompt);
      if (Array.isArray(v) && v.length) { put(key, meta, v); if (!targetDim) targetDim = v.length; embedded += 1; noteProgress(); continue; }
    } catch (err) { if (failFast) throw err; }
    fail += 1;
  }
  // 守卫:base 一条都没有、local 也零产出 ⇒ 拒绝覆盖(沿用 2026-11-09 空库守卫)
  if (!reusedBase && !Object.keys(vectors).length) throw new Error(`buildVectors 全部失败(embedded=0/fail=${fail}),拒绝覆盖现有向量库`);
  if (!dim) {
    const anyOld = baseOk && Object.values(baseOk.vectors).map(entryVector).find(Boolean);
    dim = (anyOld && anyOld.length) || (localOld && localOld.dim) || 0;
  }
  // S4-F1(2026-11-14 夜审):目标模型实测维度优先——旧档复用条目可能带历史污染(768 冒充),
  // 以本次目标模型产出为准锚定 dim,再逐条自检丢弃错维条目(含被污染的旧档复用)。
  if (targetDim) dim = targetDim;
  if (dim) {
    for (const [id, v] of Object.entries(vectors)) {
      const vec = entryVector(v);
      if (vec && vec.length !== dim) { delete vectors[id]; fail += 1; console.error(`[warn] 混维条目丢弃:${id}(${vec.length} 维 ≠ ${dim})`); }
    }
  }
  const doc = {
    version: 1, builtAt: new Date().toISOString(), model: want, dim,
    vecEncoding: 'f32b64', // 向量条目格式:`v_b64`=base64 Float32LE;加载端兼容旧 `v` 明文数组
    embedded, reusedBase, reusedLocal, fail, ok: Object.keys(vectors).length,
    authority: auth, vectors, overrides,
  };
  const out = paths.local.slugFile; // 只写当前模型 slug 的 local 层;base 与旧固定名永不写
  fs.mkdirSync(path.dirname(out), { recursive: true });
  atomicWriteFileSync(out, JSON.stringify(doc));
  return { ok: doc.ok, embedded, reusedBase, reusedLocal, fail, out, dim, model: want, authority: auth, slug: paths.slug };
  } finally {
    try { fs.unlinkSync(progressFile); } catch { /* 无进度文件 */ }
  }
}

/** 向量库与当前嵌入模型是否同源(2026-11-08 修):旧档无 model 字段=不匹配(宁可弃权不出错票)。 */
export function vectorsMatchModel(vectorsDoc) {
  if (!vectorsDoc?.vectors) return false;
  return vectorsDoc.model === currentEmbedModel();
}

/**
 * 加载并合并 base + local(2026-11-10):
 *   - 两层各自校验 model 指纹(与当前嵌入模型不同源则该层不参与);
 *   - 同 key 时 local 向量优先(内容相同,值应一致,仅防异常);标签按 authority:
 *     'local' 用 local.overrides 覆盖 base,否则保留 base(服务器清洗权威);
 *   - 迁移:无 local 文件时把旧单文件 exemplars-vectors.json 当 local 层读。
 */
export function loadVectors(dataDir = DATA_DIR, { model = null } = {}) {
  const paths = vectorsLayerPaths(dataDir, model);
  // 加载缓存(2026-11-10):按文件 mtime+size 判失效,避免每轮判定重复 parse+base64 解码。
  const statKey = (f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '0:0'; } };
  // S14-F5(20261118):cacheKey 并入 config 文件 stat——doc 携带 knnLocalWeight 后,配置改动必须
  // 让缓存失效(否则新权重不生效)。stat 极廉(1 次 stat,不读不解析),配置读仍只在重建时发生。
  const cfgStatKey = (() => { try { const st = fs.statSync(CONFIG_PATH); return `${st.mtimeMs}:${st.size}`; } catch { return '0:0'; } })();
  const cacheKey = `${dataDir}|${paths.slug}|${[paths.base.slugFile, paths.base.fixedFile, paths.local.slugFile, paths.local.fixedFile, paths.local.legacyFile].map(statKey).join(',')}|cfg:${cfgStatKey}`;
  if (_vectorsCache.key === cacheKey) return _vectorsCache.data;
  const base = decodeLayer(readFirstExisting([paths.base.slugFile, paths.base.fixedFile]));
  const local = decodeLayer(readFirstExisting([paths.local.slugFile, paths.local.fixedFile]));
  const legacy = local ? null : decodeLayer(readLayerPath(paths.local.legacyFile));
  const want = model || currentEmbedModel();
  const baseOk = base && base.model === want ? base : null;
  const localDoc = local || legacy;
  const localOk = localDoc && localDoc.model === want ? localDoc : null;
  if (!baseOk && !localOk) {
    const raw = localDoc || base || legacy || null;
    _vectorsCache = { key: cacheKey, data: raw };
    return raw; // 交给 vectorsMatchModel 统一拒绝
  }
  const cfg = (() => { const c = loadConfig({ soft: true }); return c && !c._configError ? (c.exemplars || {}) : {}; })(); // S1-F1(20261120 夜):loadVectors 路径同 soft 化(后台/钩子一律 soft 家族)
  const authority = localOk && localOk.authority ? localOk.authority : (cfg.authority || 'local');
  // PU-001 A(2026-11-17 用户批准):合并条目打**层标记 src**——base=服务器清洗权威层,local=本机自签辅助层;
  // knnClassify 据此做层权重(base 1.0 / local 0.6)。浅拷贝打标,不污染源层文档(缓存/重建共用)。
  // 同 key local 覆盖 base(向量优先语义不变);authority='local' 的 overrides 只改标签,src 保持。
  const vectors = {};
  if (baseOk) for (const [k, e] of Object.entries(baseOk.vectors || {})) vectors[k] = { ...e, src: 'base' };
  if (localOk) for (const [k, e] of Object.entries(localOk.vectors || {})) vectors[k] = { ...e, src: 'local' };
  if (authority === 'local' && localOk && localOk.overrides) {
    for (const [k, meta] of Object.entries(localOk.overrides)) {
      if (vectors[k]) vectors[k] = { ...vectors[k], ...meta };
    }
  }
  const dim = (localOk && localOk.dim) || (baseOk && baseOk.dim) || 0;
  const data = {
    version: 1,
    builtAt: (localOk && localOk.builtAt) || (baseOk && baseOk.builtAt) || null,
    model: (localOk || baseOk).model, dim,
    ok: Object.keys(vectors).length, fail: (localOk && localOk.fail) || 0,
    vectors,
    layers: { base: !!baseOk, local: !!localOk, legacy: !local && !!legacy },
    // S14-F5(20261118):组 doc 时把 local 层权重挂到 doc——knnClassify 是热路径(每请求一次),
    // 原实现每次调用 loadConfig() 读盘(=每请求多一次 IO)。此处读一次挂 doc,判定侧零读盘。
    knnLocalWeight: Number(cfg.knnLocalWeight) > 0 ? Number(cfg.knnLocalWeight) : L2_LAYER_WEIGHTS.local,
  };
  _vectorsCache = { key: cacheKey, data };
  return data;
}

/** PU-001 A 层权重(2026-11-17 用户批准):base=服务器清洗权威层全权,local=本机自签辅助层降权。
 *  仅在**混合库**(base 层有数据)时生效;纯 local 库(服务器包未下发)local 权重=1,行为与改前完全一致。
 *  标定域:默认走代码常量,config exemplars.knnLocalWeight 可覆盖(系统域,不播种到用户配置面);
 *  knnClassify 的 localWeight 参数可单次覆盖(测试/评测用)。taint 降权与本权重相乘(各自独立)。 */
export const L2_LAYER_WEIGHTS = THRESHOLD_L2_LAYER_WEIGHTS; // S14-F4(20261118):并入 thresholds 单源(原 0.6 字面量双写)

/** cosine kNN 加权投票:sim≥minSim 的 top-k 邻居按相似度加权,输出 type+confidence。
 *  自证降权(2026-11-04 用户定档):rule 含 l2 的近邻=其标签曾有 L2 票参与签出,相似度按
 *  taintFactor(默认 0.5)折算后再进标签权重/置信/top-k 排序——阻断"L2 签出的标教 L2"循环;
 *  旧向量文件无 rule 字段按未污染算,下次重建向量后自动生效。
 *  层权重(PU-001 A,2026-11-17):混合库中 local 邻居按 L2_LAYER_WEIGHTS.local 降权,base 全权;
 *  纯 local 库不降权(验收门禁:无 base 包时投票结果与改前一致)。
 *  excludePkey / excludePkeys(2026-11-10):按 promptKey 排除指定条目,用于 LOO 评估
 *  (参照集与黄金集同源,不排除自身会让指标虚高);向量条目自 2026-11-10 起带 pkey 字段。 */
export function knnClassify(vector, vectorsDoc, { k = 5, minSim = L2_MIN_SIM, taintFactor = 0.5, excludePkey = null, excludePkeys = null, localWeight = null } = {}) {
  if (!vector || !vectorsDoc?.vectors) return null;
  // LOO(2026-11-10):按 pkey 排除"查询自身"的参照条目。签入行会回流样本库,
  // 同一 prompt 的自邻居 cosine≈1,不排除会让 KNN 评测虚高(taintFactor 只降权不剔除)。
  // 旧向量文件无 pkey 字段 ⇒ 无法排除(重建向量后自动生效),向后兼容。
  const exSet = excludePkeys instanceof Set ? excludePkeys : (excludePkey ? new Set([String(excludePkey)]) : null);
  // 混合库判定:loadVectors 产出的 doc 带 layers;直传旧形态 doc 时按条目 src 兜底扫描。
  const hasBase = vectorsDoc.layers ? !!vectorsDoc.layers.base : Object.values(vectorsDoc.vectors).some((e) => e && e.src === 'base');
  let lw = 1;
  if (hasBase) {
    // S14-F5(20261118):优先用显式参数 → doc 携带的权重(组 doc 时读一次)→ 兜底才读 config。
    // 热路径(每请求一次)不再触发 loadConfig() 读盘。S1-F1(20261120 夜):兜底 soft 化——坏 config 的
    // process.exit 不可被 try/catch 捕获,原 catch 形同虚设;soft 带回 _configError 按缺省权重回落。
    const n = Number(localWeight);
    const docW = Number(vectorsDoc.knnLocalWeight);
    lw = Number.isFinite(n) && n > 0 ? n
      : (Number.isFinite(docW) && docW > 0 ? docW
        : (() => {
          { // S1-F1(20261120 夜):坏 config 的 process.exit 不可捕获,catch 兜底形同虚设——soft 化判 _configError 走缺省权重
            const c = loadConfig({ soft: true });
            const w = c && !c._configError ? Number(c.exemplars?.knnLocalWeight) : NaN;
            return Number.isFinite(w) && w > 0 ? w : L2_LAYER_WEIGHTS.local;
          }
        })());
  }
  const sims = Object.entries(vectorsDoc.vectors)
    .filter(([, e]) => { if (!exSet) return true; const pk = e && e.pkey; return !(pk && exSet.has(String(pk))); })
    .map(([id, e]) => {
      const sim = cosine(vector, e.v);
      const tainted = !!(e.rule && /l2/i.test(String(e.rule)));
      const layerW = e && e.src === 'base' ? L2_LAYER_WEIGHTS.base : lw;
      return { id, label: normalizeType(e.label), sim, tainted, src: (e && e.src) || 'local', eff: sim * (tainted ? taintFactor : 1) * layerW };
    })
    .filter((x) => x.sim >= minSim)
    .sort((a, b) => b.eff - a.eff)
    .slice(0, k);
  if (!sims.length) return null;
  const weight = {};
  let total = 0;
  for (const n of sims) { weight[n.label] = (weight[n.label] || 0) + n.eff; total += n.eff; }
  const best = Object.entries(weight).sort((a, b) => b[1] - a[1])[0];
  // 置信口径(2026-11-03 修"过信"):首近邻相似度 × 相对最近**异类**近邻的领先边际——
  // 旧口径 best/total 在单近邻时恒为 1(sim 0.57 也报 0.99);全同类近邻边际=1 → conf=sim;
  // 有贴近的异类近邻 → 置信骤降=弃权,由调用方 minConf 门槛兜住(拿不准不切)。
  const top1 = sims[0].eff;
  const rival = sims.find((n) => n.label !== best[0])?.eff ?? 0;
  const confidence = Math.round(Math.min(0.99, top1 > 0 ? top1 * ((top1 - rival) / top1) : 0) * 100) / 100;
  return { type: best[0], confidence, neighbors: sims, source: 'L2' };
}

// ---------- 模型价格档位(2026-11-02,用户定档:max>pro>plus>普通>flash,后缀不分大小写) ----------
// 供四档链派生排序使用(L3 层已于 2026-11-03 取消——语义兜底由四档分档承担)。

const TIER_ORDER = { flash: 0, normal: 1, plus: 2, pro: 3, max: 4 }; // 数值越小越便宜
const NON_CHAT_RE = /wan\d|image|audio|tts|asr|video|realtime|decision-model/i; // 图像/语音/视频/判定 API 不参与(preview 2026-11-04 用户定档=R2 档,参与路由)
/** Kimi 专用档位映射(2026-11-02 用户定档):容量标记 256K 当 flash 同级;coding 关键词 = plus 档。
 *  只在最后一个非纯数字段上命中,不影响其它模型的既有档位判断。 */
const KEYWORD_TIERS = { '256k': 'flash', coding: 'plus' };

/**
 * 模型价格档位基元:取最后一个非纯数字段(剥掉 -0813 这类日期尾缀),按小写等值比对;无档位段=普通。
 * 角色链派生 deriveRoleChains 已随 role 两档制删除(2026-11-03):四档链档内排序由品牌优先序+档位序数承担。
 */
export function tierOf(modelId) {
  const tokens = String(modelId || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i].toLowerCase();
    if (/^\d+$/.test(t)) continue;
    if (KEYWORD_TIERS[t]) return KEYWORD_TIERS[t];
    if (t === 'flash' || t === 'plus' || t === 'pro' || t === 'max') return t;
    break;
  }
  return 'normal';
}

// ---------- 四档模型分级(2026-11-02 用户定档;2026-11-06 v4 品牌三档+轻量降档,全配置面;v4.1 调档) ----------
// v4 定档(2026-11-06 用户定档):模型名 → 档位 = **品牌三档默认表 + 轻量后缀降一档**,表与后缀全部进
// data/code-index.config.json 的 modelRouting.modelTiers / lightSuffixes,可按需改:
//   品牌三档:normal=deepseek/glm/qwen/minimax(默认 R2)/ mid=kimi/grok/gemini(默认 R3)/ high=claude/gpt(默认 R4)
//   (v4.1 2026-11-06 用户调整:grok 从未入表、gemini 从 high 移入 mid,high 只剩 claude/gpt);
//   未识别品牌按 normal(R2)兜底;品牌识别用 brandOf(k\d 前缀=kimi、别名收敛、连写子串兜底)。
//   轻量后缀(flash/preview/coding/code/coder/turbo/mini/air/nano/event/haiku/luna/lite/base/sol/sonnet;sol/sonnet v4.1 补,
//   code/coder 2026-11-06 再补——K2.7-Code 这类编码款按轻量款降档):命中即在默认档上**降一档**(R1 封底);
//   flash 恒 R1(最便宜日常主力价带,品牌 flash 也截在此档)。
//   pro/max 不再特殊:普通品牌 pro/max 留 R2、中档品牌全家 R3、高档品牌全家 R4——档位语义与品牌等级一一对应。
//   例:gemini-2.5-pro=R3、claude-3-5-sonnet=R4−1=R3、Kimi-K2.7-Code=R3−1=R2、K2.8-Preview=R3−1=R2、qwen-turbo=R2−1=R1。
const DEFAULT_LIGHT_SUFFIXES = ['flash', 'preview', 'coding', 'code', 'coder', 'turbo', 'mini', 'air', 'nano', 'event', 'haiku', 'luna', 'lite', 'base', 'sol', 'sonnet'];
export { DEFAULT_LIGHT_SUFFIXES };
export const TIER_RANK = { R1: 1, R2: 2, R3: 3, R4: 4 };
export const TIER_ORDER_DESC = ['R4', 'R3', 'R2', 'R1']; // 降档方向
const TIER_BY_RANK = { 1: 'R1', 2: 'R2', 3: 'R3', 4: 'R4' };

/** 配置里的品牌三档表 → {品牌:档基数} 扁平序(normal/mid/high);非法键忽略、大小写收敛。 */
export function normalizeModelTiers(modelTiers = null) {
  const raw = modelTiers && typeof modelTiers === 'object' && !Array.isArray(modelTiers) ? modelTiers : null;
  const order = {};
  for (const grade of ['normal', 'mid', 'high']) {
    const list = raw && Array.isArray(raw[grade]) ? raw[grade] : null;
    for (const b of list || []) {
      const name = String(b || '').trim().toLowerCase();
      if (name) order[name] = grade;
    }
  }
  return order;
}

/** 品牌三档默认表(2026-11-06 v4 用户定档;v4.1 grok/gemini 移入 mid):未识别品牌按 normal。 */
export const DEFAULT_MODEL_TIERS = {
  normal: ['deepseek', 'glm', 'qwen', 'minimax'],
  mid: ['kimi', 'grok', 'gemini'],
  high: ['claude', 'gpt'],
};
const GRADE_BASE = { normal: 'R2', mid: 'R3', high: 'R4' };

/** 模型 id → 四档(R1/R2/R3/R4)。v4:品牌默认档,轻量后缀降一档,flash 恒 R1。纯函数可测。
 *  非法入参(表为 null/数组、后缀非数组)在函数内回落默认表——解构默认值只兜 undefined,兜不住显式 null。 */
export function tierOfModel(modelId, { modelTiers = DEFAULT_MODEL_TIERS, lightSuffixes = DEFAULT_LIGHT_SUFFIXES } = {}) {
  const id = String(modelId || '');
  const tokens = id.split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase());
  // flash 恒 R1(2026-11-06 v3.1 口径保留:最便宜日常主力价带,品牌 flash 也截在此档)
  if (tokens.includes('flash')) return 'R1';
  const mt = modelTiers && typeof modelTiers === 'object' && !Array.isArray(modelTiers) ? modelTiers : DEFAULT_MODEL_TIERS;
  const ls = Array.isArray(lightSuffixes) ? lightSuffixes.map((t) => String(t).toLowerCase()) : DEFAULT_LIGHT_SUFFIXES;
  const grade = normalizeModelTiers(mt)[brandOf(id)] || 'normal'; // 未识别品牌=normal
  const rank = TIER_RANK[GRADE_BASE[grade]] - (tokens.some((t) => ls.includes(t)) ? 1 : 0);
  return TIER_BY_RANK[Math.max(1, Math.min(4, rank))];
}

// ---------- 品牌优先序(2026-11-03 用户需求:config 定义品牌调用顺序,只排"档内谁先被调",不改档位归属) ----------
export const DEFAULT_BRAND_PRIORITY = ['glm', 'deepseek', 'qwen', 'minimax', 'kimi', 'grok', 'claude', 'gpt', 'gemini'];
// 品牌别名收敛:公司名/历史名 → 用户优先序里的规范品牌名(与 PREMIUM_BRAND_RE 同义)
const BRAND_ALIAS = { moonshot: 'kimi', openai: 'gpt', chatgpt: 'gpt', anthropic: 'claude', xai: 'grok' };
const BRAND_TOKENS = ['glm', 'minimax', 'deepseek', 'qwen', 'kimi', 'grok', 'claude', 'gpt', 'gemini', 'moonshot', 'openai', 'chatgpt', 'anthropic', 'xai'];

/** 模型 id → 规范品牌名(小写);k\d 前缀=kimi;别名收敛;token 精确优先,连写(qwen3.8/glm-5.3)走子串兜底;无匹配 null。纯函数可测。 */
export function brandOf(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/^k\d/.test(id)) return 'kimi'; // k3.1-pro → kimi
  const tokens = id.split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of tokens) {
    if (BRAND_ALIAS[t]) return BRAND_ALIAS[t];
    if (BRAND_TOKENS.includes(t)) return t;
  }
  for (const b of BRAND_TOKENS) if (id.includes(b)) return BRAND_ALIAS[b] || b; // qwen3.8-max/chatglm 等连写
  return null;
}

/** 品牌在优先序里的名次(0=最先被调);未列出/未识别的品牌排到所有已知品牌之后,仍按档位序数/名确定性。 */
function brandRank(brand, priority) {
  if (!brand) return priority.length;
  const i = priority.indexOf(brand);
  return i === -1 ? priority.length : i;
}

/**
 * 四档链自动派生:从实时上游快照按 tierOfModel 分桶(v4:品牌三档表+轻量后缀可经 modelTiers/lightSuffixes 配置覆盖)。
 * 档内排序(2026-11-03 用户裁定):**品牌优先序为主键**(config.modelRouting.brandPriority,决定"同档谁先被调"),
 *   同品牌再按档位序数升序(TIER_ORDER:flash0<normal1<plus2<pro3<max4,名字档位关键词的序数非真实单价,冷却时自然滑到次序),最后 modelId 保确定性。
 * 档位归属(tierOfModel)与降档级联(resolveTier)完全不受品牌序影响 —— 即"不影响动态模型路由的调用档位"。
 * 返回 {r1,r2,r3,r4, derived:true};空档为 []。排除图像/语音/视频/判定 API(NON_CHAT_RE 同口径)。
 */
export function deriveTierChains(upstreams, { brandPriority = DEFAULT_BRAND_PRIORITY, modelTiers = null, lightSuffixes = null } = {}) {
  const priority = Array.isArray(brandPriority) && brandPriority.length
    ? brandPriority.map((b) => String(b).toLowerCase())
    : DEFAULT_BRAND_PRIORITY;
  const tierOpts = {
    modelTiers: modelTiers && typeof modelTiers === 'object' ? modelTiers : DEFAULT_MODEL_TIERS,
    lightSuffixes: Array.isArray(lightSuffixes) ? lightSuffixes.map((s) => String(s).toLowerCase()) : DEFAULT_LIGHT_SUFFIXES,
  };
  const buckets = { R1: [], R2: [], R3: [], R4: [] };
  const seen = new Set();
  for (const [pid, p] of Object.entries(upstreams?.providers || {})) {
    if (p?.enabled === false || !p?.apiKey) continue;
    for (const m of p.models || []) {
      const id = String(m || '');
      if (!id || seen.has(id) || NON_CHAT_RE.test(id)) continue;
      seen.add(id);
      buckets[tierOfModel(id, tierOpts)].push({ modelId: id, price: TIER_ORDER[tierOf(id)] ?? 1, brand: brandOf(id) }); // price=名字档位序数,非真实单价
    }
  }
  const out = { derived: true };
  for (const t of TIER_ORDER_DESC) {
    out[t.toLowerCase()] = buckets[t]
      .sort((a, b) => brandRank(a.brand, priority) - brandRank(b.brand, priority)
        || a.price - b.price || a.modelId.localeCompare(b.modelId))
      .map((c) => c.modelId);
  }
  return out;
}

// ---------- 级联(L1→L2,影子/查询口径;L3 已于 2026-11-03 取消) ----------

/** 完整级联:L1 强信号即决策;否则 L2 kNN;L3 已取消(语义兜底由四档分档承担)。
 *  返回 {source,type,confidence,...} 或 {source:'none'}。 */
export async function classifyRoute(prompt, { dataDir = DATA_DIR, cfg = null, embedFn = null, vectorsDoc = null } = {}) {
  const c = cfg || readJson(path.join(dataDir, 'code-index.config.json')) || {};
  const mr = c.modelRouting || {};
  const l1 = classifyPrompt(prompt);
  if (l1 && l1.confidence >= 0.7) return { ...l1, source: 'L1' };
  // L2 阈值(统一走 resolveL2Config,2026-11-07 嵌套收口;旧顶层/旧 l2.minSim 形态兼容回落):
  // 扫描结论(minSim 0.55):minConf 0.75 覆盖 6/50 且准确 100%,0.6 覆盖 15/50 且准确 93%。
  const l2c = resolveL2Config(mr);
  const minSim = l2c.voteMinSim;
  const minConf = l2c.voteMinConf;
  // 无 embedFn(影子 CLI)时跳过 3MB 向量表加载——L2 本就需要嵌入,不白读。
  // vectorsDoc 显式注入(密闭测试/调用方自带)豁免指纹校验;仅磁盘库(loadVectors)按指纹把关。
  const loaded = vectorsDoc || (embedFn ? loadVectors(dataDir) : null);
  const l2v = (vectorsDoc || vectorsMatchModel(loaded)) ? loaded : null;
  if (l2v && embedFn) {
    try {
      const v = await embedFn(prompt);
      const l2 = knnClassify(v, l2v, { minSim });
      if (l2 && l2.confidence >= minConf) return l2;
      } catch { /* L2 失败落 none */ }
  }
  return { source: 'none', type: l1?.type ?? null, confidence: l1?.confidence ?? 0 };
}

/**
 * L2 融合票(2026-11-06 进化回路接通:代理实弹消费向量库):难度词法定档后,若 L2 kNN 以高置信
 * 投 **multi**(样本库 120/类,含代签回流),把 R1 定档救回 R2——只救回不压制:
 *   ① 只在词法判 R1(不是 P2 上梯/降档/sticky 轮)时介入;② 只升到 R2(multi→R2 的设计映射),不碰 R3+;
 *   ③ 与 L1 相左时 L1 强信号(≥0.7)优先,kNN 只兜"词法拿不准"的轮——与代签"决策票只许救回"同哲学。
 * v2 R3 救援(2026-11-08 重建裁定):词法判 R2 且 kNN 以更高置信(r3MinConf)投 **R3** ⇒ 救回 R3。
 *   向量库当前无 R3 类嵌入(精确真值样本=上梯后干净完成,由 tier-evidence 积累,每类 ≥8 条后由向量构建方
 *   补嵌)⇒ 样本不足时 kNN 投不出 R3,该分支自然不触发(fail-open,零影响);routine/light 票仍无救回意义。
 * 纯函数可测;代理侧 shadow/live 两道总闸恒开(2026-11-14 用户裁定,l2Live/l2.live 开关键不再读取)+ fail-open,向量库/embedFn 缺失=票弃权零影响。
 * 返回 {tier, confidence, rule} 或 null(不介入)。
 */
export function l2TierRescue(diff, l2, { minConf = 0.8, r3MinConf = 0.85 } = {}) {
  try {
    if (!diff || !l2) return null;
    if (diff.tier !== 'R1' && diff.tier !== 'R2') return null; // 只救 R1/R2 误判;R3+ 不加码
    const t = normalizeType(l2.type);
    if (!(Number(l2.confidence) >= minConf)) return null; // 高门槛:kNN 置信须过 minConf(默认 0.8)
    if (diff.tier === 'R1' && t === 'multi') {
      return { tier: 'R2', confidence: Number(l2.confidence), rule: `l2-rescue(${t}@${l2.confidence})` };
    }
    // v2:R1 误判只认 multi(light/routine 本就该在 R1);R2 误判只认 R3(需过 r3MinConf 更硬门槛)
    if (diff.tier === 'R2' && t === 'R3' && Number(l2.confidence) >= (Number.isFinite(Number(r3MinConf)) ? Number(r3MinConf) : 0.85)) {
      return { tier: 'R3', confidence: Number(l2.confidence), rule: `l2-rescue(${t}@${l2.confidence})` };
    }
    return null;
  } catch { return null; }
}

/** 影子结果落 shadow 日志(与 L1 的 routing-log 分开,口径不同)。 */export function logShadow({ dataDir = DATA_DIR, prompt = '', result = null } = {}) {
  try {
    const rec = { ts: Date.now(), promptHead: String(prompt || '').slice(0, 200), source: result?.source ?? 'none', type: result?.type ?? null, confidence: result?.confidence ?? 0 };
    const file = path.join(dataDir, 'usage', 'routing-shadow.jsonl'); // 与 logTierShadow 同文件同口径(按注入 dataDir 算,可测;2026-11-10 审计 P0 修复)
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return true;
  } catch { return false; }
}

/**
 * 四档难度影子记录(2026-11-02 用户裁定 point3:只算不改,真实流量零变化)。
 * 与分类器影子(logShadow)同文件 routing-shadow.jsonl,用 source:'tier' 区分;路径按注入 dataDir 算(可测)。
 * 记:难度档 + 置信 + 理由 + 本该切的档/模型/供应商 + 是否降档 + 实弹实际发的模型(对账"影子 vs 实弹")。
 * 自进化证据回流(2026-11-04):新增 pkey/decisionTier/escalated/switched/servedTier/ambWouldTier——
 *   escalated(本轮 P2 上梯)+ servedTier(实弹服务档)是黄金集行为真值唯一可达的 R2/R3 硬证据;
 *   ambWouldTier = 歧义轮(置信≤0.5 的 R1)"改判 R2"的裸解析结果(影子 A/B 观察,不改实弹)。
 * v2 上梯事件行(2026-11-08 重建):P2 上梯只发生在工具轮,代理侧在工具轮补写本行(tier=null 无定档,
 *   escalated=true + escalationFrom/To),tierReason 前缀 'p2-escalation:' 可与人类轮定档行区分——
 *   修"影子 escalated 通道事实性失效"(此前全史仅 1 行)。
 */
export function logTierShadow({ dataDir = DATA_DIR, prompt = '', tier = null, tierConfidence = 0, tierReason = '', wouldTier = null, wouldModel = null, wouldProvider = null, downgraded = false, servedModel = null, decisionTier = null, escalated = false, switched = null, servedTier = null, ambWouldTier = null, ambWouldModel = null, escalationFrom = null, escalationTo = null, host = null, shortTurn = null, inheritWouldTier = null, inheritWouldModel = null, l2DownWouldTier = null, l2DownWouldModel = null } = {}) {
  try {
    const head = String(prompt || '').slice(0, 200);
    const rec = { ts: Date.now(), pkey: promptKey(head), promptHead: head, source: 'tier', tier, confidence: tierConfidence, tierReason, wouldTier, wouldModel, wouldProvider, downgraded, servedModel, decisionTier, escalated, switched, servedTier, ambWouldTier, ambWouldModel, escalationFrom, escalationTo, host, shortTurn, inheritWouldTier, inheritWouldModel, l2DownWouldTier, l2DownWouldModel };
    const file = path.join(dataDir, 'usage', 'routing-shadow.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    return true;
  } catch { return false; }
}

// ---------- 健康冷却(#8) ----------

export function readHealth(dataDir = DATA_DIR) {
  return readJson(path.join(dataDir, 'model-health.json')) || { models: {} };
}

export function cooling(modelKey, health, now = Date.now()) {
  const e = health?.models?.[modelKey];
  return !!(e && Number(e.cooldownUntil) > now);
}

export function markHealth({ dataDir = DATA_DIR, modelKey, reason = '', ttlMs = 30 * 60 * 1000, until = null, capMs = null } = {}) {
  try {
    const h = readHealth(dataDir);
    const now = Date.now();
    h.models = h.models || {};
    // 渐进退避(2026-11-04):同一 provider/model 跨冷却窗口累计失败数,冷却时长 = 基础 TTL × 2^(N-1),按族封顶
    // (capMs 由代理按错误族传入;不传=不启用退避,CLI 手动标记与旧口径一致)。
    // 目标键的过期记录保留——只为计数(否则过期一回收,退避永远回到第 1 次);其余过期条目照旧回收(H5)。
    const prev = h.models[modelKey];
    const failCount = (Number(prev?.failCount) || 0) + 1;
    for (const [k, v] of Object.entries(h.models)) {
      if (k === modelKey) continue;
      if (!v || !(Number(v.cooldownUntil) > now)) delete h.models[k];
    }
    const base = until == null ? ttlMs : Math.max(0, until - now);
    const effTtl = until != null || capMs == null ? base : Math.min(base * 2 ** (failCount - 1), capMs);
    h.models[modelKey] = { cooldownUntil: now + effTtl, reason, failCount };
    atomicWriteFileSync(path.join(dataDir, 'model-health.json'), JSON.stringify(h, null, 2) + '\n');
    return true;
  } catch { return false; }
}

export function clearHealth({ dataDir = DATA_DIR, modelKey } = {}) {
  try {
    const h = readHealth(dataDir);
    // 无记录不写盘:成功清零在每请求热路径上调用,健康表通常为空,避免每请求一次磁盘写
    if (!h.models || !(modelKey in h.models)) return true;
    delete h.models[modelKey];
    atomicWriteFileSync(path.join(dataDir, 'model-health.json'), JSON.stringify(h, null, 2) + '\n');
    return true;
  } catch { return false; }
}

// ---------- 降级链解析器(#7) ----------

export function familyOf(modelId) {
  return String(modelId || '').replace(/-(\d{4,8})$/, '');
}

/** inventory: [{providerId, modelId, enabled}] */
function candidatesByName(inventory, name, pin) {
  const want = String(name).toLowerCase();
  const out = { exact: [], family: [] };
  for (const m of inventory) {
    if (pin && m.providerId !== pin) continue;
    const id = String(m.modelId || '');
    if (id.toLowerCase() === want) out.exact.push(m);
    else if (familyOf(id).toLowerCase() === want) out.family.push(m);
  }
  return out;
}

function byProviderPriority(list, priority) {
  const rank = (pid) => { const i = (priority || []).indexOf(pid); return i === -1 ? (priority || []).length : i; };
  return list.slice().sort((a, b) => rank(a.providerId) - rank(b.providerId));
}

/**
 * 通用链解析(#7 规格,resolveTier 每档内复用):链上条目依次尝试,命中即返回。
 * 条目:裸模型名(程序找供应商与最新版本)/ "name@providerId" 钉死 / "default"=currentModel。
 * currentModel 未知时跳过 default;健康冷却中的候选跳过;全链落空 → {fallback:'session-current'}。
 */
export function resolveRole(role, { cfg = {}, inventory = [], health = {}, currentModel = null, now = Date.now() } = {}) {
  const mr = cfg.modelRouting || {};
  const chain = mr.chains?.[role];
  if (!Array.isArray(chain)) return { error: `未知链键或未配置链: ${role}` };
  const priority = mr.providerPriority || [];
  const order = mr.providerOrder || []; // 宿主 UI 供应商拖动序(快照采集):同名模型在 providerPriority 之后的次级取序
  const aliases = mr.aliases || {};
  const seenKeys = new Set();
  let index = 0;
  for (const raw of chain) {
    const entry = String(raw);
    index += 1;
    if (entry === 'default') {
      if (currentModel && currentModel.providerId && currentModel.modelId) {
        const key = `${currentModel.providerId}/${currentModel.modelId}`;
        if (!cooling(key, health, now)) {
          return { providerId: currentModel.providerId, modelId: currentModel.modelId, matchedBy: 'default', chainIndex: index };
        }
      }
      continue;
    }
    let name = entry;
    let pin = null;
    const at = entry.indexOf('@');
    if (at > 0) { name = entry.slice(0, at); pin = entry.slice(at + 1); }
    if (aliases[name]) name = aliases[name];
    const { exact, family } = candidatesByName(inventory, name, pin);
    // #7 规格:providerPriority 是外层循环,匹配方式(精确>家族)是内层——同名字多供应商按优先级取;
    // 未进 priority 的同名供应商按 providerOrder(宿主 UI 拖动序,2026-11-05)排——UI 把谁排前,冷却滑动就先耗谁
    const pools = new Map();
    for (const c of exact) {
      const a = pools.get(c.providerId) || { exact: [], family: [] };
      a.exact.push(c);
      pools.set(c.providerId, a);
    }
    for (const c of family) {
      const a = pools.get(c.providerId) || { exact: [], family: [] };
      a.family.push(c);
      pools.set(c.providerId, a);
    }
    const rank = (pid) => { const i = priority.indexOf(pid); return i === -1 ? priority.length : i; };
    const rankO = (pid) => { const i = order.indexOf(pid); return i === -1 ? order.length : i; };
    const providers = [...pools.keys()].sort((a, b) => rank(a) - rank(b) || rankO(a) - rankO(b));
    for (const pid of providers) {
      const { exact: ex, family: fam } = pools.get(pid);
      for (const cand of [...ex, ...fam]) {
        const key = `${cand.providerId}/${cand.modelId}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (cand.enabled === false) continue;
        if (cooling(key, health, now)) continue;
        return {
          providerId: cand.providerId, modelId: cand.modelId,
          matchedBy: ex.includes(cand) ? 'exact' : 'family', chainIndex: index,
        };
      }
    }
  }
  return { fallback: 'session-current', warn: `role=${role} 整条降级链无可用版本` };
}

/**
 * 四档级联解析(2026-11-02 用户定档:高档无可用模型自动降档)。
 * 从目标档起沿 R4→R3→R2→R1 逐档下滑,命中第一个有可用模型的档即返回;全落空 → session-current(sticky)。
 * 每档内复用 resolveRole 的链解析(冷却/disabled 跳过、providerPriority/aliases 透传)。
 * reachable 可选:传入则额外要求代理可达(与 decideTarget 转发端同口径),不可达视同该档无模型继续降。
 * 返回 {providerId,modelId,tier,downgraded,...} 或 {fallback:'session-current',tier:null}。
 */
export function resolveTier(targetTier, { cfg = {}, inventory = [], health = {}, currentModel = null, now = Date.now(), reachable = null } = {}) {
  const want = String(targetTier || '').toUpperCase();
  const start = TIER_ORDER_DESC.indexOf(want);
  const tiers = start === -1 ? TIER_ORDER_DESC : TIER_ORDER_DESC.slice(start);
  for (const t of tiers) {
    const key = t.toLowerCase();
    const chain = cfg.modelRouting?.chains?.[key];
    if (!Array.isArray(chain) || !chain.length) continue;
    const r = resolveRole(key, { cfg, inventory, health, currentModel, now });
    if (!r || !r.modelId) continue;
    if (reachable && !reachable({ providerId: r.providerId, model: r.modelId })) continue;
    return { ...r, tier: t, downgraded: t !== want };
  }
  return { fallback: 'session-current', tier: null, downgraded: false, warn: `四档链全部无可用模型(target=${want || '未指定'})` };
}

// ---------- 代理可达性(与代理转发端同口径,查询端/改写端共用) ----------

/** 上游快照:代理转发用的真实 baseUrl/key/模型清单 + ingress(客户端把 baseUrl 切到代理的入口供应商)。 */
export function readUpstreamsSnapshot(file = path.join(DATA_DIR, 'routing', 'proxy-upstreams.json')) {
  return readJson(file) || { providers: {} };
}

/** 快照 inventory → resolveRole 候选列表(代理侧唯一可转发的模型来源)。 */
export function inventoryFromUpstreams(upstreams) {
  const inv = [];
  for (const [providerId, p] of Object.entries(upstreams?.providers || {})) {
    for (const m of p.models || []) inv.push({ providerId, modelId: m, enabled: p.enabled !== false });
  }
  return inv;
}

/**
 * 代理可达性:存在 + enabled + 有 key + 持有该模型 —— 与 pickUpstream 的转发条件逐条一致。
 * 此前 decideTarget 的判定少了 apiKey 一项,会出现"判定可达→实际回落他人"的空档(H3)。
 */
export function isProxyReachable({ providerId, model, upstreams } = {}) {
  const p = upstreams?.providers?.[providerId];
  if (!p || p.enabled === false || !p.apiKey) return false;
  return (p.models || []).includes(model);
}

/** 入口供应商:客户端把 baseUrl 切到本代理的那几个(请求必经它们进来)。 */
export function ingressProviders(upstreams) {
  const explicit = Array.isArray(upstreams?.ingress) ? upstreams.ingress : [];
  const marked = Object.entries(upstreams?.providers || {}).filter(([, p]) => p.ingress === true).map(([id]) => id);
  return [...new Set([...explicit, ...marked])];
}

// ---------- inventory 收集(best-effort) ----------

/** ZCode:provider_config 的自定义供应商 + 内置模板的账号供应商(凭据存在才认)。 */
export function collectInventory(home = HOME, zcodeV2Dir = null) {
  const out = [];
  // 路径自适应(2026-11-08):zcodeV2Dir 显式传入 > home 显式非默认主目录(测试旧拼接)> resolveZcodeV2Dir 探测。
  // 恒读默认 ~/.zcode/v2 会在数据路径迁移后命中陈旧副本(inventoryCount/inventorySources 口径失真)。
  const v2 = zcodeV2Dir
    || (home && home !== HOME ? path.join(home, '.zcode', 'v2') : resolveZcodeV2Dir().dir);
  const pc = readJson(path.join(v2, 'provider_config.json'));
  for (const r of pc?.config?.providerConfigRules?.providerRules || []) {
    const enabled = r.enabled !== false && r.config?.enabled !== false;
    for (const m of r.config?.personalModelIds || []) out.push({ providerId: r.providerId, modelId: m, enabled, source: 'zcode-custom' });
  }
  const builtinPath = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const builtin = builtinPath ? readJson(builtinPath) : null;
  const cred = readJson(path.join(v2, 'credentials.json')) || {};
  const credKeys = Object.keys(cred);
  const hasBigmodel = credKeys.some((k) => k.includes('oauth:bigmodel:access_token'));
  const hasZai = credKeys.some((k) => k.includes('zcodejwttoken')) || credKeys.some((k) => k.includes('zai'));
  const templates = builtin?.config?.providerConfigRules?.templateRules || [];
  for (const t of templates) {
    if (t.config?.access?.type !== 'zhipu-coding-plan-api-key') continue;
    const id = String(t.templateId || '');
    const providerId = id.startsWith('zai') ? 'account:zai-start-plan' : id.startsWith('bigmodel') ? 'account:bigmodel-start-plan' : null;
    if (!providerId) continue;
    const enabled = providerId.startsWith('account:zai') ? hasZai : hasBigmodel;
    for (const m of t.config.builtinModelIds || []) out.push({ providerId, modelId: m, enabled, source: 'zcode-builtin' });
  }
  return out;
}

// ---------- 黄金集打分(#14 验证闭环) ----------

/** 目标线(2026-11-06 三档定稿):light/routine ≥0.85,multi 边界最糊 ≥0.7(P2 证据升级兜底其余)。 */
const GOLDEN_TARGETS = { light: 0.85, routine: 0.85, multi: 0.7 };

/**
 * 黄金集打分:以 humanLabel 槽位为真值算 L1 准确率/各类命中/错分清单。
 * 该槽位现由四票代签写入(人工环节 2026-11-02 废,历史人工/构造条目 2026-11-04 清空),而 L1 本身就是
 *   其中一票 ⇒ 用它评 L1 含自证成分:accuracyHuman 与 passAll 恒 null,只剩 accuracyAuto(与四票一致率)
 *   和弱真值 accuracy;对外报数必须标注弱真值口径,不得径称"准确率"。
 * 未签条目另给"与自动标签一致率",它是弱标注规则与 L1 的相符度,不是准确率,不得混用。
 * classifyFn 可注入以便测试密闭;黄金集缺失返回 {error},不抛。
 */
export function scoreGolden({ dataDir = DATA_DIR, goldenFile = null, classifyFn = classifyPrompt } = {}) {
  const file = goldenFile || path.join(dataDir, 'routing', 'golden-set.jsonl');
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return { error: `黄金集不可读: ${file}` }; }
  const calibrated = rows.filter((r) => L1_TYPES.includes(normalizeType(String(r.humanLabel || ''))));
  const perType = {};
  const misses = [];
  let correct = 0;
  for (const r of calibrated) {
    const label = normalizeType(String(r.humanLabel || ''));
    const pred = normalizeType(classifyFn(r.prompt)?.type ?? 'uncertain');
    const p = perType[label] || (perType[label] = { actual: 0, hit: 0 });
    p.actual += 1;
    if (pred === label) { p.hit += 1; correct += 1; } else misses.push({ id: r.id, actual: label, pred, promptHead: String(r.prompt || '').slice(0, 60) });
  }
  const perTypeOut = {};
  for (const [t, v] of Object.entries(perType)) {
    const acc = v.hit / v.actual;
    perTypeOut[t] = { actual: v.actual, hit: v.hit, acc: Number(acc.toFixed(3)), target: GOLDEN_TARGETS[t] ?? null, pass: GOLDEN_TARGETS[t] ? acc >= GOLDEN_TARGETS[t] : null };
  }
  const uncalibrated = rows.filter((r) => !L1_TYPES.includes(normalizeType(String(r.humanLabel || ''))));
  const agree = uncalibrated.length ? uncalibrated.filter((r) => normalizeType(classifyFn(r.prompt)?.type) === normalizeType(String(r.autoLabel || ''))).length : 0;
  // 来源切分(2026-11-02 自动代签后):自动签条目 humanLabel 来自四票多数,用它评 L1 会自证;
  // 故"外部真值"只取非自动签条目(人工/构造性真值),自动签部分单独报"与四票一致率"。
  // 2026-11-04:非自动签条目已全部删除 => humanRows=0、accuracyHuman=null、passAll=null,L1 自此无外部锚点。
  const humanRows = calibrated.filter((r) => !r.autoSigned);
  const autoRows = calibrated.filter((r) => r.autoSigned);
  const accOf = (arr) => {
    if (!arr.length) return null;
    const hit = arr.filter((r) => normalizeType(classifyFn(r.prompt)?.type ?? 'uncertain') === normalizeType(String(r.humanLabel || ''))).length;
    return Number((hit / arr.length).toFixed(3));
  };
  // 外部真值(非自动签)的逐类统计:passAll 只看这一部分
  const perTypeHuman = {};
  for (const r of humanRows) {
    const label = normalizeType(String(r.humanLabel || ''));
    const pred = normalizeType(classifyFn(r.prompt)?.type ?? 'uncertain');
    const p = perTypeHuman[label] || (perTypeHuman[label] = { actual: 0, hit: 0 });
    p.actual += 1;
    if (pred === label) p.hit += 1;
  }
  const perTypeHumanOut = {};
  for (const [t, v] of Object.entries(perTypeHuman)) {
    const acc = v.hit / v.actual;
    perTypeHumanOut[t] = { actual: v.actual, hit: v.hit, acc: Number(acc.toFixed(3)), target: GOLDEN_TARGETS[t] ?? null, pass: GOLDEN_TARGETS[t] ? acc >= GOLDEN_TARGETS[t] : null };
  }
  return {
    total: rows.length,
    calibrated: calibrated.length,
    uncalibrated: uncalibrated.length,
    accuracy: calibrated.length ? Number((correct / calibrated.length).toFixed(3)) : null,
    humanSigned: humanRows.length,
    autoSigned: autoRows.length,
    accuracyHuman: accOf(humanRows),
    accuracyAuto: accOf(autoRows),
    perTypeHuman: perTypeHumanOut,
    passAll: Object.keys(perTypeHumanOut).length
      ? Object.values(perTypeHumanOut).every((v) => v.pass === null || v.pass)
      : null,
    perType: perTypeOut,
    misses: misses.slice(0, 20),
    autoLabelAgreement: uncalibrated.length ? Number((agree / uncalibrated.length).toFixed(3)) : null,
  };
}

/** #14 档位目标线:R1/R2 ≥0.85;2026-11-04 v2 资费语义后 R3(仅 P2 上梯)/R4(仅显式点名)无词法可达真值
 *  (见 TIER_FROM_TYPE 注)恒 null,R3 目标线保留仅为兼容旧黄金数据。 */
const TIER_TARGETS = { R1: 0.85, R2: 0.85, R3: 0.8 };

/**
 * 黄金集**难度档**打分(Phase3c directive #1):以 TIER_FROM_TYPE[humanLabel] 派生的 R 真值评 classifyDifficulty。
 * 真值来源=四票代签的 T 标签经设计映射派生(人工环节 2026-11-02 废,构造性历史条目 2026-11-04 清空)。
 * 与被评的 classifyDifficulty 不同源(四票里没有它)+ 行为票是结果侧证据 ⇒ 非预测回灌;但 L1 词法票
 *   与难度分类器共享词法信号,独立性只到"合议弱真值",不及原注释宣称的外部人工真值。
 * accuracyHuman/accuracyAuto 切分保留兼容:外部真值现为空集 => accuracyHuman=null,报数一律取 accuracyAuto 并标注弱真值。
 * classifyFn 可注入以便测试密闭;黄金集缺失返回 {error},不抛。
 */
export function scoreGoldenTier({ dataDir = DATA_DIR, goldenFile = null, classifyFn = (t) => classifyDifficulty(t, { calibration: loadTierCalibration() }) } = {}) {
  const file = goldenFile || path.join(dataDir, 'routing', 'golden-set.jsonl');
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return { error: `黄金集不可读: ${file}` }; }
  // R 真值 = 双轴派生(2026-11-06:强度轴优先,语义轴回落);无轴且无旧标签 ⇒ 无 R 真值,跳过
  const withTruth = rows
    .map((r) => {
      const axes = tierTruthFromAxes(r);
      return { r, tier: axes.tier, source: axes.source };
    })
    .filter((x) => x.tier);
  const perTier = {};
  const misses = [];
  let correct = 0;
  for (const { r, tier } of withTruth) {
    const pred = classifyFn(r.prompt)?.tier ?? 'R1';
    const p = perTier[tier] || (perTier[tier] = { actual: 0, hit: 0 });
    p.actual += 1;
    if (pred === tier) { p.hit += 1; correct += 1; } else misses.push({ id: r.id, actual: tier, pred, promptHead: String(r.prompt || '').slice(0, 60) });
  }
  const perTierOut = {};
  for (const [t, v] of Object.entries(perTier)) {
    const acc = v.hit / v.actual;
    perTierOut[t] = { actual: v.actual, hit: v.hit, acc: Number(acc.toFixed(3)), target: TIER_TARGETS[t] ?? null, pass: TIER_TARGETS[t] ? acc >= TIER_TARGETS[t] : null };
  }
  // 来源切分:自动代签条目的 T 标签来自四票多数(弱真值),派生的 R 也只算弱一致,不得混入外部真值准确率
  // (2026-11-04 非自动签条目清空后 humanRows 恒空 => accuracyHuman=null;判据保留只兼容旧数据)
  const humanRows = withTruth.filter((x) => !x.r.autoSigned);
  const autoRows = withTruth.filter((x) => x.r.autoSigned);
  const accOf = (arr) => {
    if (!arr.length) return null;
    const hit = arr.filter((x) => (classifyFn(x.r.prompt)?.tier ?? 'R1') === x.tier).length;
    return Number((hit / arr.length).toFixed(3));
  };
  return {
    total: rows.length,
    withTruth: withTruth.length,
    accuracy: withTruth.length ? Number((correct / withTruth.length).toFixed(3)) : null,
    humanSigned: humanRows.length,
    autoSigned: autoRows.length,
    accuracyHuman: accOf(humanRows),
    accuracyAuto: accOf(autoRows),
    perTier: perTierOut,
    // R4 覆盖恒为 0(无 T→R4 映射):明示,提醒 R4 真值只能靠影子行为证据补,别误以为已校准
    r4Coverage: perTierOut.R4 ? perTierOut.R4.actual : 0,
    passAll: Object.keys(perTierOut).length
      ? Object.values(perTierOut).every((v) => v.pass === null || v.pass)
      : null,
    misses: misses.slice(0, 20),
  };
}

// ---------- 双轴评测(2026-11-06) ----------

/**
 * 黄金集**双轴**打分(语义形态轴 / 行为强度轴各评各的)。
 * 为什么:此前单一 humanLabel 同时承担"意图形态"与"行为强度"两把尺子——黄金集 multi 实为行为强度标签
 * (46/46 行为 heavy),L1 的 multi 是句式形态标签(只认出 7/46),同标签名下比对 ⇒ multi 一致率被压到 0.2,
 * 连带 R2 门禁不过。拆开后:
 *   语义轴 = L1 词法预测 vs semanticType(意图侧合议真值)→ 衡量**分类器判形态**的准度;
 *   强度轴 = 行为票重放 vs intensityType(结果侧真值)→ 衡量**行为口径**的准度(与分类器无关,天然可达 1.0)。
 * 两轴真值都是机器合议的**弱真值**(无外部人工锚点),报告须如实标注,不得冒充外部准确率。
 * 兼容:旧行无轴字段时,语义轴回落 humanLabel,强度轴按 evidence 重放现算(behavior 重放口径统一后可用)。
 */
export function scoreGoldenDual({ dataDir = DATA_DIR, goldenFile = null, classifyFn = classifyPrompt, behaviorFrom = null } = {}) {
  const file = goldenFile || path.join(dataDir, 'routing', 'golden-set.jsonl');
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return { error: `黄金集不可读: ${file}` }; }
  const toIntensity = (t) => (t === 'multi' ? 'heavy' : t === 'light' ? 'light' : t === 'routine' ? 'normal' : null);
  // 默认重放器:行为票口径(labelFromShape 同口径 w≥3||calls≥15 ⇒ multi;写1-2 ⇒ routine;零工具 ⇒ light)
  const replay = behaviorFrom || ((r) => {
    const ev = r.evidence || {};
    const calls = Number(ev.toolCalls);
    const writes = Number(ev.writeEdits);
    if (!Number.isFinite(calls) || !Number.isFinite(writes)) return null;
    if (writes === 0 && calls === 0) return { type: 'light' };
    if (writes >= 3 || calls >= 15) return { type: 'multi' };
    if (writes >= 1) return { type: 'routine' };
    return null;
  });
  const semantic = { perType: {}, hit: 0, n: 0 };
  const intensity = { perType: {}, hit: 0, n: 0 };
  const misses = [];
  for (const r of rows) {
    // 语义轴:真值取 semanticType,缺则回落 humanLabel(旧行兼容);预测 = L1 词法
    const semTruth = normalizeType(String(r.semanticType || r.humanLabel || ''));
    if (SEMANTIC_AXIS.includes(semTruth)) {
      const pred = normalizeType(classifyFn(r.prompt)?.type ?? 'uncertain');
      const p = semantic.perType[semTruth] || (semantic.perType[semTruth] = { actual: 0, hit: 0 });
      p.actual += 1; semantic.n += 1;
      if (pred === semTruth) { p.hit += 1; semantic.hit += 1; }
      else misses.push({ axis: 'semantic', id: r.id, actual: semTruth, pred, promptHead: String(r.prompt || '').slice(0, 60) });
    }
    // 强度轴:真值取 intensityType(签入时行为票的结果),预测 = 由 evidence 重放的行为票
    // (重放口径与投票口径统一 ⇒ 这一格量的是"**签时与现在的行为判定是否一致**",不是自证的分类准确率;
    //  签时用 labelFromShape,评测用重放,两者若有偏差会被这一格暴露出来)。
    const intTruth = r.intensityType ? String(r.intensityType) : null;
    if (intTruth && INTENSITY_AXIS.includes(intTruth)) {
      const b = replay(r);
      const pred = toIntensity(b?.type);
      const p = intensity.perType[intTruth] || (intensity.perType[intTruth] = { actual: 0, hit: 0 });
      p.actual += 1; intensity.n += 1;
      if (pred === intTruth) { p.hit += 1; intensity.hit += 1; }
      else misses.push({ axis: 'intensity', id: r.id, actual: intTruth, pred, promptHead: String(r.prompt || '').slice(0, 60) });
    }
  }
  const acc = (o) => (o.n ? Number((o.hit / o.n).toFixed(3)) : null);
  const perOut = (o) => {
    const out = {};
    for (const [t, v] of Object.entries(o.perType)) out[t] = { actual: v.actual, hit: v.hit, acc: Number((v.hit / v.actual).toFixed(3)) };
    return out;
  };
  return {
    total: rows.length,
    note: '双轴真值均为机器合议弱真值(无外部人工锚点),不得当作外部准确率',
    semantic: { n: semantic.n, accuracy: acc(semantic), perType: perOut(semantic), axis: '语义形态轴(L1 词法 vs 意图侧合议真值)' },
    intensity: { n: intensity.n, accuracy: acc(intensity), perType: perOut(intensity), axis: '行为强度轴(签时行为票 vs evidence 重放;量的是口径一致性,非分类准确率)' },
    misses: misses.slice(0, 20),
  };
}

// ---------- doctor ----------

export function doctor({ home = HOME, dataDir = DATA_DIR, cfg = null, currentModel = null, upstreamsFile = null, host = 'zcode' } = {}) {
  const c = cfg || readJson(path.join(dataDir, 'code-index.config.json')) || {};
  const mr = c.modelRouting || {};
  const health = readHealth(dataDir);
  const inventory = collectInventory(home);
  const vec = loadVectors(dataDir);
  // 代理可达性用同一份快照、同一条判定(isProxyReachable),避免"doctor 说能解析、代理说不可达"(H2)
  const upstreams = readUpstreamsSnapshot(upstreamsFile || path.join(dataDir, 'routing', 'proxy-upstreams.json'));
  // 四档链与代理端同口径:从快照按 tierOfModel 派生(brandPriority 用配置覆盖默认);role 人工链已废(2026-11-03)
  const brandPriority = Array.isArray(mr.brandPriority) && mr.brandPriority.length ? mr.brandPriority : DEFAULT_BRAND_PRIORITY;
  const tierChains = deriveTierChains(upstreams, { brandPriority, ...tierClassifyOptions(c, dataDir) });
  // 同名取序(2026-11-05):providerPriority(配置)优先,未进表的同名供应商按快照采集的 providerOrder
  // (宿主 UI 拖动序;Qoder 端=设置文件键序)排;报告口径=--host(默认 zcode)。配置同键 providerOrder 可覆盖快照序。
  const providerOrder = Array.isArray(mr.providerOrder) ? mr.providerOrder : (Array.isArray(upstreams?.providerOrder?.[host]) ? upstreams.providerOrder[host] : []);
  const snapInventory = inventoryFromUpstreams(upstreams);
  // 每档解析一次(快照口径,与代理转发同一份 inventory):报告各档链头与代理可达性
  const resolved = TIER_ORDER_DESC.map((t) => {
    const result = resolveTier(t, { cfg: { ...c, modelRouting: { ...mr, chains: tierChains, providerOrder } }, inventory: snapInventory, health, currentModel });
    const proxyReachable = !!(result.providerId && isProxyReachable({ providerId: result.providerId, model: result.modelId, upstreams }));
    return { tier: t, result, proxyReachable };
  });
  const proxyWarnings = resolved
    .filter((r) => r.result.providerId && !r.proxyReachable)
    .map((r) => `${r.tier} 档解析到 ${r.result.providerId}/${r.result.modelId},但代理快照里不可达(无 key / 不在清单 / 入口不一致)⇒ 代理端会判"不可达"并保持当前模型`);
  // R4 链空提示(2026-11-06 设计内告警):R4=仅显式点名旗舰(v4 高档品牌 claude/gpt 普通款),池里没有
  // 这类模型时链恒空——难度 R4 会被 resolveTier 静默降级到 R3(downgraded),客户端无感。属设计内行为,
  // 但要点名让"用最强模型却拿到 R3"可解释;要接通 R4 须在客户端接入 claude/gpt 品牌模型并刷新快照。
  if (tierChains && Array.isArray(tierChains.r4) && tierChains.r4.length === 0) {
    proxyWarnings.push('R4 链为空:池内无高档品牌(claude/gpt)普通款模型,显式点名旗舰将静默降级到 R3 档(设计内;接入 claude/gpt 模型并刷新快照即可点亮)');
  }
  // 同名多挂提示(2026-11-03 用户场景:多 Token Plan、同名模型不同额度):同名模型挂多个**可用**
  // 供应商(有 key、enabled)且未配 providerPriority 时,同名取序=快照键序——doctor 把它点名,
  // 提示把"额度多/想先调"的供应商写进 modelRouting.providerPriority(或链里 模型@供应商 钉死)。
  const sameNameNotes = [];
  const byModel = new Map();
  for (const m of inventoryFromUpstreams(upstreams)) {
    if (m.enabled === false) continue;
    const p = upstreams.providers?.[m.providerId];
    if (!p || p.enabled === false || !p.apiKey) continue; // 与代理转发条件同口径:有 key 才真能被调
    const k = String(m.modelId || '').toLowerCase();
    if (!byModel.has(k)) byModel.set(k, new Set());
    byModel.get(k).add(m.providerId);
  }
  const priority = Array.isArray(mr.providerPriority) ? mr.providerPriority : [];
  const uiOrder = Array.isArray(upstreams?.providerOrder?.[host]) ? upstreams.providerOrder[host] : [];
  if (!priority.length) {
    for (const [model, pids] of [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (pids.size > 1) {
        sameNameNotes.push(`模型 ${model} 挂多供应商(${[...pids].sort().join(',')})且未配 modelRouting.providerPriority——同名取序=${uiOrder.length ? `${host === 'qoder' ? '设置文件键序' : '宿主 UI 拖动序'}(快照 providerOrder)` : '快照键序'};要显式改序,把想先调的供应商写进 providerPriority(或 providerOrder 覆盖 UI 序),或在链里用 模型@供应商 钉死`);
      }
    }
  }
  return {
    gate: { enabled: mr.enabled === true },
    tierChains,
    inventoryCount: inventory.length,
    inventorySources: [...new Set(inventory.map((x) => x.source))],
    health: health.models || {},
    l1: 'classify.mjs 规则表(常驻)',
    l2: vec ? `就绪(向量 ${vec.ok} 条/失败 ${vec.fail}/维度 ${vec.dim})` : '未构建(运行 --build-vectors)',
    proxySnapshot: { providers: Object.keys(upstreams.providers || {}).length, ingress: ingressProviders(upstreams) },
    resolved,
    proxyWarnings,
    sameNameNotes,
  };
}

// ---------- CLI ----------

function b64(s) { return Buffer.from(String(s || ''), 'utf8').toString('base64'); }
function unb64(s) { return Buffer.from(String(s || ''), 'base64').toString('utf8'); }

/**
 * L2 配置统一解析(2026-11-07 用户拍板收口嵌套):三个 L2 键语义是"总闸+两分闸"父子关系,目标形态
 *   l2: { shadow(嵌入器资源总闸,原顶层 l2Shadow), vote:{minSim,minConf}(代签投票阈值,原 l2.minSim/minConf),
 *         live:{enabled,minConf}(线上路由救回,原顶层 l2Live) }
 * 新旧共用同一 `l2` 键名——旧配置的 l2:{minSim,minConf} 与新字段在同一对象内无冲突共存:
 * **新结构优先、旧键回落**(兼容一个版本期后旧键可删)。四个消费方
 * (l2ShadowEnabled/classifyRoute/autoExemplars.readL2MinConf/modelRouteProxy.mrRoutingOptions)统一走这里,
 * 不得再各自散读。返回 {shadow, voteMinSim, voteMinConf, liveEnabled, liveMinConf}。
 */
export function resolveL2Config(mr = {}) {
  const l2 = mr.l2 && typeof mr.l2 === 'object' && !Array.isArray(mr.l2) ? mr.l2 : {};
  const vote = l2.vote && typeof l2.vote === 'object' && !Array.isArray(l2.vote) ? l2.vote : {};
  const live = l2.live && typeof l2.live === 'object' && !Array.isArray(l2.live) ? l2.live : {};
  const oldLive = mr.l2Live && typeof mr.l2Live === 'object' && !Array.isArray(mr.l2Live) ? mr.l2Live : {};
  const num = (v) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
  return {
    // 总闸:**恒开**(2026-11-14 用户裁定:默认开启不支持关闭)——嵌入资源压力随 GPU 线材修复解除,
    //   配置键 l2.shadow/旧 l2Shadow 不再读取
    shadow: true,
    // 代签投票阈值:新 l2.vote 优先;缺则回落旧 l2.minSim/minConf(同键名旧形态);标定域,用户配置面已回收
    voteMinSim: num(vote.minSim) ?? num(l2.minSim) ?? L2_MIN_SIM,
    voteMinConf: num(vote.minConf) ?? num(l2.minConf) ?? L2_MIN_CONF,
    // 线上救回:**恒开**(2026-11-14 用户裁定,同 shadow);配置键 l2.live.enabled/旧 l2Live.enabled 不再读取
    liveEnabled: true,
    liveMinConf: num(live.minConf) ?? num(oldLive.minConf) ?? 0.3, // 2026-11-14 单源对齐:init scaffold 与 2026-11-06 实测定档均为 0.3(0.8 是更老遗留,只配 enabled:true 不配 minConf 时会静默拿到 0.8 几乎不触发)
  };
}

/** L2 通电开关:**恒开**(2026-11-14 用户裁定:嵌入器总闸默认开启不支持关闭;explicit/cfg 参数保留签名兼容)。
 *  历史口径备档(2026-11-01 实测):曾为显式开关(--l2 或 l2.shadow=true 旧顶层 l2Shadow 兼容才加载,默认关,
 *  影子/CLI 不碰嵌入后端)——当时所有入口都不传 embedFn ⇒ L2 从未运行过,routing-shadow.jsonl 193 条全为
 *  source:'none';2026-11-14 起升为恒开,调用方以返回值恒 true 为事实,开关语义只作占位。 */
export function l2ShadowEnabled(cfg = {}, explicit = false) {
  return true; // 2026-11-14 用户裁定:嵌入器总闸恒开(默认开启不支持关闭);参数保留签名兼容
}

/**
 * 档位分类配置(2026-11-06 v4):从 modelRouting 段取 modelTiers(品牌三档表)与 lightSuffixes(轻量后缀),
 * 缺省/非法回落默认。供 deriveTierChains/tierOfModel 的调用方统一解析——改档只改 data JSON 不动代码。
 */
export function tierClassifyOptions(cfg = null, dataDir = DATA_DIR) {
  const c = cfg || readJson(path.join(dataDir, 'code-index.config.json')) || {};
  const mr = c.modelRouting || {};
  const modelTiers = mr.modelTiers && typeof mr.modelTiers === 'object' && !Array.isArray(mr.modelTiers) ? mr.modelTiers : DEFAULT_MODEL_TIERS;
  const lightSuffixes = Array.isArray(mr.lightSuffixes) ? mr.lightSuffixes.map((s) => String(s).toLowerCase()) : DEFAULT_LIGHT_SUFFIXES;
  return { modelTiers, lightSuffixes };
}

export async function l2EmbedFn({ dataDir = DATA_DIR, explicit = false } = {}) {
  try {
    if (!l2ShadowEnabled(readJson(path.join(dataDir, 'code-index.config.json')) || {}, explicit)) return null;
    const { embedIntent } = await import('./rangePick.mjs');
    return (t) => embedIntent(t);
  } catch { return null; }
}

async function cli(argv) {
  const has = (f) => argv.includes(f);
  const val = (f, def) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : def);
  const dataDir = val('--data-dir', DATA_DIR);
  if (has('--build-vectors')) {
    // 串行守卫(2026-11-10):与 embed.mjs(代码向量)共用 data/.embed.pid 锁——两者都打 ollama,
    // 并发会互相把对方请求挤到超时(实测 embed 608/1643 崩溃即此因)。
    const embedPid = path.join(dataDir, '.embed.pid');
    if (!procTakeJsonLock(embedPid)) {
      console.error('[err] 代码向量重嵌(embed.mjs)正在运行;为避免争抢 ollama,本次向量构建取消,稍后重试');
      process.exit(1);
    }
    // 2026-11-10 根治:①常驻不可用时走进程内兜底嵌入(rangePick.embedIntentResilient),不再 ok=0 直接失败;
    // ②结果由**子进程自己**落 build-vectors.log —— 父进程(prompt-guard --check)可能先退出,
    //   旧的 child.on('exit') 留痕会永远不执行,失败被静默。
    const logPath = path.join(dataDir, 'routing', 'build-vectors.log');
    const logLine = (obj) => { try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.appendFileSync(logPath, JSON.stringify(obj) + '\n'); } catch { /* 日志失败不影响主流程 */ } };
    try {
      // S4-F1(2026-11-14 夜审修复,报告方案①):CLI 不再注入 embedFn——走 buildVectors 内建
      // embedForWant(模型绑定:ollama 目标直打 /api/embed,禁跨模型兜底)。此前经
      // embedIntentResilient 的 jina 兜底曾产出 768 维冒充 ollama 指纹入库(实锤 1/302 条)。
      const r = await buildVectors({ dataDir });
      logLine({ at: new Date().toISOString(), source: 'child', ok: true, okCount: r.ok, fail: r.fail, dim: r.dim, model: r.model });
      console.log(JSON.stringify(r));
    } catch (e) {
      logLine({ at: new Date().toISOString(), source: 'child', ok: false, error: String(e && e.message ? e.message : e) });
      throw e;
    } finally {
      procReleaseJsonLock(embedPid);
    }
    return;
  }
  if (has('--shadow-async')) {
    const prompt = unb64(val('--prompt', ''));
    if (String(prompt).trim().length < 6) return; // 空/超短 prompt:分类器必弃权,不白起子进程
    const r = await classifyRoute(prompt, { dataDir, embedFn: await l2EmbedFn({ dataDir, explicit: has('--l2') }) });
    logShadow({ dataDir, prompt, result: r });
    return; // 影子进程静默退出
  }
  if (has('--classify')) {
    // prompt 取值:--prompt <b64> 优先;否则取 --classify 后面第一个非选项参数(旧写法会把紧跟的 --l2 当成 prompt)
    const prompt = argv.includes('--prompt') ? unb64(val('--prompt', '')) : (argv.slice(argv.indexOf('--classify') + 1).find((a) => !String(a).startsWith('-')) || '');
    const r = await classifyRoute(prompt, { dataDir, embedFn: await l2EmbedFn({ dataDir, explicit: has('--l2') }) });
    console.log(JSON.stringify(r));
    return;
  }
  if (has('--resolve')) {
    // 四档链解析(--tier R3):与代理转发同口径——快照派生四档链,resolveTier 从目标档降档级联
    const tier = String(val('--tier', 'R3')).toUpperCase();
    const cur = val('--current', '');
    const currentModel = cur.includes('/') ? { providerId: cur.split('/')[0], modelId: cur.split('/')[1] } : null;
    const cfg = readJson(path.join(dataDir, 'code-index.config.json')) || {};
    const mr = cfg.modelRouting || {};
    const upstreams = readUpstreamsSnapshot(path.join(dataDir, 'routing', 'proxy-upstreams.json'));
    const brandPriority = Array.isArray(mr.brandPriority) && mr.brandPriority.length ? mr.brandPriority : DEFAULT_BRAND_PRIORITY;
    const r = resolveTier(tier, { cfg: { ...cfg, modelRouting: { ...mr, chains: deriveTierChains(upstreams, { brandPriority, ...tierClassifyOptions(cfg, dataDir) }), providerOrder: Array.isArray(mr.providerOrder) ? mr.providerOrder : (Array.isArray(upstreams?.providerOrder?.[val('--host', 'zcode')]) ? upstreams.providerOrder[val('--host', 'zcode')] : []) } }, inventory: inventoryFromUpstreams(upstreams), health: readHealth(dataDir), currentModel });
    console.log(JSON.stringify(r));
    return;
  }
  if (has('--health-mark')) {
    const key = argv[argv.indexOf('--health-mark') + 1];
    const ttl = val('--ttl', '30m');
    const m = String(ttl).match(/^(\d+)(m|h|d)$/);
    const ms = m ? Number(m[1]) * ({ m: 60000, h: 3600000, d: 86400000 }[m[2]]) : 30 * 60 * 1000;
    console.log(JSON.stringify({ marked: markHealth({ dataDir, modelKey: key, reason: val('--reason', ''), ttlMs: ms }) }));
    return;
  }
  if (has('--health-clear')) { console.log(JSON.stringify({ cleared: clearHealth({ dataDir, modelKey: argv[argv.indexOf('--health-clear') + 1] }) })); return; }
  if (has('--health-list')) { console.log(JSON.stringify(readHealth(dataDir).models || {})); return; }
  if (has('--score-golden')) {
    console.log(JSON.stringify(scoreGolden({ dataDir, goldenFile: val('--golden', null) }), null, 1));
    return;
  }
  if (has('--score-golden-tier')) {
    console.log(JSON.stringify(scoreGoldenTier({ dataDir, goldenFile: val('--golden', null) }), null, 1));
    return;
  }
  if (has('--score-golden-dual')) {
    console.log(JSON.stringify(scoreGoldenDual({ dataDir, goldenFile: val('--golden', null) }), null, 1));
    return;
  }
  if (has('--doctor')) {
    const cur = val('--current', '');
    const currentModel = cur.includes('/') ? { providerId: cur.split('/')[0], modelId: cur.split('/')[1] } : null;
    console.log(JSON.stringify(doctor({ dataDir, currentModel, host: val('--host', 'zcode') }), null, 1));
    return;
  }
  if (has('--kpi')) {
    // KPI 可测指标(#14 保留项,只读):升级触发率(P2 escalated)+ 每 session 切换数 + 缓存命中率。
    // 数据源=proxy-usage.jsonl;季度校准=重跑看趋势,不自动调参。
    const file = val('--usage', path.join(DATA_DIR, 'usage', 'proxy-usage.jsonl'));
    let rows = [];
    try {
      rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { /* 无账本 → 全零报表 */ }
    const total = rows.length;
    const convs = new Map();
    let switched = 0, escalated = 0, cacheRead = 0, inputSum = 0, cacheRows = 0;
    for (const r of rows) {
      if (r.switched === true) switched += 1;
      if (r.escalated === true) escalated += 1;
      if (r.conv != null) convs.set(r.conv, (convs.get(r.conv) || 0) + 1);
      if (r.cacheReported === true) {
        cacheRows += 1;
        cacheRead += Number(r.cacheRead) || 0;
        inputSum += (Number(r.inTok) || 0) + (Number(r.cacheRead) || 0);
      }
    }
    console.log(JSON.stringify({
      window: { from: rows[0]?.ts ?? null, to: rows[total - 1]?.ts ?? null },
      totalRequests: total,
      sessions: convs.size,
      switchRate: total ? Number((switched / total).toFixed(3)) : null,
      avgSwitchesPerSession: convs.size ? Number((switched / convs.size).toFixed(2)) : null,
      escalatedRequests: escalated,
      escalateRate: total ? Number((escalated / total).toFixed(3)) : null,
      cacheHitRate: inputSum > 0 ? Number((cacheRead / inputSum).toFixed(3)) : null,
      cacheSampledRows: cacheRows,
    }, null, 1));
    return;
  }
  console.error('用法: node modelRoute.mjs --build-vectors | --classify [--l2] "<prompt>" | --shadow-async --prompt <b64> | --resolve --tier R3 [--current p/m] | --score-golden [--golden 文件] | --score-golden-tier [--golden 文件] | --doctor [--current p/m] [--host zcode|qoder] | --kpi [--usage 文件] | --health-mark <provider/model> | --health-clear <key> | --health-list');
  process.exit(1);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) cli(process.argv).catch((e) => { console.error('[err]', e.message); process.exit(1); });

