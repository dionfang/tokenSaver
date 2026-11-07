#!/usr/bin/env node
// 用法: node stats.mjs <csv路径>
// CSV: 第一行表头, 第二行起每行一个整数(单列)。输出 "mean max", 两位小数, 单空格分隔。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('用法: node stats.mjs <csv路径>');
  process.exit(1);
}

const raw = readFileSync(resolve(csvPath), 'utf8');

const lines = raw
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/);

// 跳过表头(第一行)与空行
const values = [];
for (let i = 1; i < lines.length; i++) {
  const cell = lines[i].trim();
  if (cell === '') continue;
  const n = Number(cell);
  if (Number.isFinite(n)) values.push(n);
}

if (values.length === 0) {
  console.log('0.00 0.00');
} else {
  let sum = 0;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v > max) max = v;
  }
  const mean = sum / values.length;
  console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);
}
