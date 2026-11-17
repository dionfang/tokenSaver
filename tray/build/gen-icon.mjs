#!/usr/bin/env node
/** 发行图标生成(2026-11-17 发行链):256×256 品牌占位 PNG + ICO(ICO 内嵌 PNG,Vista+ 支持)。
 *  A5 口径:占位稿先行,安装包构建前用户素材替换 build/icon.png 后重跑本脚本即可。
 *  零依赖:zlib  deflate + 手工 PNG/ICO 封装。运行:node build/gen-icon.mjs */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const N = 256;
// 品牌占位:深蓝底 + 白色「T」字块(极简几何,后续用户素材替换)
const px = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const i = (y * N + x) * 4;
  const inT = (y >= 64 && y <= 96 && x >= 64 && x <= 192) || (x >= 112 && x <= 144 && y >= 64 && y <= 192);
  const [r, g, b] = inT ? [255, 255, 255] : [47, 111, 223];
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
}
// PNG 封装(scanline filter 0)
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(here, 'icon.png'), png);
// ICO:单 entry 内嵌 PNG(width/height 字节 0=256)
const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; ico[8] = 0; ico[9] = 0;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(here, 'icon.ico'), Buffer.concat([ico, png]));
console.log(`[ok] build/icon.png(${png.length}B) + build/icon.ico 已生成(256×256 占位稿)`);
