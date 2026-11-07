import fs from 'node:fs';

const text = fs.readFileSync(0, 'utf8');

const chars = [...text.replace(/\n/g, '')].length;
const words = text.split(/[ \t\n]+/).filter((s) => s.length > 0).length;
const lines = text.split('\n').length;

console.log(`${chars} ${words} ${lines}`);
