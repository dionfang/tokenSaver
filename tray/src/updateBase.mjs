/**
 * T4 一键更新公共决策包编排(tray 方案 §5.4/§16.3/§19.1 API-1,2026-11-17 M4):
 * 同意门禁 → basepack 清单(Ed25519 验签+minClientVersion) → 按当前嵌入模型选 pack →
 * 已最新判定 → 磁盘预检+下载(sha256 硬门+原子改名) → spawn vectorBaseImport 落 base 层 →
 * 落 lastAppliedBuiltAt + 清当次临时包。失败不破坏原 base 文件(导入器原子写)。
 * 零 electron、零 code-index import(§18-E1):路径/模型名经 util/paths+util/lamps 镜像单源,
 * 导入走 cmdRunner spawn 微 CLI;同意状态经 consent.mjs(读侧 statusFile 单源)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASEPACK_URL, fetchBasepackManifest } from './manifest.mjs';
import { readConsent, t4Allowed } from './consent.mjs';
import { currentEmbedModelName, knnLayerPaths } from './util/lamps.mjs';
import { readHealthCache } from './util/statusFile.mjs';

export const CLIENT_VERSION = '0.1.0'; // 与 tray/package.json 发行版本对齐(minClientVersion 比对用)
const PART_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // §16.3:新下载前清 data/tmp 下 >7 天 .part

export function createUpdateBase(deps = {}) {
  const {
    paths,
    cmdRun,
    fetchText,
    url = null, // S18-F1(20261118):basepack URL 可注入(默认 BASEPACK_URL),联调/迁移直连 mock 源
    downloader,
    readState = () => ({}),
    writeState = () => {},
    io = fs,
    clientVersion = CLIENT_VERSION,
    onEvent = () => {},
    now = () => Date.now(),
  } = deps;
  let busy = false;
  const emit = (phase, extra = {}) => { try { onEvent({ phase, ...extra }); } catch { /* 回调异常不影响编排 */ } };

  /** 清过期临时件(§16.3):>7 天的 .part 与 basepack-*.json(下载成功但导入失败的遗留包);
   *  目录不存在/不可读静默跳过。 */
  function cleanOldParts(tmpDir) {
    let names = [];
    try { names = io.readdirSync(tmpDir); } catch { return; }
    const tryUnlink = (q) => { try { if (now() - io.statSync(q).mtimeMs > PART_MAX_AGE_MS) io.unlinkSync(q); } catch { /* 尽力 */ } };
    for (const f of names) {
      if (!f.endsWith('.part') && !/^basepack-.*\.json$/.test(f)) continue;
      tryUnlink(path.join(tmpDir, f));
      tryUnlink(path.join(tmpDir, f + '.part')); // 下载中断遗留的 .json.part 同窗清理
    }
  }

  /**
   * 跑一次更新。返回 {outcome, message, ...}:
   * consent-required/busy/no-paths(门禁,零网络) | network/manifest-rejected | no-model/no-pack |
   * already-latest | disk | download-failed | import-busy/rejected-fingerprint/rejected/import-failed | updated
   */
  async function run() {
    if (busy) return { outcome: 'busy', message: '更新进行中,请稍候再试' };
    const dataDir = paths?.dataDir;
    if (!dataDir) return { outcome: 'no-paths', message: '无法定位数据目录(paths.mjs 无响应)' };
    // 同意门禁(§18-D1=c 互惠):false/null 一律拒,不发任何网络请求
    if (!t4Allowed(readConsent(dataDir))) {
      return { outcome: 'consent-required', message: '未同意上传本地向量(互惠约定),公共决策包更新不可用;请重开安装向导在「数据上传」步勾选同意' };
    }
    busy = true;
    try {
      emit('manifest', { message: '拉取清单…' });
      const m = await fetchBasepackManifest(url || BASEPACK_URL, { fetchText, clientVersion }); // S18-F1:url 缝
      if (!m.ok) return { outcome: m.error === 'network' ? 'network' : 'manifest-rejected', error: m.error, message: m.message };
      const health = readHealthCache(dataDir)?.health ?? null; // 缓存形 {at,health},与 poller 同口径
      const model = currentEmbedModelName(health);
      if (!model) return { outcome: 'no-model', message: '读不到当前嵌入模型(健康缓存缺失),请先刷新状态再试' };
      // pack.model 须带 backend 前缀(ollama/… 或 local/…),与导入器指纹 currentEmbedModel() 同口径
      const pack = m.manifest.packs.find((p) => p.model === model);
      if (!pack) return { outcome: 'no-pack', message: `清单无当前嵌入模型 ${model} 的公共决策包` };
      const baseFile = knnLayerPaths(dataDir, health).base;
      if (pack.builtAt && readState().lastAppliedBuiltAt === pack.builtAt && io.existsSync(baseFile)) {
        return { outcome: 'already-latest', message: `已是最新(builtAt ${pack.builtAt},${pack.n ?? '?'} 条)`, builtAt: pack.builtAt, n: pack.n ?? null };
      }
      // 磁盘预检(§16.3):余量须 ≥ 2×包体(.part+终名瞬时共存);statfs 不可用不拦
      if (pack.bytes != null) {
        try {
          const s = io.statfsSync(dataDir);
          if (s.bavail * s.bsize < Number(pack.bytes) * 2) return { outcome: 'disk', message: '磁盘余量不足(需≥2倍包体),请清理后重试' };
        } catch { /* 平台不支持 statfs 时跳过预检 */ }
      }
      const tmpDir = path.join(dataDir, 'tmp');
      try { io.mkdirSync(tmpDir, { recursive: true }); } catch { /* 已存在 */ }
      cleanOldParts(tmpDir);
      const safeBuilt = String(pack.builtAt).replace(/[^A-Za-z0-9._-]/g, '-');
      const dest = `tmp/basepack-${safeBuilt}.json`;
      emit('download', { message: '下载公共决策包…', pct: 0 });
      const dr = await downloader.downloadFileItem(
        { id: 'basepack', urls: [pack.url], dest, sha256: pack.sha256, bytes: pack.bytes ?? null },
        { baseDir: dataDir },
      );
      if (dr.status !== 'ok') return { outcome: 'download-failed', message: `下载失败:${dr.error || dr.status}` };
      const packFile = path.join(dataDir, dest);
      emit('import', { message: '校验指纹并导入 base 层…' });
      const { nodeBin, codeIndexRoot } = paths || {};
      if (!nodeBin || !codeIndexRoot) return { outcome: 'no-paths', message: '无法定位 code-index(paths.mjs 无响应)' };
      const res = await cmdRun('import', nodeBin, [`${codeIndexRoot}/vectorBaseImport.mjs`, '--import', packFile, '--data', dataDir], { cwd: codeIndexRoot, label: '导入公共决策包' });
      if (res.skipped) return { outcome: 'import-busy', message: `有任务在跑(${res.busyFamily || '互斥任务'}),稍后再试` };
      let j = null;
      try { j = JSON.parse(res.stdout); } catch { j = null; }
      if (res.code === 0 && j?.ok === true) {
        writeState({ lastAppliedBuiltAt: pack.builtAt });
        try { io.unlinkSync(packFile); } catch { /* 尽力清理当次临时包 */ }
        emit('done', { message: `更新完成:${j.accepted} 条并入 base 层` });
        return { outcome: 'updated', message: `更新完成:${j.accepted} 条并入 base 层(local 层不变)`, accepted: j.accepted, builtAt: pack.builtAt, mergedEntries: j.mergedEntries ?? null };
      }
      if (j && j.ok === false) {
        const fp = /指纹不符/.test(String(j.error || ''));
        return { outcome: fp ? 'rejected-fingerprint' : 'rejected', message: fp ? '包与当前嵌入模型不符,整包拒收(切换模型后重试)' : `导入拒收:${j.error || '未知'}` };
      }
      return { outcome: 'import-failed', message: `${res.timedOut ? '导入超时被终止\n' : ''}${(res.stderr || res.stdout || `exit ${res.code}`).slice(-300)}` };
    } finally {
      busy = false;
    }
  }

  return { run, isBusy: () => busy };
}