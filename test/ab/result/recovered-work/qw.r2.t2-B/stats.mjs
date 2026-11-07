import { readFileSync } from 'node:fs';

const path = process.argv[2];
const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim() !== '');
const nums = lines.slice(1).map(s => parseInt(s.trim(), 10));
const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
const max = nums.reduce((a, b) => (b > a ? b : a), -Infinity);
console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);
