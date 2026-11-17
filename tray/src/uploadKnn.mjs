/**
 * T6 上传闭环编排(tray 方案 §5.6/§16.5/§19.3/§19.6 v1.2,M5 2026-11-17):
 * 同意门禁 → 钉扎自检(pinFacts 微 CLI + pinlock) → 只取已签条目(rule 前缀 ensemble:=四票合议代签;
 * 行为形态/词法弱标签不上传,置信闸前移 §19.5-2) → 游标过滤(accepted/rejected 均不重传) →
 * 分片(≤2000 条且明文≤8MB) → gzip+AES-256-GCM+RSA-OAEP(sha256) 信封 → 逐片 POST → 回执游标推进。
 * 加密口径与 TSServer src/lib/receive.mjs sealEnvelope 逐字段同口径(iv12/tag16/oaepHash sha256)。
 * 零 electron、零 code-index import(§18-E1):事实走 spawn 微 CLI,路径经 util/lamps 镜像单源。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readConsent, t4Allowed } from './consent.mjs';
import { UPLOAD_PINS, checkPins } from './pinlock.mjs';
import { currentEmbedModelName, knnLayerPaths } from './util/lamps.mjs';
import { readHealthCache } from './util/statusFile.mjs';
import { httpRequest } from './downloader.mjs';

export const UPLOAD_URL = 'https://crisvado.com/tokensaver/api/v1/knn/upload';
export const CLIENT_BUILD_ID = '0.1.0';
export const MAX_ENTRIES_PER_PART = 2000;
export const MAX_PLAIN_BYTES = 8 * 1024 * 1024;
const KEY_RE = /^[0-9a-f]{24}$/;
const LABEL_RE = /^(multi|routine|light)$/i;
const SIGNED_RULE_PREFIX = 'ensemble:'; // 已签=四票合议代签产物;其余弱标签不上传

/** 信封封装(与服务器 sealEnvelope 同口径;header 的 entryCount/contentSha256/contentEncoding 由本函数覆盖)。 */
export function sealEnvelope({ header, entries, publicKeyB64 }) {
  const plain = Buffer.from(JSON.stringify({ entries }), 'utf8');
  const gz = zlib.gzipSync(plain);
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const enc = Buffer.concat([cipher.update(gz), cipher.final()]);
  const wrapped = crypto.publicEncrypt({
    key: crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' }),
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, aesKey);
  return {
    envelope: 1,
    header: { ...header, crypto: 'RSA-OAEP+AES-256-GCM', contentEncoding: 'gzip', entryCount: entries.length, contentSha256: crypto.createHash('sha256').update(plain).digest('hex') },
    wrappedKey: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    payload: enc.toString('base64'),
  };
}

/** 已签条目过滤+游标排除(纯):local 层 vectors → 待上传 entries(24hex 键/v_b64/label/rule,无 promptKey/domain)。 */
export function selectUploadEntries(vectors, cursor = {}) {
  const done = new Set([...(cursor.accepted || []), ...(cursor.rejected || [])]);
  const out = [];
  for (const [key, e] of Object.entries(vectors || {})) {
    if (!KEY_RE.test(key) || done.has(key)) continue;
    if (!e || typeof e.v_b64 !== 'string' || !e.v_b64) continue;
    if (!LABEL_RE.test(String(e.label || ''))) continue;
    if (!String(e.rule || '').startsWith(SIGNED_RULE_PREFIX)) continue;
    out.push({ key, v_b64: e.v_b64, label: String(e.label).toLowerCase(), rule: String(e.rule || '') });
  }
  return out;
}

/** 分片(纯):≤2000 条且 gzip 前明文≤8MB(贪心累加 JSON 字节)。 */
export function chunkEntries(entries, { maxEntries = MAX_ENTRIES_PER_PART, maxPlainBytes = MAX_PLAIN_BYTES } = {}) {
  const chunks = [];
  let cur = [];
  let bytes = 16; // {"entries":[]} 骨架
  for (const e of entries) {
    const add = Buffer.byteLength(JSON.stringify(e)) + 1;
    if (cur.length && (cur.length >= maxEntries || bytes + add > maxPlainBytes)) { chunks.push(cur); cur = []; bytes = 16; }
    cur.push(e);
    bytes += add;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function createUploadKnn(deps = {}) {
  const {
    paths,
    cmdRun,
    postJson, // (url, body) => Promise<receipt>;默认 httpRequest POST
    readState = () => ({}),
    writeState = () => {},
    io = fs,
    pins = UPLOAD_PINS,
    url = UPLOAD_URL,
    clientBuildId = CLIENT_BUILD_ID,
    onEvent = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => new Date().toISOString(),
  } = deps;
  let busy = false;
  const emit = (phase, extra = {}) => { try { onEvent({ phase, ...extra }); } catch { /* 回调异常不影响编排 */ } };
  const post = postJson || (async (u, body) => {
    const data = Buffer.from(JSON.stringify(body));
    const { status, res } = await httpRequest(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(data.length) }, body: data, timeoutMs: 60_000 });
    let txt = '';
    res.setEncoding('utf8');
    for await (const c of res) txt += c;
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return JSON.parse(txt);
  });

  async function run() {
    if (busy) return { outcome: 'busy', message: '上传进行中,请稍候再试' };
    const dataDir = paths?.dataDir;
    if (!dataDir) return { outcome: 'no-paths', message: '无法定位数据目录(paths.mjs 无响应)' };
    if (!t4Allowed(readConsent(dataDir))) return { outcome: 'consent-required', message: '未同意上传本地向量,上传不可用;可在面板勾选同意' };
    busy = true;
    try {
      emit('facts', { message: '钉扎自检…' });
      const { nodeBin, codeIndexRoot } = paths || {};
      if (!nodeBin || !codeIndexRoot) return { outcome: 'no-paths', message: '无法定位 code-index(paths.mjs 无响应)' };
      const fr = await cmdRun('status', nodeBin, [`${codeIndexRoot}/pinFacts.mjs`], { cwd: codeIndexRoot, label: '钉扎事实' });
      let facts = null;
      try { facts = JSON.parse(fr.stdout); } catch { facts = null; }
      if (fr.code !== 0 || !facts) return { outcome: 'facts-unavailable', message: `钉扎事实读取失败:${(fr.stderr || fr.stdout || `exit ${fr.code}`).slice(-200)}` };
      const pin = checkPins(facts, pins);
      if (!pin.ok) return { outcome: 'pinned-mismatch', message: `本机配置与发行钉扎不一致,已阻止上传(${pin.mismatches.map((m) => m.field).join(',')})`, mismatches: pin.mismatches };
      const health = readHealthCache(dataDir)?.health ?? null;
      const model = currentEmbedModelName(health);
      if (!model || model !== facts.embedModelSlug) return { outcome: 'no-local-layer', message: '健康缓存与钉扎指纹不一致,请先刷新状态' };
      const localFile = knnLayerPaths(dataDir, health).local;
      let doc = null;
      try { doc = JSON.parse(io.readFileSync(localFile, 'utf8')); } catch { doc = null; }
      if (!doc?.vectors) return { outcome: 'no-local-layer', message: '本地决策包不存在,请先完成索引与决策向量同步' };
      const state = readState();
      const cursor = state.uploadCursor || { accepted: [], rejected: [] };
      const entries = selectUploadEntries(doc.vectors, cursor);
      if (!entries.length) return { outcome: 'nothing-new', message: '无新增已签条目可上传(已签/已拒收键均不重传)' };
      const chunks = chunkEntries(entries);
      const uploadId = state.uploadId || crypto.randomUUID();
      writeState({ uploadId });
      let accepted = 0, rejected = 0, duplicate = 0;
      const newAccepted = [], newRejected = [];
      for (let i = 0; i < chunks.length; i++) {
        emit('upload', { message: `上传分片 ${i + 1}/${chunks.length}…`, part: i + 1, partTotal: chunks.length, pct: Math.floor((i / chunks.length) * 100) });
        const env = sealEnvelope({
          header: {
            kid: pins.kid, clientBuildId, embedModelSlug: facts.embedModelSlug, embedDim: facts.embedDim,
            decisionModelVersion: facts.decisionModelVersion, decisionParamsSha256: facts.decisionParamsSha256,
            knnSchemaVersion: 1, producedAt: now(), uploadId, partIndex: i, partTotal: chunks.length,
          },
          entries: chunks[i],
          publicKeyB64: pins.publicKey,
        });
        let receipt = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try { receipt = await post(url, env); } catch (e) { return { outcome: 'upload-failed', message: `上传网络失败:${String(e?.message || e).slice(-160)}`, part: i + 1 }; }
          if (receipt?.code === 9 && attempt < 3) { await sleep(Math.min(30, Number(receipt.retryAfterSec) || 2) * 1000); continue; }
          break;
        }
        const code = Number(receipt?.code);
        if (code !== 0) {
          const map = { 1: 'rejected', 2: 'version-mismatch', 3: 'rejected', 4: 'rejected', 5: 'quota', 6: 'server-error', 9: 'retryable-exhausted' };
          return { outcome: map[code] || 'rejected', message: `服务端拒收(code=${code}):${receipt?.message || ''}`, part: i + 1, code };
        }
        accepted += Number(receipt.accepted) || 0;
        rejected += Number(receipt.rejected) || 0;
        duplicate += Number(receipt.duplicate) || 0;
        for (const k of receipt.acceptedPkeys || []) if (!newAccepted.includes(k)) newAccepted.push(k);
        for (const k of receipt.rejectedPkeys || []) if (!newRejected.includes(k)) newRejected.push(k);
        // 逐片落游标(崩溃安全增量):accepted/rejected 均不重传(v1.2)
        writeState({ uploadCursor: { accepted: [...(cursor.accepted || []), ...newAccepted], rejected: [...(cursor.rejected || []), ...newRejected] } });
      }
      emit('done', { message: `上传完成:${accepted} 条接收` });
      return { outcome: 'updated', message: `上传完成:${accepted} 条接收,${duplicate} 条重复,${rejected} 条拒收(${chunks.length} 片)`, accepted, rejected, duplicate, parts: chunks.length };
    } finally {
      busy = false;
    }
  }

  return { run, isBusy: () => busy };
}