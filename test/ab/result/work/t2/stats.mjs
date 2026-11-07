import { readFileSync } from 'node:fs';

const path = process.argv[2];
const lines = readFileSync(path, 'utf8').split(/\r?\n/).slice(1);
const nums = [];
for (const line of lines) {
  const s = line.trim();
  if (!s) continue;
  nums.push(parseInt(s, 10));
}
const n = nums.length;
const mean = nums.reduce((a, b) => a + b, 0) / n;
const max = Math.max(...nums);
console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);
