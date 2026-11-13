let input = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const charCount = [...input.split('\n').join('')].length;
  const wordCount = input.split(/[ \t\n]+/).filter(Boolean).length;
  const lineCount = input.split('\n').length;

  process.stdout.write(`${charCount} ${wordCount} ${lineCount}\n`);
});