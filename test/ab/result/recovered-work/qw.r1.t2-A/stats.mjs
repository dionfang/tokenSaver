import { readFileSync } from 'node:fs';

const path = process.argv[2];
const lines = readFileSync(path, 'utf8').split(/\r?\n/);
const nums = lines.slice(1)
  .map((s) => s.trim())
  .filter((s) => s !== '')
  .map(Number);

const sum = nums.reduce((a, b) => a + b, 0);
const mean = sum / nums.length;
const max = Math.max(...nums);

console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);
