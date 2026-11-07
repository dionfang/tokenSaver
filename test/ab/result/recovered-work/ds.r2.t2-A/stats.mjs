import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node stats.mjs <csv路径>');
  process.exit(1);
}

const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

let sum = 0;
let max = -Infinity;
let count = 0;
for (const line of lines.slice(1)) {
  const value = Number(line);
  if (!Number.isFinite(value)) continue;
  sum += value;
  if (value > max) max = value;
  count += 1;
}

const mean = count === 0 ? 0 : sum / count;
const maxValue = count === 0 ? 0 : max;
console.log(`${mean.toFixed(2)} ${maxValue.toFixed(2)}`);