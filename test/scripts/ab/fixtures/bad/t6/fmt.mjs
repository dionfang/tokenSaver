// pad(s, n):右侧用空格补齐到长度 n;若 s 长度不小于 n,截断到 n。
export function pad(s, n) {
  return s.padStart(n, ' ');
}
