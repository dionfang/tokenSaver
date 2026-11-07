import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node stats.mjs <csv-path>');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/).slice(1);
const values = lines.map((line) => line.trim()).filter((line) => line.length > 0).map(Number);

if (values.length === 0) {
  console.error('no data rows');
  process.exit(1);
}

const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
const max = Math.max(...values);

console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);