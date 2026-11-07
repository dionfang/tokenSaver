export function encode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let n = 1;
    while (i + n < text.length && text[i + n] === ch) n++;
    out += ch + String(n);
    i += n;
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
