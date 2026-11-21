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

/** 托盘悬浮提示(2026-11-17 用户裁决;2026-11-18 改文字状态词):一行一模型=状态词+类型+名。
 *  原 emoji 灯在 Windows 托盘 tooltip 单色渲染成灰圈(用户实测不分红黄绿)→ 改文字状态词,
 *  灯语义同 modelLamps(绿=正常,黄=未驻留/未缓存,红=未安装);Windows tooltip ≤127 字符,
 *  strands id 用向导同款短形 dir(quant)。纯函数,快照缺灯时给获取中兜底。 */
/** 托盘悬浮文案(20261120 用户裁定,火绒式三行):产品名 / 客户端版本 / 公共决策包标识(builtAt)。
 *  模型启动状态整块移去状态面板(悬浮只答「装的哪版、用的哪个包」);未导入 base 时第三行明示。
 *  Windows tooltip 127 字符上限,三行约 60 字符安全。 */
export function appTooltip(snapshot, version) {
  const base = snapshot?.lamps?.detail?.baseBuiltAt;
  const baseLine = base
    ? `公共决策包:${String(base).slice(0, 16).replace('T', ' ')}`
    : '公共决策包:未导入';
  return `TokenSaver\n版本:${version || '未知'}\n${baseLine}`;
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
  const baseBuiltAt = knn?.baseBuiltAt ?? null;
  if (!knn || !knn.localExists) return { lamp: 'red', notes: ['本地 local 向量 KNN 不存在(先完成嵌入)'], baseEntries, localEntries, baseExists, baseBuiltAt };
  if (!knn.baseExists) return { lamp: 'yellow', notes: ['base 向量包缺失(权威层不可用)'], baseEntries, localEntries, baseExists, baseBuiltAt };
  return { lamp: 'green', notes: [], baseEntries, localEntries, baseExists, baseBuiltAt };
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
  // 公共决策包(2026-11-19 修:下载完不变绿/无 123/123(100%)):base 是自含权威层,
  // 分母=包内自身条数(与本地样本数无关)。旧版分母=exemplarCount,全新机本地样本=0→pct=null 永不到100。
  // 导入为整文件原子落位:存在即完整 → done=total=包内条数 → 100% 绿满条。
  const knnBaseDone = knnR.baseExists ? (knnR.baseEntries ?? 0) : null;
  const knnBaseTotal = knnBaseDone;
  const knnBasePct = knnBaseDone != null ? (knnBaseTotal > 0 ? 100 : 0) : null;
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
      baseBuiltAt: knnR.baseBuiltAt ?? null,
      localEntries: knnR.localEntries,
      missing,
      embedReasons: embed.reasons,
      knnNotes: knnR.notes,
    },
  };
}
