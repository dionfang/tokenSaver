export function encode(text) {
  if (text === '') return '';
  let result = '';
  let count = 1;
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && text[i] === text[i - 1]) {
      count++;
    } else {
      result += text[i - 1] + count;
      count = 1;
    }
  }
  return result;
}

export function decode(text) {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i++];
    let digits = '';
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      digits += text[i++];
    }
    result += char.repeat(Number(digits));
  }
  return result;
}