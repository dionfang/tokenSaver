// Run-length encoding for text made of lowercase letters a-z.
// encode: 'aaabcc' -> 'a3b1c2'
// decode: 'a10b2'  -> 'aaaaaaaaaa' + 'bb' (inverse of encode)

export function encode(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = '';
  let cur = text[0];
  let count = 1;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === cur) {
      count++;
    } else {
      out += cur + count;
      cur = ch;
      count = 1;
    }
  }
  return out + cur + count;
}

export function decode(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i++];
    let digits = '';
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      digits += text[i++];
    }
    const count = digits === '' ? 1 : Number(digits);
    if (!Number.isFinite(count) || count < 0) {
      throw new RangeError('invalid run length: ' + digits);
    }
    out += ch.repeat(count);
  }
  return out;
}
