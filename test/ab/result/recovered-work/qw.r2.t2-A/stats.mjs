import { readFileSync } from 'node:fs';

const path = process.argv[2];
const lines = readFileSync(path, 'utf8').split(/\r?\n/);
const nums = lines.slice(1).map(s => s.trim()).filter(Boolean).map(Number);
const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
const max = Math.max(...nums);
console.log(mean.toFixed(2) + ' ' + max.toFixed(2));
