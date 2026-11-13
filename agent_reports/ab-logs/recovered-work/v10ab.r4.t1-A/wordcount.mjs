const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString('utf8');

const chars = [...text.replace(/\n/g, '')].length;
const words = text.split(/[ \t\n]+/).filter(Boolean).length;
const lines = text.split('\n').length;

process.stdout.write(`${chars} ${words} ${lines}\n`);
