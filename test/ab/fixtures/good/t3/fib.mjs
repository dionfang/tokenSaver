import { pathToFileURL } from 'node:url';
export function fib(n) {
  let a = 0, b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(fib(40));
