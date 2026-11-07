import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node stats.mjs <csv-path>\n');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8')
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const values = lines.slice(1).map((line) => Number(line));

let sum = 0;
let max = -Infinity;
for (const value of values) {
  sum += value;
  if (value > max) max = value;
}

const mean = values.length === 0 ? NaN : sum / values.length;

process.stdout.write(`${mean.toFixed(2)} ${max.toFixed(2)}\n`);