let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;

const chars = [...text.replaceAll('\n', '')].length;
const words = text.split(/[ \t\n]/).filter((s) => s.length > 0).length;
const lines = text.split('\n').length;

console.log(`${chars} ${words} ${lines}`);
