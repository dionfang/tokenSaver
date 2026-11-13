export function encode(text) {
  if (text === "") return "";
  let result = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let j = i + 1;
    while (j < text.length && text[j] === ch) j++;
    result += ch + String(j - i);
    i = j;
  }
  return result;
}

export function decode(text) {
  if (text === "") return "";
  let result = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    i++;
    let count = "";
    while (i < text.length && text[i] >= "0" && text[i] <= "9") {
      count += text[i];
      i++;
    }
    result += ch.repeat(Number(count));
  }
  return result;
}