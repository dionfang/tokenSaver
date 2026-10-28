export function encode(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    let j = i;
    while (j < text.length && text[j] === text[i]) j++;
    out += text[i] + String(j - i);
    i = j;
  }
  return out;
}

export function decode(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 2) out += text[i].repeat(Number(text[i + 1]));
  return out;
}
