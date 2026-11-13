// Run-length encoding: encode('aaabcc') === 'a3b1c2'; decode is its inverse.
// Input text contains only lowercase letters a-z; digit runs may be arbitrarily long.

export function encode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let j = i;
    while (j < text.length && text[j] === ch) j++;
    out += ch + String(j - i);
    i = j;
  }
  return out;
}

export function decode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i++];
    let j = i;
    while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
    const count = j > i ? Number(text.slice(i, j)) : 1;
    out += ch.repeat(count);
    i = j;
  }
  return out;
}
