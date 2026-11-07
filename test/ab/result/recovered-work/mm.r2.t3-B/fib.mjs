import { fileURLToPath } from 'node:url';

/**
 * Fibonacci number, iterative implementation.
 * fib(0) = 0, fib(1) = 1, fib(n) = fib(n-1) + fib(n-2)
 * @param {number} n
 * @returns {number}
 */
export function fib(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('n must be a non-negative integer');
  }
  let prev = 0;
  let curr = 1;
  for (let i = 0; i < n; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
  }
  return prev;
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  console.log(fib(40));
}
