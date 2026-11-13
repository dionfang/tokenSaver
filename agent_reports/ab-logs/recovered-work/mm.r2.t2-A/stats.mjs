#!/usr/bin/env node
// Usage: node stats.mjs <csvPath>
// CSV: first line is the header, from the second line on each line holds one integer in a single column.
// Prints one line to stdout: "mean max", both numbers with two decimals, separated by a single space.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node stats.mjs <csvPath>');
  process.exit(1);
}

const text = readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);

const values = [];
for (let i = 1; i < lines.length; i++) {
  const cell = lines[i].trim();
  if (cell === '') continue;
  const n = Number(cell);
  if (Number.isFinite(n)) values.push(n);
}

if (values.length === 0) {
  console.log('0.00 0.00');
  process.exit(0);
}

let sum = 0;
let max = -Infinity;
for (const v of values) {
  sum += v;
  if (v > max) max = v;
}

const mean = sum / values.length;
console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);
