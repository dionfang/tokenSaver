export function fib(n) {
  if (n < 0 || !Number.isInteger(n)) {
    throw new RangeError('n must be a non-negative integer');
  }
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}

if (process.argv[1] && process.argv[1].endsWith('fib.mjs')) {
  console.log(fib(40));
}
