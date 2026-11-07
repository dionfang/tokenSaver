// Run-length encoding: encode('aaabcc') === 'a3b1c2'; decode('a10b2') === 'a' x10 + 'b' x2.
// Text contains only lowercase letters a-z; digit runs may be arbitrarily long.

export function encode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let j = i;
    while (j < text.length && text[j] === ch) j++;
    out += ch + (j - i);
    i = j;
  }
  return out;
}

export function decode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i++];
    let num = '';
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      num += text[i++];
    }
    const count = num ? parseInt(num, 10) : 1;
    out += ch.repeat(count);
  }
  return out;
}
