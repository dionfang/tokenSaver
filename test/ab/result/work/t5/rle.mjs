// Run-length encoding for lowercase-letter text: 'aaabcc' -> 'a3b1c2'

export function encode(text) {
  if (typeof text !== 'string') {
    throw new TypeError('encode expects a string');
  }
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let j = i + 1;
    while (j < text.length && text[j] === ch) j++;
    out += ch + String(j - i);
    i = j;
  }
  return out;
}

export function decode(text) {
  if (typeof text !== 'string') {
    throw new TypeError('decode expects a string');
  }
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch < 'a' || ch > 'z') {
      throw new Error(`invalid character ${JSON.stringify(ch)} at position ${i}`);
    }
    let j = i + 1;
    while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
    const countStr = text.slice(i + 1, j);
    const count = countStr === '' ? 1 : parseInt(countStr, 10);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error(`invalid count at position ${i + 1}`);
    }
    out += ch.repeat(count);
    i = j;
  }
  return out;
}
