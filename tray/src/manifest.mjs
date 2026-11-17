/**
 * 组件清单客户端(tray 方案 §16.6/§18-C1/C5/§19.1 API-1b,2026-11-15 M2):
 * components.json 拉取 + Ed25519 验签(公钥内置 pins)+ minClientVersion 解析即比对。
 * 签名口径:对「删去 signature 键后 JSON.stringify」的字节签名(键序=文件序,生成端与验签端同管线)。
 * 本 pins 为 dev-pins(§19.4-②):开发期密钥对构建期注入,非生产;生产公钥随发布链轮换(kid 双钥并存窗口)。
 * 零 npm 依赖(node:crypto Ed25519 原生);不 import code-index/**(§18-E1)。
 */
import crypto from 'node:crypto';

export const MANIFEST_URL = 'https://crisvado.com/tokensaver/manifest/components.json';

/** 验签公钥钉扎(dev-pins:kid=dev-2026Q4,私钥仅存 test/tray/fixtures/dev-signing-key.json)。 */
export const PINS = {
  dev: true,
  publicKeys: { 'dev-2026Q4': 'MCowBQYDK2VwAyEAVFkBka0w2B/x59MMxk4QncqWHBK+CGPvYKe4IC3VYYM=' },
};

/** 签名载荷(纯函数):删去 signature 键后的确定性 JSON 字节。 */
export function canonicalSigningPayload(manifest) {
  const { signature, ...rest } = manifest ?? {};
  return JSON.stringify(rest);
}

function publicKeyFromB64(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

/** 验签(纯):pins 按 kid 索引,任一通过即可(双钥并存窗口 §18-D2);无 kid 时逐钥尝试。 */
export function verifyManifestSignature(manifest, pins = PINS) {
  const sig = manifest?.signature;
  if (!sig || sig.alg !== 'Ed25519' || typeof sig.sig !== 'string') return false;
  const kids = sig.kid ? [sig.kid] : Object.keys(pins.publicKeys);
  const data = Buffer.from(canonicalSigningPayload(manifest));
  const sigBuf = Buffer.from(sig.sig, 'base64');
  if (sigBuf.length !== 64) return false;
  return kids.some((kid) => {
    const b64 = pins.publicKeys[kid];
    if (!b64) return false;
    try { return crypto.verify(null, data, publicKeyFromB64(b64), sigBuf); } catch { return false; }
  });
}

/** 版本比较(纯,semver 宽松版):缺段补 0,数字段逐位比。返回 -1|0|1。 */
export function compareVersions(a, b) {
  const num = (v) => String(v ?? '').split('.').map((x) => parseInt(x, 10) || 0);
  const A = num(a);
  const B = num(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** minClientVersion 比对(纯,C5):客户端低于要求 → {ok:false,required,current}。 */
export function checkMinClientVersion(manifest, clientVersion) {
  const required = manifest?.minClientVersion;
  if (!required) return { ok: true, required: null, current: clientVersion };
  const ok = compareVersions(clientVersion, required) >= 0;
  return { ok, required, current: clientVersion };
}

/**
 * 解析+验签+版本比对(解析即比对,C5 拍板)。
 * @returns {ok:true, manifest} | {ok:false, error:'bad-json'|'bad-signature'|'client-too-old', message, required?, current?}
 */
export function parseManifest(text, { clientVersion, pins = PINS } = {}) {
  let manifest = null;
  try { manifest = JSON.parse(text); } catch { return { ok: false, error: 'bad-json', message: '清单不是合法 JSON' }; }
  if (!verifyManifestSignature(manifest, pins)) return { ok: false, error: 'bad-signature', message: '清单签名校验失败(可能被篡改)' };
  const v = checkMinClientVersion(manifest, clientVersion);
  if (!v.ok) return { ok: false, error: 'client-too-old', message: `客户端版本过低(v${v.current}),需 v${v.required} 以上,请先升级客户端`, required: v.required, current: v.current };
  if (manifest.manifestVersion !== 1) return { ok: false, error: 'bad-version', message: `不支持的清单版本:${manifest.manifestVersion}` };
  if (!Array.isArray(manifest.items)) return { ok: false, error: 'bad-schema', message: '清单缺少 items 数组' };
  return { ok: true, manifest };
}

/**
 * 拉取清单(§19.1 API-1b)。fetchText 依赖注入(生产=真实 HTTP,单测=读 fixture/本地假源)。
 */
export async function fetchComponentsManifest(url = MANIFEST_URL, { fetchText, clientVersion, pins = PINS, timeoutMs = 15_000 } = {}) {
  let text;
  try { text = await fetchText(url, { timeoutMs }); } catch (e) { return { ok: false, error: 'network', message: `清单拉取失败:${e?.message || e}` }; }
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'network', message: '清单响应为空' };
  return parseManifest(text, { clientVersion, pins });
}

// ---------- basepack 清单(T4 专用,§16.6/§19.1 API-1/§19.2,2026-11-17 M4) ----------

export const BASEPACK_URL = 'https://crisvado.com/tokensaver/manifest/basepack.json';

/** pack 项基础校验(纯):url/sha256 必备(下载器硬校验门),model/dim/builtAt 供选包与已最新判定。 */
export function validatePack(p) {
  if (!p || typeof p.model !== 'string' || !p.model) return '缺 model';
  if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) return 'url 须为 http(s)';
  if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(p.sha256)) return 'sha256 缺失或格式错';
  if (typeof p.builtAt !== 'string' || !p.builtAt) return '缺 builtAt';
  if (p.dim != null && (!Number.isFinite(Number(p.dim)) || Number(p.dim) <= 0)) return 'dim 非法';
  return null;
}

