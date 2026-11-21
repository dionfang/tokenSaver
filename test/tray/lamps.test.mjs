#!/usr/bin/env node
/** lamps.mjs 四组状态灯测试(tray 方案 §5.3.1-5.3.4/§6):真实快照+黄/红/empty 变体全分支;
 *  slug 镜像与 code-index/vectorLayers 真源互验;禁 pct 判绿由「块数不等→黄」分支守护。启动:node ../test/tray/lamps.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vectorsSlug, vectorsLayerPaths } from '../../code-index/vectorLayers.mjs';
import { vectorsSlugFor, currentEmbedModelName, knnLayerPaths, modelLamps, embedLamp, knnLamp, hooksLamps, computeLamps, appTooltip } from '../../tray/src/util/lamps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const realCache = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'model-health-cache.real.json'), 'utf8'));
const realMeta = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'model-meta.real.json'), 'utf8'));
const realHealth = realCache.health;
const DATA_DIR = 'D:/__no_such_data_dir__';

// ---------- 1) slug 镜像与真源逐字节互验(运行时从 health-cache 派生,禁 import 的补偿) ----------
{
  const samples = ['ollama/qwen3-embedding:0.6b', 'local/Xenova/jina-embeddings-v2-base-zh', 'local/Xenova/bge-reranker-base', 'ollama/tev1:0.8b', 'strands:strands-decider-2B-hobson-v19:q4f16', '', 'X/y'];
  for (const s of samples) assert.equal(vectorsSlugFor(s), vectorsSlug(s), `slug 镜像失真:${s}`);
  assert.equal(vectorsSlugFor('ollama/qwen3-embedding:0.6b'), 'ollama-qwen3-embedding-0.6b-b5c1cbf5', '真实 slug 常量漂移(磁盘文件名将失配)');
  assert.equal(currentEmbedModelName(realHealth), 'ollama/qwen3-embedding:0.6b', '当前嵌入模型全名派生');
  const p = knnLayerPaths(DATA_DIR, realHealth);
  const real = vectorsLayerPaths(DATA_DIR, 'ollama/qwen3-embedding:0.6b');
  assert.equal(path.basename(p.local), path.basename(real.local.slugFile), 'KNN local 文件名与真源 vectorsLayerPaths 一致');
  assert.equal(path.basename(p.base), path.basename(real.base.slugFile), 'KNN base 文件名与真源一致');
}

// ---------- 2) 模型灯·ollama 分支(§5.3.1):真实快照全绿;黄=Installed&&!Running;红=!Installed ----------
{
  const g = modelLamps(realHealth);
  assert.deepEqual(g, { embedding: 'green', reranker: 'green', decision: 'green' }, '真实快照三盏全绿');
  const y = modelLamps({ ...realHealth, embedRunning: false, rerankRunning: false, decisionRunning: false });
  assert.deepEqual(y, { embedding: 'yellow', reranker: 'yellow', decision: 'yellow' }, '已装未驻留=黄(LRU 驱逐态)');
  const r = modelLamps({ ...realHealth, embedInstalled: false, rerankInstalled: false, decisionInstalled: false, embedRunning: false, rerankRunning: false, decisionRunning: false });
  assert.deepEqual(r, { embedding: 'red', reranker: 'red', decision: 'red' }, '未安装=红');
  const half = modelLamps({ ...realHealth, embedRunning: false, rerankInstalled: false, rerankRunning: false });
  assert.deepEqual(half, { embedding: 'yellow', reranker: 'red', decision: 'green' }, '三盏独立判定互不牵连');
}

// ---------- 3) 模型灯·local 分支(§5.3.1):绿=Ready / 黄=权重在未起(或未知) / 红=权重缺失 ----------
{
  const localHealth = { ...realHealth, modelIn: 'local', localEmbeddingReady: true, localRerankerReady: true, decisionOk: true };
  assert.deepEqual(modelLamps(localHealth), { embedding: 'green', reranker: 'green', decision: 'green' }, 'local 全绿');
  const w = modelLamps({ ...localHealth, localEmbeddingReady: false }, { localWeights: { embedding: true, reranker: true, decision: true } });
  assert.equal(w.embedding, 'yellow', '权重在 hf-cache 但常驻未起=黄');
  assert.equal(w.reranker, 'green', 'ready 即绿,权重检查不拖累已就绪灯');
  const miss = modelLamps({ ...localHealth, localEmbeddingReady: false, localRerankerReady: false, decisionOk: false }, { localWeights: { embedding: false, reranker: false, decision: false } });
  assert.deepEqual(miss, { embedding: 'red', reranker: 'red', decision: 'red' }, '权重缺失=红');
  const unknown = modelLamps({ ...localHealth, localEmbeddingReady: null }, {});
  assert.equal(unknown.embedding, 'yellow', '权重存在性未知=保守黄,不误判红');
}

// ---------- 4) 嵌入灯(§5.3.2,含铁律:块数全量真值,不看 embed.log pct) ----------
{
  // 真实快照:signatureStale=true → 黄(无论块数)
  const r = embedLamp({ health: realHealth, vectors: { embExists: true, meta: realMeta }, chunksLines: 5047 });
  assert.equal(r.lamp, 'yellow', '真实快照=黄(签名过期)');
  assert.ok(r.reasons.some((x) => x.includes('签名过期')), `原因注明:${r.reasons}`);
  // 绿:全量+新鲜+快照可用+无 pid+模型一致
  const green = embedLamp({ health: { ...realHealth, signatureStale: false }, vectors: { embExists: true, meta: realMeta }, chunksLines: 5047 });
  assert.equal(green.lamp, 'green', '全量且新鲜=绿');
  assert.deepEqual(green.reasons, [], '绿无原因');
  // 黄:块数不等(5047≠5063,铁律主场景:增量续嵌未完)
  const drift = embedLamp({ health: { ...realHealth, signatureStale: false }, vectors: { embExists: true, meta: realMeta }, chunksLines: 5063 });
  assert.equal(drift.lamp, 'yellow', 'meta.chunks≠chunks.jsonl 行数=黄');
  // 黄:正在嵌入(pid 存活)
  const pid = embedLamp({ health: { ...realHealth, embedPid: 4321 }, vectors: { embExists: true, meta: realMeta }, chunksLines: 5047 });
  assert.equal(pid.lamp, 'yellow', 'embedPid 存活=黄(嵌入中)');
  // 黄:快照不自洽
  assert.equal(embedLamp({ health: { ...realHealth, signatureStale: false, snapshotOk: false }, vectors: { embExists: true, meta: realMeta }, chunksLines: 5047 }).lamp, 'yellow', 'snapshotOk=false=黄');
  // 黄:模型不符(配置换了模型未重嵌)
  assert.equal(embedLamp({ health: { ...realHealth, signatureStale: false, models: { ...realHealth.models, embedding: 'qwen3-embedding:1b' } }, vectors: { embExists: true, meta: realMeta }, chunksLines: 5047 }).lamp, 'yellow', 'meta.model≠当前模型=黄');
  // 红:无 embeddings / 无 meta
  assert.equal(embedLamp({ health: realHealth, vectors: { embExists: false, meta: realMeta }, chunksLines: 100 }).lamp, 'red', '无 embeddings.bin=红');
  assert.equal(embedLamp({ health: realHealth, vectors: { embExists: true, meta: null }, chunksLines: 100 }).lamp, 'red', '无 meta=红');
  // empty:roots=0(无 chunks.jsonl)
  const e = embedLamp({ health: realHealth, vectors: { embExists: false, meta: null }, chunksLines: null });
  assert.equal(e.lamp, 'empty', '无 chunks.jsonl=empty(不判红)');
  assert.ok(e.reasons[0].includes('未选目录'), 'empty 附无内容文案');
}

// ---------- 5) KNN 灯(§5.3.3):红=缺 local / 黄=缺 base / 绿=齐(2026-11-15 用户裁决:consent 不再影响灯与文案) ----------
{
  const both = { localExists: true, baseExists: true, baseEntries: 302, localEntries: 261 };
  assert.equal(knnLamp({ knn: both }).lamp, 'green', '双层齐=绿');
  const noBase = knnLamp({ knn: { ...both, baseExists: false, baseEntries: null } });
  assert.equal(noBase.lamp, 'yellow', '缺 base=黄');
  assert.ok(noBase.notes[0].includes('base'), '黄注明缺哪层');
  assert.ok(!noBase.notes.join().includes('未同意上传'), '面板不出现互惠文案(用户裁决 2026-11-15)');
  assert.equal(knnLamp({ knn: { ...both, localExists: false } }).lamp, 'red', '缺 local=红');
  // consent 任意取值不影响灯色:双层齐即绿(互惠约束只在「更新 base」按钮门禁,§16.3)
  assert.equal(knnLamp({ knn: both }).lamp, 'green', 'consent 缺省双层齐仍绿');
  assert.equal(knnLamp({ knn: { ...both, localExists: false } }).lamp, 'red', '缺 local 优先判红');
  assert.equal(knnLamp({ knn: null }).lamp, 'red', '无 KNN 输入=红');
}

// ---------- 6) 钩子灯(§5.3.4):三态映射,拿不到结果不判红 ----------
{
  const h = hooksLamps({ zcode: { state: 'green' }, cursor: { state: 'red' }, qoder: { state: 'absent' } });
  assert.deepEqual(h, { zcode: 'green', cursor: 'red', qoder: 'absent' }, '三端三态直通');
  assert.deepEqual(hooksLamps(null), { zcode: 'absent', cursor: 'absent', qoder: 'absent' }, '无结果=absent(未检测≠错误)');
  assert.deepEqual(hooksLamps({ zcode: { state: 'weird' } }).zcode, 'absent', '非法态兜底 absent');
}

// ---------- 7) computeLamps 端到端(§6 契约) + 真实磁盘 slug 文件名核对 ----------
{
  const out = computeLamps({
    health: realHealth,
    vectors: { embExists: true, meta: realMeta },
    chunksLines: 5063,
    knn: { localExists: true, baseExists: false, baseEntries: null, localEntries: 261 },
    hooks: { zcode: { state: 'green' }, cursor: { state: 'green' }, qoder: { state: 'green' } },
    consent: { uploadLocalKnn: false },
    progress: { done: 4, total: 16, pct: 25 },
  });
  assert.deepEqual(Object.keys(out).sort(), ['detail', 'embed', 'hooks', 'knn', 'models'], '契约顶层字段');
  assert.deepEqual(out.models, { embedding: 'green', reranker: 'green', decision: 'green' });
  assert.equal(out.embed, 'yellow', '真实快照嵌入灯=黄(签名过期+块数漂移)');
  assert.equal(out.knn, 'yellow', '本机现状=黄(缺 base+未同意)');
  assert.equal(out.detail.missing, 'baseKnn', 'missing 指到 baseKnn');
  // 总体口径(2026-11-15):done=meta.chunks / total=chunksLines,与 progress 入参无关
  assert.equal(out.detail.embedTotal, 5063, '总索引块=chunksLines');
  assert.equal(out.detail.embedDone, realMeta.chunks, '已嵌=向量 meta.chunks');
  assert.equal(out.detail.embedPct, realMeta.chunks >= 5063 ? 100 : Math.floor((realMeta.chunks / 5063) * 100), '总体比例=floor(done/total),仅满才 100');
  // 嵌入中实时分子(2026-11-21):embedCovered 来自 embed-progress.json(done=复用+已嵌,总体口径)
  {
    const base = { health: realHealth, vectors: { embExists: true, meta: realMeta }, chunksLines: 5063 };
    const climb = computeLamps({ ...base, embedCovered: 5050 });
    assert.equal(climb.detail.embedDone, 5050, '嵌入中分子=进度 done(>meta.chunks)');
    assert.equal(climb.detail.embedPct, Math.floor((5050 / 5063) * 100), '嵌入中比例跟着 done 实时爬');
    const noDip = computeLamps({ ...base, embedCovered: 3 });
    assert.equal(noDip.detail.embedDone, realMeta.chunks, '进度未追上旧 meta 时不回退');
    assert.equal(computeLamps(base).detail.embedDone, realMeta.chunks, '无进度入参=旧口径 meta.chunks');
    assert.equal(computeLamps({ ...base, embedCovered: 999999 }).detail.embedPct, 100, 'covered 超总数封顶 100');
  }
  // 决策装填:local 向量条数 / exemplars.json 样本条数
  {
    const withEx = computeLamps({ health: realHealth, vectors: { embExists: true, meta: realMeta }, chunksLines: 5063, knn: { localExists: true, baseExists: true, baseEntries: 302, localEntries: 261 }, exemplarCount: 528 });
    assert.equal(withEx.detail.knnDone, 261, 'knn 分子=local 向量条数');
    assert.equal(withEx.detail.knnTotal, 528, 'knn 分母=样本库条数');
    assert.equal(withEx.detail.knnPct, Math.floor((261 / 528) * 100), 'knn 比例=floor(local/exemplars)');
    const climbing = computeLamps({ knn: { localExists: true, baseExists: true, localEntries: 261 }, exemplarCount: 528, knnCovered: 400 });
    assert.equal(climbing.detail.knnDone, 400, '嵌入中分子=进度 covered');
    assert.equal(climbing.detail.knnPct, Math.floor((400 / 528) * 100), '嵌入中比例跟着 covered');
    const noDip = computeLamps({ knn: { localExists: true, baseExists: true, localEntries: 261 }, exemplarCount: 528, knnCovered: 10 });
    assert.equal(noDip.detail.knnDone, 261, '进度未追上已有向量时不回退');
    assert.equal(computeLamps({ health: realHealth, vectors: { embExists: true, meta: realMeta }, chunksLines: 5063, knn: { localExists: true, baseExists: true, localEntries: 500 }, exemplarCount: 467 }).detail.knnPct, 100, 'local≥样本库 封顶 100');
    assert.equal(computeLamps({ knn: { localExists: true, baseExists: true, localEntries: 1 }, exemplarCount: null }).detail.knnPct, null, '无样本库=null 不捏造');
    assert.equal(withEx.detail.knnBaseDone, 302, '公共包已下载=base 条目数');
    assert.equal(withEx.detail.knnBaseTotal, 302, '公共包分母=包内自身条数(自含权威层,2026-11-19)');
    assert.equal(withEx.detail.knnBasePct, 100, '公共包存在即完整→100% 绿满条');
    // 2026-11-19 回归:全新机本地样本=0/null,base 已下载仍应 100%(旧分母=exemplarCount→0→pct=null 不变绿)
    const fresh = computeLamps({ knn: { localExists: false, baseExists: true, baseEntries: 624, localEntries: 0 }, exemplarCount: 0 });
    assert.equal(fresh.detail.knnBaseDone, 624, '全新机 base 分子=624');
    assert.equal(fresh.detail.knnBaseTotal, 624, '全新机分母=624(不依赖本地样本)');
    assert.equal(fresh.detail.knnBasePct, 100, '全新机 base 下载完=100% 绿');
    const freshNull = computeLamps({ knn: { localExists: false, baseExists: true, baseEntries: 123, localEntries: 0 }, exemplarCount: null });
    assert.equal(freshNull.detail.knnBasePct, 100, 'exemplarCount=null 仍 100%(123/123)');
    const noBaseFresh = computeLamps({ knn: { localExists: true, baseExists: false, baseEntries: null, localEntries: 5 }, exemplarCount: 5 });
    assert.equal(noBaseFresh.detail.knnBaseDone, null, '未下载 base done=null(灰条)');
    assert.equal(noBaseFresh.detail.knnBasePct, null, '未下载 base pct=null');
    const noBase = computeLamps({ health: realHealth, vectors: { embExists: true, meta: realMeta }, chunksLines: 5063, knn: { localExists: true, baseExists: false, localEntries: 261 }, exemplarCount: 528 });
    assert.equal(noBase.detail.knnBaseDone, null, '公共包未下载=done null');
    assert.equal(noBase.detail.knnBasePct, null, '未下载不捏造比例');
  }
  assert.equal(out.detail.localEntries, 261, 'local 条数透传');
  // missing 优先级:模型红 > localKnn 红 > baseKnn 黄
  assert.equal(computeLamps({ health: { ...realHealth, embedInstalled: false, embedRunning: false }, vectors: { embExists: true, meta: realMeta }, chunksLines: 5047, knn: { localExists: false, baseExists: false }, consent: { uploadLocalKnn: true } }).detail.missing, 'embedding', '模型红优先');
  const realData = path.resolve(here, '..', '..', 'data');
  if (fs.existsSync(path.join(realData, 'routing'))) {
    const lp = knnLayerPaths(realData, realHealth);
    assert.ok(fs.existsSync(lp.local), `真实 local slug 文件存在:${path.basename(lp.local)}(slug 与生产文件名一致)`);
  }
}

// ---------- appTooltip:托盘悬浮=火绒式三行(20261120 用户裁定:产品名/客户端版本/公共决策包 builtAt) ----------
{
  assert.equal(appTooltip({}, '0.2.6'), 'TokenSaver\n版本:0.2.6\n公共决策包:未导入', '无 base⇒第三行未导入');
  assert.equal(appTooltip({ lamps: { detail: { baseBuiltAt: '2026-11-18T15:45:55.853Z' } } }, '0.2.6'),
    'TokenSaver\n版本:0.2.6\n公共决策包:2026-11-18 15:45', 'builtAt 截到分钟(T→空格,火绒病毒库行同风格)');
  assert.equal(appTooltip({ lamps: {} }, null), 'TokenSaver\n版本:未知\n公共决策包:未导入', '缺版本回落未知');
  assert.ok(appTooltip({ lamps: { detail: { baseBuiltAt: '2026-11-18T15:45:55.853Z' } } }, '0.2.6').length <= 127, 'Windows tooltip 127 字符上限');
  // 传递链端到端:readKnnLayer(builtAt)→poller knnLayerInput→knnLamp→computeLamps.detail→appTooltip 第三行
  const L2 = computeLamps({ knn: { baseExists: true, localExists: true, baseEntries: 594, localEntries: 10, baseBuiltAt: '2026-11-18T15:45:55.853Z' } });
  assert.equal(L2.detail.baseBuiltAt, '2026-11-18T15:45:55.853Z', 'computeLamps 透传 baseBuiltAt 进 detail(悬浮第三行数据源)');
  assert.equal(appTooltip({ lamps: L2 }, '0.2.6').split('\n')[2], '公共决策包:2026-11-18 15:45', '端到端第三行文案');
}

console.log('[ok] lamps.test.mjs 全部通过(四组灯全形态 + slug 真源互验 + §6 契约 + tooltip 三行灯)');
