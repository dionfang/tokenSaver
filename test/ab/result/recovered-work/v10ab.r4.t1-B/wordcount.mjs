let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;

const chars = [...text.replace(/\n/g, '')].length;
const words = text.split(/[ \t\n]/).filter(Boolean).length;
const lines = text.split('\n').length;

console.log(`${chars} ${words} ${lines}`);
