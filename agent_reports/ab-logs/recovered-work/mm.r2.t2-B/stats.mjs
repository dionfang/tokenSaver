#!/usr/bin/env node
// 用法: node stats.mjs <csv路径>
// CSV 第一行为表头,第二行起每行一个整数(单列)。输出一行 "mean max"。
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node stats.mjs <csv路径>');
  process.exit(1);
}

const lines = readFileSync(path, 'utf8').split(/\r?\n/);
const nums = [];
for (let i = 1; i < lines.length; i++) {
  const s = lines[i].trim();
  if (s === '') continue;
  nums.push(Number(s));
}

if (nums.length === 0) {
  console.log('0.00 0.00');
  process.exit(0);
}

let sum = 0;
let max = nums[0];
for (const n of nums) {
  sum += n;
  if (n > max) max = n;
}
const mean = sum / nums.length;

console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);
