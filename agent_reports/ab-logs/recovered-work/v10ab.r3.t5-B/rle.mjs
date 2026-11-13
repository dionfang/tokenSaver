// RLE for lowercase-letter text: 'aaabcc' <-> 'a3b1c2'.

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
    let num = '';
    while (i < text.length && text[i] >= '0' && text[i] <= '9') num += text[i++];
    out += ch.repeat(num === '' ? 1 : Number(num));
  }
  return out;
}
