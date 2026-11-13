export function encode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let count = 1;
    while (i + count < text.length && text[i + count] === ch) count++;
    out += ch + String(count);
    i += count;
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
