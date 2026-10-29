import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8').split('\n').slice(1).filter(Boolean).map(Number);
const mean = (rows.reduce((a, b) => a + b, 0) / rows.length).toFixed(1);
const max = Math.max(...rows).toFixed(1);
console.log(`${mean} ${max}`);
