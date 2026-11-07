export function encode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] === text[i]) j++;
    out += text[i] + (j - i);
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
    out += ch.repeat(Number(num));
  }
  return out;
}
