export function encode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let count = 1;
    while (i + count < text.length && text[i + count] === ch) count++;
    out += ch + count;
    i += count;
  }
  return out;
}

export function decode(text) {
  let out = '';
  const re = /([a-z])(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out += m[1].repeat(Number(m[2]));
  }
  return out;
}
