#!/usr/bin/env node
/** poller.mjs 双通道测试(tray 方案 §16.2/§18-E2):节拍纯函数边界、mtime 门控、解析失败回退、
 *  慢通道 status 成功/失败路径与钩子灯刷新、embed.log 尾读与 modelStatus 真源互验。启动:node ../test/tray/poller.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEmbedProgress as realProgress } from '../../code-index/modelStatus.mjs';
import { FAST_IDLE_MS, SLOW_INTERVAL_MS, STALE_AFTER_MS, LAMP_STALE_MS, nextDelayMs, isCacheStale, shouldSlowRefresh, needsLampRefresh, createPoller } from '../../tray/src/poller.mjs';
import * as statusFile from '../../tray/src/util/statusFile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-poller-'));

// ---------- 1) 节拍纯函数(快通道一律 5s/慢 ≥60s/stale >10min) ----------
{
  assert.equal(FAST_IDLE_MS, 5000);
  assert.equal(SLOW_INTERVAL_MS, 60000);
  assert.equal(STALE_AFTER_MS, 600000);
  assert.equal(nextDelayMs({ embedPid: 123 }), 5000, '代码索引嵌入中仍 5s');
  assert.equal(nextDelayMs({ embedPid: null }), 5000, '空闲 5s');
  assert.equal(nextDelayMs(null), 5000, '无健康数据按空闲');
  assert.equal(isCacheStale(null), true, '从未拿到缓存=stale');
  assert.equal(isCacheStale(Date.now() - 600001), true, '>10min=stale');
  assert.equal(isCacheStale(Date.now() - 599999), false, '≤10min 不 stale');
  // 模型灯过期判定(2026-11-15 B):非绿且缓存>60s 才值得慢刷
  const yellowLamps = { models: { embedding: 'yellow', reranker: 'green', decision: 'green' } };
  const greenLamps = { models: { embedding: 'green', reranker: 'green', decision: 'green' } };
  assert.equal(needsLampRefresh(yellowLamps, Date.now() - LAMP_STALE_MS - 1), true, '非绿+缓存>60s=需刷');
  assert.equal(needsLampRefresh(yellowLamps, Date.now() - 30_000), false, '非绿但缓存新=不刷');
  assert.equal(needsLampRefresh(greenLamps, Date.now() - 10 * 60_000), false, '全绿不刷(零成本)');
  assert.equal(needsLampRefresh(yellowLamps, null), false, '无缓存时间不刷(stale 通道负责)');
  assert.equal(shouldSlowRefresh({ lastSlowAt: 0, nowMs: 60000 }), true, '到 60s 即慢刷');
  assert.equal(shouldSlowRefresh({ lastSlowAt: 1000, nowMs: 60099 }), false, '未到 60s 不慢刷');
  assert.equal(shouldSlowRefresh({ lastSlowAt: Date.now() - 1000, nowMs: Date.now(), stale: true }), true, 'stale 无视间隔立即慢刷');
}

// ---------- 2) statusFile 纯读:embed.log 尾读与真源互验 + chunks 行数 + 损坏 JSON 回退 ----------
{
  const log = path.join(tmp, 'embed.log');
  fs.writeFileSync(log, ['[info] 载入 5048 个块', '[info] 增量:复用 5032 / 待嵌入 16(共 5048)', '[progress] 嵌入 4/16', '[progress] 嵌入 15/16'].join('\n'));
  assert.deepEqual(statusFile.readEmbedProgress(log), { done: 15, total: 16, pct: 94 }, '取最后一条 progress');
  assert.deepEqual(statusFile.readEmbedProgress(log), realProgress(log), '与 modelStatus.readEmbedProgress 真源一致');
  fs.writeFileSync(log, '[progress] 嵌入 16/16\n[ok] 完成');
  assert.equal(statusFile.readEmbedProgress(log).pct, 100, '完成后 100%');
  assert.equal(statusFile.readEmbedProgress(path.join(tmp, 'no.log')), null, '无日志=null');
  const chunks = path.join(tmp, 'chunks.jsonl');
  fs.writeFileSync(chunks, '{"a":1}\n{"a":2}\n{"a":3}\n');
  assert.equal(statusFile.countChunksLines(tmp), 3, '行数=3');
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ broken');
  const hc = path.join(tmp, 'model-health-cache.json');
  fs.writeFileSync(hc, '{"at":1,"health":{"x":1}}');
  const d2 = path.join(tmp, 'd2');
  fs.mkdirSync(d2);
  fs.writeFileSync(path.join(d2, 'model-health-cache.json'), '{ broken');
  assert.equal(statusFile.readHealthCache(d2), null, '损坏 JSON→null(调用方回退上次值)');
  assert.equal(statusFile.readConsentFile(d2), null, '无 consent 文件=null(未配置≠已拒绝)');
  const exDir = path.join(tmp, 'ex');
  fs.mkdirSync(path.join(exDir, 'routing'), { recursive: true });
  fs.writeFileSync(path.join(exDir, 'routing', 'exemplars.json'), JSON.stringify({ stats: { total: 528 }, exemplars: [{ id: 'a' }] }));
  assert.equal(statusFile.countExemplars(exDir), 528, '样本条数取 stats.total');
  fs.writeFileSync(path.join(exDir, 'routing', 'exemplars.json'), JSON.stringify({ exemplars: [{ id: 'a' }, { id: 'b' }] }));
  assert.equal(statusFile.countExemplars(exDir), 2, '无 stats.total 时数数组');
  fs.writeFileSync(path.join(exDir, 'routing', 'exemplars.json'), '{ broken');
  assert.equal(statusFile.countExemplars(exDir), null, '损坏样本库=null');
  assert.equal(statusFile.countExemplars(path.join(tmp, 'no-ex')), null, '无样本库=null');
  fs.writeFileSync(path.join(exDir, 'routing', 'build-vectors.progress.json'), JSON.stringify({ covered: 400, total: 528, pid: process.pid }));
  assert.deepEqual(statusFile.readBuildVectorsProgress(exDir), { covered: 400, total: 528, pid: process.pid }, '决策嵌入进度');
  fs.writeFileSync(path.join(exDir, 'routing', 'build-vectors.progress.json'), '{ broken');
  assert.equal(statusFile.readBuildVectorsProgress(exDir), null, '损坏进度=null');
  fs.writeFileSync(path.join(exDir, 'embed-progress.json'), JSON.stringify({ done: 400, total: 5063, pid: process.pid }));
  assert.deepEqual(statusFile.readEmbedProgressFile(exDir), { done: 400, total: 5063, pid: process.pid }, '代码索引嵌入进度(2026-11-21)');
  fs.writeFileSync(path.join(exDir, 'embed-progress.json'), '{ broken');
  assert.equal(statusFile.readEmbedProgressFile(exDir), null, '损坏嵌入进度=null');
  fs.writeFileSync(path.join(exDir, 'embed-progress.json'), JSON.stringify({ done: -1, pid: process.pid }));
  assert.equal(statusFile.readEmbedProgressFile(exDir), null, '负 done=null');
  fs.writeFileSync(path.join(exDir, '.embed.pid'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  assert.equal(statusFile.readLiveEmbedPid(exDir), process.pid, '活进程 pid 可读');
  fs.writeFileSync(path.join(exDir, '.embed.pid'), JSON.stringify({ pid: 2147483646, ts: Date.now() }));
  assert.equal(statusFile.readLiveEmbedPid(exDir), null, '死 pid 不算在嵌');
}

// ---------- 3) fastTick:mock 数据面组快照 + mtime 门控 + 解析失败回退上次值 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'fast-'));
  fs.mkdirSync(path.join(dir, 'vectors', 'ollama'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'routing'), { recursive: true });
  const cacheFile = path.join(dir, 'model-health-cache.json');
  const health = { modelIn: 'ollama', embedPid: null, signatureStale: false, snapshotOk: true, embedInstalled: true, embedRunning: true, rerankInstalled: true, rerankRunning: true, decisionInstalled: true, decisionRunning: true, models: { embedding: 'qwen3-embedding:0.6b', reranker: 'r', localEmbedding: 'l', localReranker: 'lr', localDecision: 'ld' } };
  fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), health }));
  fs.writeFileSync(path.join(dir, 'chunks.jsonl'), `${'{"c":1}\n'.repeat(10)}`);
  fs.writeFileSync(path.join(dir, 'vectors', 'ollama', 'meta.json'), JSON.stringify({ model: 'qwen3-embedding:0.6b', backend: 'ollama', chunks: 10 }));
  fs.writeFileSync(path.join(dir, 'vectors', 'ollama', 'embeddings.bin'), 'x');
  const slug = 'ollama-qwen3-embedding-0.6b-b5c1cbf5';
  fs.writeFileSync(path.join(dir, 'routing', `exemplars-vectors.local.${slug}.json`), JSON.stringify({ ok: 261, vectors: {} }));
  fs.writeFileSync(path.join(dir, 'routing', `exemplars-vectors.base.${slug}.json`), JSON.stringify({ ok: 302, vectors: {} }));
  fs.writeFileSync(path.join(dir, 'tray-consent.json'), JSON.stringify({ uploadLocalKnn: true, consentedAt: '2026-11-15T00:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'last-status.txt'), '⚙ 测试状态句\n');

  const io = { ...statusFile };
  let ioReads = 0;
  const origCache = io.readHealthCache;
  io.readHealthCache = (...a) => { ioReads++; return origCache(...a); };
  const snaps = [];
  const cmdRun = async (family) => ({ code: 0, stdout: family === 'status' ? '⚙ 慢刷状态句' : (family === 'hooksStatus' ? JSON.stringify({ zcode: { state: 'green' }, cursor: { state: 'green' }, qoder: { state: 'green' } }) : ''), stderr: '', skipped: false });
  let tick = 0;
  const poller = createPoller({ paths: { dataDir: dir, codeIndexRoot: 'C:/ci', nodeBin: 'node', hfCacheDir: null }, cmdRun, io, now: () => 1_000_000 + tick++ * 1000, onSnapshot: (s) => snaps.push(s) });

  const s1 = poller.fastTick();
  assert.equal(s1.lamps.models.embedding, 'green', '模型灯绿');
  assert.equal(s1.models.embedding, 'qwen3-embedding:0.6b', '快照透传模型名(tooltip 用,2026-11-17)');
  assert.equal(s1.lamps.embed, 'green', '嵌入灯绿(meta.chunks=10=行数,新鲜)');
  assert.equal(s1.lamps.knn, 'green', 'KNN 双层齐=绿');
  assert.equal(s1.consent.uploadLocalKnn, true, 'consent 透传');
  assert.ok(s1.statusLine || s1.statusLine === null, '快照含状态行字段');
  const reads1 = ioReads;
  poller.fastTick(); // mtime 未变:不重解析
  assert.equal(ioReads, reads1, 'mtime 未变不重读 health-cache');

  // 嵌入中实时进度(2026-11-21):meta 降到 4(旧水位),.embed.pid 活锁 + embed-progress.json done=6
  fs.writeFileSync(path.join(dir, 'vectors', 'ollama', 'meta.json'), JSON.stringify({ model: 'qwen3-embedding:0.6b', backend: 'ollama', chunks: 4 }));
  fs.writeFileSync(path.join(dir, '.embed.pid'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  fs.writeFileSync(path.join(dir, 'embed-progress.json'), JSON.stringify({ done: 6, total: 10, pid: process.pid }));
  const s2 = poller.fastTick();
  assert.equal(s2.embedPid, process.pid, '嵌入中快通道读到活 pid');
  assert.equal(s2.lamps.detail.embedDone, 6, '嵌入中分子=进度 done(max(旧 meta 4, 6))');
  assert.equal(s2.lamps.detail.embedPct, 60, '嵌入中比例实时 6/10=60%');
  // pid 不一致的残留进度文件不被采纳(分子回落旧口径,条不闪跳)
  fs.writeFileSync(path.join(dir, 'embed-progress.json'), JSON.stringify({ done: 9, total: 10, pid: 2147483646 }));
  const s2b = poller.fastTick();
  assert.equal(s2b.lamps.detail.embedDone, 4, '死 pid 进度文件不进分子');
  fs.rmSync(path.join(dir, '.embed.pid'), { force: true });
  fs.rmSync(path.join(dir, 'embed-progress.json'), { force: true });

  // 损坏写入(mtime 变)→ 回退上次值:快照仍能出灯,不炸
  fs.writeFileSync(cacheFile, '{ broken');
  const s3 = poller.fastTick();
  assert.equal(s3.lamps.models.embedding, 'green', '解析失败回退上次健康值');

  // 慢刷:先让 tick 触发的慢刷落地(in-flight 门),再手动慢刷取回快照
  await new Promise((r) => setTimeout(r, 30));
  const s4 = await poller.slowRefresh('manual');
  assert.equal(s4.statusLine, '⚙ 慢刷状态句', '慢刷采 status.mjs stdout');
  assert.deepEqual(s4.lamps.hooks, { zcode: 'green', cursor: 'green', qoder: 'green' }, '钩子灯随慢刷刷新');

  // status 失败 → 回退 last-status.txt
  const poller2 = createPoller({ paths: { dataDir: dir, codeIndexRoot: 'C:/ci', nodeBin: 'node' }, io, cmdRun: async () => ({ code: 1, stdout: '', stderr: 'x', skipped: false }), now: () => 9_000_000, onSnapshot: () => {} });
  await poller2.slowRefresh('manual');
  assert.equal(poller2.state.statusLine, '⚙ 测试状态句', 'status.mjs 失败回退读 last-status.txt');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 4) stale 触发慢刷(>10min 缓存)与 dataDir 缺失的 degraded 态 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'stale-'));
  fs.writeFileSync(path.join(dir, 'model-health-cache.json'), JSON.stringify({ at: 1, health: { modelIn: 'ollama' } }));
  const slowCalls = [];
  const poller = createPoller({
    paths: { dataDir: dir, codeIndexRoot: 'C:/ci', nodeBin: 'node' },
    io: statusFile,
    cmdRun: async (family) => { slowCalls.push(family); return { code: 0, stdout: family === 'status' ? '⚙ ok' : '{}', stderr: '', skipped: false }; },
    now: () => 20_000_000, // 缓存 at=1 → 远超 10min
    onSnapshot: () => {},
  });
  const s = poller.fastTick();
  assert.equal(s.stale, true, '缓存陈旧标记');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(slowCalls.includes('status'), 'stale 立即触发慢通道 status');
  const deg = createPoller({ paths: { dataDir: null, codeIndexRoot: 'C:/ci', nodeBin: 'node' }, io: statusFile, cmdRun: async () => ({ code: 0, stdout: '', stderr: '', skipped: false }), now: () => 1, onSnapshot: () => {} });
  const ds = deg.fastTick();
  assert.equal(ds.degraded, true, 'paths 降级标记 degraded');
  assert.equal(ds.lamps.embed, 'empty', '无 dataDir 读不到 chunks.jsonl→empty(degraded 态不谎报红)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 4) 决策嵌入中:进度文件抬高 knn 分子,代码索引灯不改判,轮询仍 5 秒 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'knnprog-'));
  fs.mkdirSync(path.join(dir, 'vectors', 'ollama'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'routing'), { recursive: true });
  const health = { modelIn: 'ollama', embedPid: null, signatureStale: false, snapshotOk: true, embedInstalled: true, embedRunning: true, rerankInstalled: true, rerankRunning: true, decisionInstalled: true, decisionRunning: true, models: { embedding: 'qwen3-embedding:0.6b', reranker: 'r', localEmbedding: 'l', localReranker: 'lr', localDecision: 'ld' } };
  fs.writeFileSync(path.join(dir, 'model-health-cache.json'), JSON.stringify({ at: Date.now(), health }));
  fs.writeFileSync(path.join(dir, 'chunks.jsonl'), `${'{"c":1}\n'.repeat(10)}`);
  fs.writeFileSync(path.join(dir, 'vectors', 'ollama', 'meta.json'), JSON.stringify({ model: 'qwen3-embedding:0.6b', backend: 'ollama', chunks: 10 }));
  fs.writeFileSync(path.join(dir, 'vectors', 'ollama', 'embeddings.bin'), 'x');
  const slug = 'ollama-qwen3-embedding-0.6b-b5c1cbf5';
  fs.writeFileSync(path.join(dir, 'routing', `exemplars-vectors.local.${slug}.json`), JSON.stringify({ ok: 261, vectors: {} }));
  fs.writeFileSync(path.join(dir, 'routing', 'exemplars.json'), JSON.stringify({ stats: { total: 528 }, exemplars: [] }));
  fs.writeFileSync(path.join(dir, '.embed.pid'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  fs.writeFileSync(path.join(dir, 'routing', 'build-vectors.progress.json'), JSON.stringify({ covered: 400, total: 528, pid: process.pid }));
  const poller = createPoller({ paths: { dataDir: dir, codeIndexRoot: 'C:/ci', nodeBin: 'node', hfCacheDir: null }, io: statusFile, cmdRun: async () => ({ code: 0, stdout: '', stderr: '', skipped: false }), now: () => Date.now(), onSnapshot: () => {} });
  const s = poller.fastTick(false);
  assert.equal(s.embedPid, process.pid, '快通道读到活 pid,不等健康缓存');
  assert.equal(s.lamps.embed, 'green', '决策嵌入不把代码索引灯打成部分嵌入');
  assert.equal(s.lamps.detail.knnDone, 400, '进度覆盖旧向量条数');
  assert.equal(s.lamps.detail.knnTotal, 528, '分母仍是样本库');
  assert.equal(poller.nextDelayMs(), 5000, '决策嵌入仍 5 秒一刷');
  fs.writeFileSync(path.join(dir, 'routing', 'build-vectors.progress.json'), JSON.stringify({ covered: 10, total: 528, pid: process.pid }));
  const early = poller.fastTick(false);
  assert.equal(early.lamps.detail.knnDone, 261, '进度小于已有向量时保持旧条数');
  fs.unlinkSync(path.join(dir, 'routing', 'build-vectors.progress.json'));
  poller.fastTick(false);
  assert.equal(poller.nextDelayMs(), 5000, '代码索引嵌入仍 5 秒一刷');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] poller.test.mjs 全部通过(节拍边界 + mtime 门控 + 回退链 + 慢通道双路径 + 真源互验)');
