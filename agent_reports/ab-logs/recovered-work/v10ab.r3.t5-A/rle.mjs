// Run-length encoding over lowercase letters a-z with unbounded digit runs.

export function encode(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let j = i + 1;
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
    let num = 0;
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      num = num * 10 + (text.charCodeAt(i) - 48);
      i++;
    }
    out += ch.repeat(num);
  }
  return out;
}
