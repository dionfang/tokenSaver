/**
 * 行程长度编码（Run-Length Encoding）
 *
 * 约定：文本仅含小写字母 a-z，编码形式为 <字母><次数>，次数为十进制无符号整数（长度不限）。
 */

/**
 * 对文本做行程长度编码。
 * @param {string} text 仅含小写字母 a-z 的文本
 * @returns {string} 编码结果，例如 'aaabcc' -> 'a3b1c2'；空字符串返回空字符串
 */
export function encode(text) {
  if (typeof text !== 'string' || text.length === 0) return '';

  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let count = 1;
    while (i + count < text.length && text[i + count] === ch) {
      count++;
    }
    out.push(ch + count);
    i += count;
  }
  return out.join('');
}

/**
 * 对行程长度编码字符串解码，是 encode 的逆运算。
 * @param {string} text 形如 'a3b1c2' 的编码串
 * @returns {string} 还原后的文本；空字符串返回空字符串
 */
export function decode(text) {
  if (typeof text !== 'string' || text.length === 0) return '';

  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    i++;
    let digits = '';
    while (i < text.length && text[i] >= '0' && text[i] <= '9') {
      digits += text[i];
      i++;
    }
    const count = digits.length > 0 ? parseInt(digits, 10) : 1;
    if (Number.isFinite(count) && count > 0) {
      out.push(ch.repeat(count));
    }
  }
  return out.join('');
}
