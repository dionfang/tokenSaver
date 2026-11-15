/**
 * 上传同意状态(tray 方案 §5.5/§16.7/§18-D1=c/D5,2026-11-15 M2):tray-consent.json 读写与撤回。
 * D1 互惠:consent true=上传授权+解锁 base 下载(T4);false=不上传+T4 禁用、决策 KNN 仅 local 层。
 * D5 撤回=取消进行中上传+T4 同步禁用(本批只做状态读写与门禁接口,上传任务属 M5)。
 * 读侧复用 util/statusFile.readConsentFile(单一真源);不 import code-index/**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readConsentFile } from './util/statusFile.mjs';

export const CONSENT_FILE = 'tray-consent.json';

export function readConsent(dataDir) { return readConsentFile(dataDir); }

/** 写同意(true=记录 consentedAt;false=撤回,保留 revokedAt 供设置面板展示历史)。 */
export function writeConsent(dataDir, uploadLocalKnn, { io = fs, now = () => new Date().toISOString() } = {}) {
  const prev = readConsentFile(dataDir);
  const next = uploadLocalKnn
    ? { uploadLocalKnn: true, consentedAt: now(), ...(prev?.uploadLocalKnn === true ? { revokedAt: prev.revokedAt ?? null } : {}) }
    : { ...prev, uploadLocalKnn: false, revokedAt: now() };
  io.writeFileSync(path.join(dataDir, CONSENT_FILE), JSON.stringify(next, null, 1));
  return next;
}

/** 撤回(D5):uploadLocalKnn=false+revokedAt;进行中上传的取消属 M5,此处只落状态。 */
export function revokeConsent(dataDir, opts) { return writeConsent(dataDir, false, opts); }

/** T4(base 包下载/更新)门禁接口:唯一判据=consent 文件 uploadLocalKnn===true(§16.7)。 */
export function t4Allowed(consent) { return consent?.uploadLocalKnn === true; }