/**
 * 解析+验签+版本比对 basepack 清单(与 parseManifest 同口径,packs 替代 items)。
 * @returns {ok:true, manifest} | {ok:false, error, message}
 */
export function parseBasepackManifest(text, { clientVersion, pins = PINS } = {}) {
  let manifest = null;
  try { manifest = JSON.parse(text); } catch { return { ok: false, error: 'bad-json', message: '清单不是合法 JSON' }; }
  if (!verifyManifestSignature(manifest, pins)) return { ok: false, error: 'bad-signature', message: '清单签名校验失败(可能被篡改)' };
  const v = checkMinClientVersion(manifest, clientVersion);
  if (!v.ok) return { ok: false, error: 'client-too-old', message: `客户端版本过低(v${v.current}),需 v${v.required} 以上,请先升级客户端`, required: v.required, current: v.current };
  if (manifest.manifestVersion !== 1) return { ok: false, error: 'bad-version', message: `不支持的清单版本:${manifest.manifestVersion}` };
  if (!Array.isArray(manifest.packs)) return { ok: false, error: 'bad-schema', message: '清单缺少 packs 数组' };
  const invalid = [];
  for (const p of manifest.packs) { const err = validatePack(p); if (err) invalid.push(`${p?.model ?? '?'}:${err}`); }
  if (invalid.length) return { ok: false, error: 'bad-schema', message: `pack 项非法:${invalid.join(';')}` };
  return { ok: true, manifest };
}

/** 拉取 basepack 清单(§19.1 API-1)。fetchText 依赖注入(生产=真实 HTTP,单测=fixture/本地假源)。 */
export async function fetchBasepackManifest(url = BASEPACK_URL, { fetchText, clientVersion, pins = PINS, timeoutMs = 15_000 } = {}) {
  let text;
  try { text = await fetchText(url, { timeoutMs }); } catch (e) { return { ok: false, error: 'network', message: `清单拉取失败:${e?.message || e}` }; }
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'network', message: '清单响应为空' };
  return parseBasepackManifest(text, { clientVersion, pins });
}

/** 清单项类型(§16.6,§18-C6=b 后 tray 段已废):http/deps 走文件下载,ollama-pull 走 /api/pull。 */
export const ITEM_TYPES = new Set(['http', 'deps', 'ollama-pull']);

/** 项基础校验(纯):下载器执行前兜底,坏项拒绝而非半路崩。 */
export function validateItem(it) {
  if (!it?.id || typeof it.id !== 'string') return `缺 id`;
  if (!ITEM_TYPES.has(it.type)) return `未知类型 ${it.type}`;
  if (!['common', 'cpu', 'gpu'].includes(it.mode)) return `未知 mode ${it.mode}`;
  if (it.type === 'ollama-pull') return typeof it.model === 'string' && it.model ? null : 'ollama-pull 缺 model';
  if (!Array.isArray(it.urls) || it.urls.length === 0 || it.urls.some((u) => typeof u !== 'string' || !/^https?:\/\//.test(u))) return 'urls 须为非空 http(s) 数组';
  if (typeof it.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(it.sha256)) return 'sha256 缺失或格式错';
  if (typeof it.dest !== 'string' || !it.dest) return '缺 dest';
  return null;
}

/**
 * 按运行模式选清单项(纯,C2:先选模式再拉对应清单;common 项置顶先行)。
 * 带 os/arch 的项仅在匹配当前平台时入选;顺序=common 先、cpu/gpu 后,各自保序。
 */
export function selectItems(manifest, { mode, os = process.platform, arch = process.arch } = {}) {
  if (!mode || !['cpu', 'gpu'].includes(mode)) return { ok: false, error: 'mode-missing', items: [] };
  const fits = (it) => (it.os && it.os !== os ? false : !(it.arch && it.arch !== arch));
  const wanted = [manifest.common, manifest.items].flat().filter(Boolean) // 兼容未来 common 段
    .filter((it) => (it.mode === 'common' || it.mode === mode) && fits(it));
  const commons = wanted.filter((it) => it.mode === 'common');
  const modals = wanted.filter((it) => it.mode !== 'common');
  const invalid = [];
  for (const it of [...commons, ...modals]) { const err = validateItem(it); if (err) invalid.push(`${it.id}:${err}`); }
  if (invalid.length) return { ok: false, error: 'invalid-items', invalid, items: [] };
  return { ok: true, items: [...commons, ...modals] };
}

// ---------- dev keypair 生成器(构建期工具,§19.4-②;产物标 dev-pins,私钥绝不进发行物) ----------

export function generateDevKeypair(kid = 'dev-2026Q4') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    kid,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** 用给定私钥(base64 pkcs8)对清单签名,返回带 signature 的完整清单(fixture/构建期用)。 */
export function signManifest(manifest, privateKeyB64, kid) {
  const payload = canonicalSigningPayload(manifest);
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign(null, Buffer.from(payload), key);
  return { ...JSON.parse(payload), signature: { alg: 'Ed25519', ...(kid ? { kid } : {}), sig: sig.toString('base64') } };
}
