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
  return text.replace(/([a-z])(\d+)/g, (_, ch, n) => ch.repeat(Number(n)));
}