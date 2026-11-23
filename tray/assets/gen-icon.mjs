#!/usr/bin/env node
/**
 * 【已退役 20261123】占位托盘图标生成器——tray.png 改由 build/tray-from-icon.mjs 从
 * build/icon.png 派生(用户裁定「托盘图标与桌面图标使用同一个」,单源防漂移;dist 双包装器
 * 构建前自动调用)。本脚本保留仅作历史参考,**勿再运行**(运行会以绿点占位稿覆盖派生产物)。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 32;
const here = path.dirname(fileURLToPath(import.meta.url));

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// 像素绘制:圆角底 #238636(绿),中央亮点 #3fb950,右上小点 #d29922(表示常监视)
const px = (x, y, [r, g, b, a]) => { const i = (y * SIZE + x) * 4; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a; };
const raw = Buffer.alloc(SIZE * SIZE * 4, 0);
const R = 7; // 圆角半径
const inRound = (x, y) => {
  const dx = Math.max(R - x, x - (SIZE - 1 - R), 0);
  const dy = Math.max(R - y, y - (SIZE - 1 - R), 0);
  return dx * dx + dy * dy <= R * R;
};
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!inRound(x, y)) continue;
    const d = Math.hypot(x - 16, y - 17);
    if (d < 6) px(x, y, [63, 185, 80, 255]);
    else if (Math.hypot(x - 24, y - 8) < 3) px(x, y, [210, 153, 34, 255]);
    else px(x, y, [35, 134, 54, 255]);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const stride = Buffer.alloc(SIZE * (SIZE * 4 + 1)); // 每行前缀 filter=0
for (let y = 0; y < SIZE; y++) raw.copy(stride, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(stride)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(here, 'tray.png');
fs.writeFileSync(out, png);
console.log(`[ok] 托盘占位图标已生成:${out}(${png.length} 字节)`);
