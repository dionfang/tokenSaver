import { stdin } from 'node:process';

let text = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => { text += chunk; });
stdin.on('end', () => {
  const chars = [...text.replace(/\n/g, '')].length;
  const words = text.split(/[ \t\n]+/).filter((s) => s.length > 0).length;
  const lines = text.split('\n').length;
  process.stdout.write(`${chars} ${words} ${lines}\n`);
});
