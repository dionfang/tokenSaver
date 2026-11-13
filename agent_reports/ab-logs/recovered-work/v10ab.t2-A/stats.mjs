import { readFileSync } from 'node:fs';

const file = process.argv[2];
const lines = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() !== '');
const nums = lines.slice(1).map((l) => parseInt(l.trim(), 10));
const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
const max = Math.max(...nums);
console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);
