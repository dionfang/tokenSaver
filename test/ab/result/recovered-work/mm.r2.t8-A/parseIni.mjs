/**
 * INI 文本解析器(ESM)
 *
 * 规则:
 * - 空行与以 ; 或 # 开头的注释行忽略;
 * - [sec] 行切换当前节,后续键写入 out[section];
 * - 节外的键写入顶层;
 * - key = value 两侧空白去掉;值两侧成对的双引号被去掉;
 * - 无法解析的行忽略,不抛错。
 *
 * @param {string} text INI 文本
 * @returns {Object} 解析结果
 */
export function parseIni(text) {
  const out = {};
  if (typeof text !== 'string' || text.length === 0) return out;

  let section = null;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line[0] === ';' || line[0] === '#') continue;

    const secMatch = /^\[([^\]]*)\]$/.exec(line);
    if (secMatch) {
      const name = secMatch[1].trim();
      if (name !== '') {
        section = name;
        if (out[section] === null || typeof out[section] !== 'object') {
          out[section] = {};
        }
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (key === '') continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
      value = value.slice(1, -1);
    }

    if (section === null) {
      out[key] = value;
    } else {
      out[section][key] = value;
    }
  }

  return out;
}

export default parseIni;
