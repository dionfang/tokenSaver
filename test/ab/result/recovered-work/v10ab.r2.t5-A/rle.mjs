export function encode(text) {
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
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let j = i + 1;
    while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
    out += ch.repeat(Number(text.slice(i + 1, j)));
    i = j;
  }
  return out;
}
