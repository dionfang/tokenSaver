#!/usr/bin/env node
/**
 * 托盘图标派生器(20261123 用户裁定「托盘图标与桌面图标使用同一个」):
 * build/icon.png(桌面/exe/安装器图标唯一真源)→ 面积均值缩小到 32×32 RGBA → assets/tray.png。
 * 单源铁律:此前托盘(绿点)与桌面(蓝底白 T)是两套生成器两种设计,换素材只改一处必漂移——
 * 现托盘图标构建时自动从图标真源派生,dist-online/dist-offline 两包装器均在 electron-builder
 * 前调用本脚本(失败即中止构建),今后换品牌素材只替换 build/icon.png 重跑 gen-icon 即全局同步。
 * 解码支持:8bit 非隔行,colortype 0/2/4/6,行过滤器 0-4(用户后续真素材不受占位稿 filter0 限制)。
 * 零依赖(zlib inflate/deflate+手工 PNG 封装,托盘红线零 npm)。运行:node build/tray-from-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const TRAY_SIZE = 32;

/** PNG 解码(单源 build/icon.png 契约:8bit/非隔行/colortype 0/2/4/6/filter 0-4)→ {w,h,rgba}。 */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('非 PNG(签名不符)');
  let off = 8;
  let ihdr = null;
  const idats = [];
  let plte = null;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE') plte = data;
    else if (type === 'IDAT') idats.push(data);
    if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG 缺 IHDR');
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`不支持的 PNG(bitDepth=${bitDepth} interlace=${interlace};仅 8bit 非隔行)`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的色彩类型 ${colorType}(索引色请先转 RGBA)`);
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = w * channels;
  if (raw.length < h * (stride + 1)) throw new Error(`PNG 数据不足(${raw.length} < ${h * (stride + 1)})`);
  const rgba = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    raw.copy(line, 0, p, p + stride);
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (colorType === 6) { rgba[o] = line[x * 4]; rgba[o + 1] = line[x * 4 + 1]; rgba[o + 2] = line[x * 4 + 2]; rgba[o + 3] = line[x * 4 + 3]; }
      else if (colorType === 2) { rgba[o] = line[x * 3]; rgba[o + 1] = line[x * 3 + 1]; rgba[o + 2] = line[x * 3 + 2]; rgba[o + 3] = 255; }
      else if (colorType === 0) { rgba[o] = rgba[o + 1] = rgba[o + 2] = line[x]; rgba[o + 3] = 255; }
      else { rgba[o] = rgba[o + 1] = rgba[o + 2] = line[x * 2]; rgba[o + 3] = line[x * 2 + 1]; }
    }
    line.copy(prev);
  }
  void plte;
  return { w, h, rgba };
}

/** 面积均值缩放(重叠权重抗锯齿;256→32 恰为 8×8 块,任意尺寸亦正确)。 */
export function downscaleRgba(src, sw, sh, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let ty = 0; ty < size; ty++) {
    const y0 = (ty * sh) / size;
    const y1 = ((ty + 1) * sh) / size;
    for (let tx = 0; tx < size; tx++) {
      const x0 = (tx * sw) / size;
      const x1 = ((tx + 1) * sw) / size;
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y1, y + 1) - Math.max(y0, y);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x1, x + 1) - Math.max(x0, x);
          if (wx <= 0 || wy <= 0) continue;
          const wgt = wx * wy;
          const i = (y * sw + x) * 4;
          r += src[i] * wgt; g += src[i + 1] * wgt; b += src[i + 2] * wgt; a += src[i + 3] * wgt;
          area += wgt;
        }
      }
      const o = (ty * size + tx) * 4;
      out[o] = Math.round(r / area);
      out[o + 1] = Math.round(g / area);
      out[o + 2] = Math.round(b / area);
      out[o + 3] = Math.round(a / area);
    }
  }
  return out;
}

/** RGBA→PNG(8bit RGBA,行过滤器 0;与 gen-icon 同款零依赖封装,输出字节确定)。 */
export function encodePngRgba(rgba, w, h) {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b2) => {
    let c = 0xffffffff;
    for (const byte of b2) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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
  const stride = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    stride[y * (w * 4 + 1)] = 0;
    rgba.copy(stride, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(stride)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 主派生:icon.png 字节 → tray.png 字节(纯函数,测试逐字节互验)。 */
export function trayPngFromIcon(iconPngBuf, { size = TRAY_SIZE } = {}) {
  const { w, h, rgba } = decodePng(iconPngBuf);
  const small = downscaleRgba(rgba, w, h, size);
  return encodePngRgba(small, size, size);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tray = path.resolve(here, '..');
  const icon = fs.readFileSync(path.join(tray, 'build', 'icon.png'));
  const png = trayPngFromIcon(icon);
  const out = path.join(tray, 'assets', 'tray.png');
  fs.writeFileSync(out, png);
  const re = decodePng(fs.readFileSync(out));
  if (re.w !== TRAY_SIZE || re.h !== TRAY_SIZE) { console.error(`[err] 自检失败:重读 ${re.w}×${re.h} ≠ ${TRAY_SIZE}×${TRAY_SIZE}`); process.exit(1); }
  console.log(`[ok] assets/tray.png 已从 build/icon.png 派生(${png.length} 字节,${TRAY_SIZE}×${TRAY_SIZE} RGBA)`);
}
