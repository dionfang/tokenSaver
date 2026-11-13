import { readFileSync } from 'node:fs';

const text = readFileSync(0, 'utf8');

const chars = [...text.split('\n').join('')].length;
const words = text.split(/[ \t\n]+/).filter((part) => part.length > 0).length;
const lines = text.split('\n').length;

console.log(`${chars} ${words} ${lines}`);