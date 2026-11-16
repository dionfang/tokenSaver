/**
 * 四组状态灯判定(tray 方案 §5.3.1-5.3.4 / §6 getLamps 契约,2026-11-15 M1)。
 * 纯函数:零 electron、零 code-index import(import 禁令 §18-E1)——一切输入由采集层
 * (poller/statusFile)以数据文件形态注入;本模块只做判定与文案。
 * 铁律(§5.3.2):禁用 embed.log 的 pct 判绿(增量模式分母是 misses.length);
 * 全量真值=向量 meta.chunks 对比 data/chunks.jsonl 实际行数。
 */
import crypto from 'node:crypto';

/** 模型名→文件名 slug(vectorLayers.mjs vectorsSlug 的镜像实现;测试里与真源逐字节互验)。
 *  托盘运行时从 health-cache 的 modelIn+models 派生全名 `${backend}/${model}`。 */
export function vectorsSlugFor(model) {
  const raw = String(model || '');
  const clean = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'default';
  const h = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${clean}-${h}`;
}

/** 当前嵌入模型全名(镜像 vectorLayers.currentEmbedModel 的派生口径,数据来自 health-cache)。 */
export function currentEmbedModelName(health) {
  const h = health || {};
  const modelIn = h.modelIn === 'local' ? 'local' : 'ollama';
  const model = modelIn === 'local' ? h.models?.localEmbedding : h.models?.embedding;
  return model ? `${modelIn}/${model}` : null;
}

/** KNN 双层文件路径(slug 命名对齐 vectorLayers.vectorsLayerPaths;判定只看 slug 形文件)。 */
export function knnLayerPaths(dataDir, health) {
  const slug = vectorsSlugFor(currentEmbedModelName(health));
  const dir = `${String(dataDir).replace(/[\\/]+$/, '')}/routing`;
  return {
    slug,
    base: `${dir}/exemplars-vectors.base.${slug}.json`,
    local: `${dir}/exemplars-vectors.local.${slug}.json`,
  };
}

/** §5.3.1 三盏模型灯。localWeights 采集层注入(hf-cache 权重目录存在性,null=未知):
 *  ollama 绿=*Running / 黄=*Installed&&!Running / 红=!Installed;
 *  local  绿=*Ready / 黄=权重在但常驻未起(或未知) / 红=权重缺失。 */
const ollamaLamp = (installed, running) => (running === true ? 'green' : installed === true ? 'yellow' : 'red');
const localReadyLamp = (ready, weightsCached) => (ready === true ? 'green' : weightsCached === false ? 'red' : 'yellow');

export function modelLamps(health, { localWeights = {} } = {}) {
  const h = health || {};
  if (h.modelIn === 'local') {
    return {
      embedding: localReadyLamp(h.localEmbeddingReady, localWeights.embedding ?? null),
      reranker: localReadyLamp(h.localRerankerReady, localWeights.reranker ?? null),
      decision: localReadyLamp(h.decisionOk === true ? true : null, h.decisionOk === true ? true : localWeights.decision ?? null),
    };
  }
  return {
    embedding: ollamaLamp(h.embedInstalled, h.embedRunning),
    reranker: ollamaLamp(h.rerankInstalled, h.rerankRunning),
    decision: ollamaLamp(h.decisionInstalled, h.decisionRunning),
  };
}

/** §5.3.2 嵌入状态灯(含 empty)。vectors={embExists,meta} 由采集层读 data/vectors/<modelIn>/。 */
export function embedLamp({ health, vectors, chunksLines }) {
  if (chunksLines == null) return { lamp: 'empty', reasons: ['未选目录,无可嵌入内容'] };
  if (!vectors || !vectors.embExists) return { lamp: 'red', reasons: ['无 embeddings.bin(当前后端目录无嵌入)'] };
  if (!vectors.meta) return { lamp: 'red', reasons: ['无向量 meta(嵌入从未完成过)'] };
  const h = health || {};
  const meta = vectors.meta;
  const reasons = [];
  if (h.embedPid != null) reasons.push(`嵌入进行中(pid ${h.embedPid})`);
  if (h.signatureStale) reasons.push('块签名过期(索引已变,向量待续嵌)');
  if (h.snapshotOk === false) reasons.push('向量与嵌入快照不一致,检索已降级 bm25');
  const expectModel = h.modelIn === 'local' ? h.models?.localEmbedding : h.models?.embedding;
  if (expectModel && meta.model !== expectModel) reasons.push(`向量模型 ${meta.model || '?'} ≠ 当前 ${expectModel}`);
  if (Number(meta.chunks) !== chunksLines) reasons.push(`向量块数 ${meta.chunks}≠索引块数 ${chunksLines}`);
  return { lamp: reasons.length ? 'yellow' : 'green', reasons };
}

/** §5.3.3 决策 KNN 灯:红=缺 local / 黄=缺 base / 绿=齐。
 * 2026-11-15 用户裁决:互惠文案(「未同意上传…」)不再上面板——consent 只影响「更新 base」按钮门禁(§16.3),
 * 灯色与文案仅由双层文件实际存在性决定。 */
export function knnLamp({ knn }) {
  const baseEntries = knn?.baseEntries ?? null;
  const localEntries = knn?.localEntries ?? null;
  const baseExists = knn?.baseExists === true;
  if (!knn || !knn.localExists) return { lamp: 'red', notes: ['本地 local 向量 KNN 不存在(先完成嵌入)'], baseEntries, localEntries, baseExists };
  if (!knn.baseExists) return { lamp: 'yellow', notes: ['base 向量包缺失(权威层不可用)'], baseEntries, localEntries, baseExists };
  return { lamp: 'green', notes: [], baseEntries, localEntries, baseExists };
}

/** §5.3.4 三端钩子灯:直接映射 hooksStatus.mjs 的 state;拿不到结果(未跑/失败)按 absent 不判红。 */
export function hooksLamps(hooksResult) {
  const pick = (r) => (typeof r?.state === 'string' && ['green', 'red', 'absent'].includes(r.state) ? r.state : 'absent');
  return { zcode: pick(hooksResult?.zcode), cursor: pick(hooksResult?.cursor), qoder: pick(hooksResult?.qoder) };
}

/** §6 getLamps 契约总装。progress 仅展示,不参与绿黄判定。 */
export function computeLamps({ health, vectors, chunksLines, knn, hooks: hooksInput, consent, progress, localWeights, exemplarCount = null, knnCovered = null } = {}) {
  const models = modelLamps(health, { localWeights });
  const embed = embedLamp({ health, vectors, chunksLines });
  const knnR = knnLamp({ knn });
  const hooks = hooksLamps(hooksInput);
  const missing = models.embedding === 'red' ? 'embedding'
    : models.reranker === 'red' ? 'reranker'
      : models.decision === 'red' ? 'decision'
        : knnR.lamp === 'red' ? 'localKnn'
          : knnR.lamp === 'yellow' ? 'baseKnn' : null;
  // 2026-11-15 用户裁决:面板进度=总体状态——done=向量 meta 已嵌块数,total=chunks.jsonl 总索引块
  // (progress 实时批次仅供内部展示用途,不再进入 detail;embedPct 由总体口径计算)
  const embedTotal = chunksLines ?? null;
  const embedDone = vectors?.meta?.chunks ?? 0;
  // 向下取整(2026-11-15 修复):四舍五入会把 99.96% 抬成 100%——绿满条与「部分嵌入」黄灯自相矛盾
  // (5214/5216 实测曾显示 100% 绿条)。仅 done≥total 才 100%,不足一律 <100 → 黄条。
  const embedPct = embedTotal > 0 ? (embedDone >= embedTotal ? 100 : Math.floor((embedDone / embedTotal) * 100)) : null;
  // 决策向量装填:当前模式 local 向量条数 / exemplars.json 样本条数。
  // 黄金集是代签量尺,不是嵌入清单,不能当成分母。
  // 嵌入过程中进度文件的 covered 可能暂时小于磁盘上的旧向量条数,取较大值,避免进度条先掉下去。
  const fileDone = knnR.localEntries ?? 0;
  const knnDone = Number.isFinite(knnCovered) ? Math.max(fileDone, knnCovered) : fileDone;
  const knnTotal = exemplarCount ?? null;
  const knnPct = knnTotal > 0 ? (knnDone >= knnTotal ? 100 : Math.floor((knnDone / knnTotal) * 100)) : null;
  // 公共决策包:已下载时分子=包内条数,分母同样是样本库条数;未下载 done=null
  const knnBaseDone = knnR.baseExists ? (knnR.baseEntries ?? 0) : null;
  const knnBaseTotal = knnTotal;
  const knnBasePct = knnBaseDone != null && knnBaseTotal > 0
    ? (knnBaseDone >= knnBaseTotal ? 100 : Math.floor((knnBaseDone / knnBaseTotal) * 100)) : null;
  return {
    models,
    embed: embed.lamp,
    knn: knnR.lamp,
    hooks,
    detail: {
      embedDone,
      embedTotal,
      embedPct,
      knnDone,
      knnTotal,
      knnPct,
      knnBaseDone,
      knnBaseTotal,
      knnBasePct,
      baseEntries: knnR.baseEntries,
      baseExists: knnR.baseExists === true,
      localEntries: knnR.localEntries,
      missing,
      embedReasons: embed.reasons,
      knnNotes: knnR.notes,
    },
  };
}
