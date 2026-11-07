import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node stats.mjs <csv路径>');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(1);
const nums = lines
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => Number.parseInt(line.split(',')[0].trim(), 10))
  .filter((n) => Number.isFinite(n));

const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
const max = Math.max(...nums);
console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);