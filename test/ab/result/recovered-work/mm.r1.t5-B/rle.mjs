/**
 * 行程长度编码 (Run-Length Encoding)
 * encode('aaabcc') -> 'a3b1c2'
 * decode('a10b2')  -> 'aaaaaaaaaa' + 'bb'
 */

export function encode(text) {
  if (!text) return '';
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let j = i + 1;
    while (j < text.length && text[j] === ch) j++;
    out += ch + (j - i);
    i = j;
  }
  return out;
}

export function decode(text) {
  if (!text) return '';
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch >= 'a' && ch <= 'z') {
      let j = i + 1;
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      const count = j > i + 1 ? parseInt(text.slice(i + 1, j), 10) : 1;
      out += ch.repeat(count);
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
