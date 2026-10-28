import { readFileSync } from 'node:fs';
const text = readFileSync(0, 'utf8');
const chars = [...text.replace(/\n/g, '')].length;
const words = text.split(/\s+/).filter(Boolean).length;
const lines = text.split('\n').length;
console.log(`${chars} ${words} ${lines}`);
