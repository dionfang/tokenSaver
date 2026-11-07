export function encode(text) {
  if (!text) return '';
  let out = '';
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (i + 1 < text.length && text[i + 1] === text[i]) {
      count++;
    } else {
      out += text[i] + count;
      count = 1;
    }
  }
  return out;
}

export function decode(text) {
  if (!text) return '';
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    i++;
    let digits = '';
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      digits += text[i];
      i++;
    }
    const n = digits === '' ? 1 : parseInt(digits, 10);
    for (let k = 0; k < n; k++) out += ch;
  }
  return out;
}
