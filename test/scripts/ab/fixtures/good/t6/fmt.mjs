// pad(s, n):右侧用空格补齐到长度 n;若 s 长度不小于 n,截断到 n。
// 例:pad('ab', 5) → 'ab   ';pad('abcdef', 4) → 'abcd'。
export function pad(s, n) {
  const t = String(s).slice(0, n);
  return t + ' '.repeat(Math.max(0, n - t.length));
}
