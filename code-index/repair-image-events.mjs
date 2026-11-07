#!/usr/bin/env node
/**
 * 存量虚账修正(2026-11-07):把 read-guard 事件账本里**图片类 Read 事件**补 void 影子行,
 * computeAccumulation 重放时自动跳过并退回此前已入账金额。
 *
 * 背景:read-guard 曾对图片文件按文本 bytes/4 折算记账(如 3MB jpg 记 78.6 万"节约"),
 * 但图片走宿主视觉通道,真实成本是视觉 token(千级)——口径失真两个数量级,再被逐请求放大。
 * read-guard 入口已修(图片/二进制放行不计账),本脚本一次性清洗存量事件账。
 *
 * 用法:node code-index/repair-image-events.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(here, '..', 'data');
const EVENTS = path.join(DATA_DIR, 'read-guard', 'events.jsonl');
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tiff', 'tif', 'heic', 'heif']);
const isImage = (f) => IMAGE_EXTS.has(path.extname(String(f || '')).slice(1).toLowerCase());

const rows = fs.existsSync(EVENTS)
  ? fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const keyed = new Set(rows.filter((r) => r.void).map((r) => `${r.session}|${r.file}|${r.at}`));
const victims = rows.filter((r) => !r.void && (r.kind === 'Read' || r.kind === 'Bash') && isImage(r.file) && !keyed.has(`${r.session}|${r.file}|${r.at}`));
if (!victims.length) { console.log('无图片类事件需要修正'); process.exit(0); }
const tokensOf = (r) => Math.ceil((Number(r.bytes) || 0) / 4);
const inflated = victims.reduce((s, r) => s + tokensOf(r), 0);
console.log(`发现图片类事件 ${victims.length} 条,虚计 tokens 合计 ${inflated.toLocaleString()}:`);
for (const r of victims) console.log(`  [${r.kind}] ${r.file} bytes=${r.bytes} (~${tokensOf(r).toLocaleString()} tok) ${String(r.session).slice(0, 24)}`);
if (process.argv.includes('--dry')) { console.log('--dry:未写入'); process.exit(0); }
const shadow = victims.map((r) => JSON.stringify({ at: r.at, session: r.session, kind: r.kind, file: r.file, bytes: r.bytes, void: true, repairedAt: Date.now(), reason: 'image-visual-token-rebase(图片按视觉 token 口径,不进文本节约账)' }));
fs.appendFileSync(EVENTS, shadow.join('\n') + '\n');
console.log(`已追加 ${shadow.length} 条 void 影子行 ⇒ 下次重放(computeAccumulation)自动跳过并退回已入账金额`);
