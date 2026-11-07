#!/usr/bin/env node
// Reads all UTF-8 text from stdin; prints one line: <chars> <words> <lines>
// chars: code points of text with '\n' removed
// words: non-empty segments after splitting on space/tab/newline
// lines: text.split('\n').length

const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const text = chunks.join('');
  const chars = [...text.split('\n').join('')].length;
  const words = text.split(/[ \t\n]+/).filter((s) => s !== '').length;
  const lines = text.split('\n').length;
  process.stdout.write(`${chars} ${words} ${lines}\n`);
});
