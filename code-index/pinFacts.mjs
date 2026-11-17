#!/usr/bin/env node
/**
 * 钉扎事实微 CLI(tray 方案 §16.5/§19.6,M5 2026-11-17):stdout JSON,托盘 spawn 消费。
 * decisionParamsSha256 = 稳定哈希(深排序键 JSON)of {default: 代码档案表, server: 服务器档案层};
 * 服务器层=readServerProfiles(独立文件/base 内嵌,后读覆盖)。base 包未带 profiles 时 server={}。
 * 嵌入指纹/维数/决策版本与 vectorLayers/decisionModel 真源同口径(托盘禁 import,故走微 CLI)。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { DECISION_PROFILES_DEFAULT, readServerProfiles, resolveDecisionProfile } from './decisionModel.mjs';
import { currentEmbedModel, vectorsLayerPaths } from './vectorLayers.mjs';

/** 深排序键规范化(稳定哈希前置;数组保序)。 */
export function canonicalJson(v) {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalJson(v[k]);
    return o;
  }
  return v;
}

/** 档案表稳定哈希(内置默认表 + 服务器档案层)。 */
export function profilesHash(dataDir = DATA_DIR) {
  const server = readServerProfiles(dataDir);
  const payload = JSON.stringify(canonicalJson({ default: DECISION_PROFILES_DEFAULT, server }));
  return { sha256: crypto.createHash('sha256').update(payload).digest('hex'), profilesSource: Object.keys(server).length ? 'default+server' : 'default' };
}

/** 运行态钉扎事实(纯读,无副作用)。 */
export function pinFacts(dataDir = DATA_DIR) {
  const { sha256, profilesSource } = profilesHash(dataDir);
  const fp = currentEmbedModel();
  const p = vectorsLayerPaths(dataDir, fp);
  let dim = 0;
  for (const f of [p.local.slugFile, p.base.slugFile]) {
    try { dim = Number(JSON.parse(fs.readFileSync(f, 'utf8')).dim) || 0; if (dim) break; } catch { /* 无层 */ }
  }
  const prof = resolveDecisionProfile(null, { dataDir });
  const version = prof.backend ? prof.backend.split(':').slice(1).join(':') : null;
  return { decisionParamsSha256: sha256, embedModelSlug: fp, embedDim: dim, decisionModelVersion: version, knnSchemaVersion: 1, profilesSource };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) console.log(JSON.stringify(pinFacts(process.env.CODE_INDEX_DATA_DIR || DATA_DIR)));