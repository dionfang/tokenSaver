import { readFileSync } from 'node:fs';
const text = readFileSync(0, 'utf8');
const words = text.split(/\s+/).filter(Boolean).length;
const lines = text.split('\n').length;
console.log(`${text.length} ${words} ${lines}`);
