#!/usr/bin/env node
// Usage: node stats.mjs <csv-path>
// Reads a one-column CSV (first row is a header), prints "mean max" with 2 decimals.
import { readFileSync } from 'node:fs';

const csvPath = process.argv[2];
if (!csvPath) {
	console.error('usage: node stats.mjs <csv-path>');
	process.exit(1);
}

const text = readFileSync(csvPath, 'utf8');
const lines = text.split(/\r?\n/);

// Skip the header row; collect integers from the remaining rows.
const values = [];
for (let i = 1; i < lines.length; i++) {
	const line = lines[i].trim();
	if (!line) continue;
	const n = Number.parseInt(line, 10);
	if (Number.isFinite(n)) values.push(n);
}

const count = values.length;
const sum = values.reduce((a, b) => a + b, 0);
const mean = count > 0 ? sum / count : 0;
const max = count > 0 ? values.reduce((a, b) => (b > a ? b : a), values[0]) : 0;

console.log(`${mean.toFixed(2)} ${max.toFixed(2)}`);
