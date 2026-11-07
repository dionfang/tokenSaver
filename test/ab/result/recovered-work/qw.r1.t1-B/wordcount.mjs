const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const text = chunks.join('');
  const chars = [...text.replace(/\n/g, '')].length;
  const words = text.split(/[ \t\n]+/).filter((s) => s.length > 0).length;
  const lines = text.split('\n').length;
  process.stdout.write(`${chars} ${words} ${lines}\n`);
});
