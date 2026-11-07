/**
 * 轻量 INI 解析器。
 *
 * 规则:
 * - 空行、以 `;` 或 `#` 开头的注释行被忽略;
 * - `[sec]` 行切换当前节,后续键写入 `out[sec]`;
 * - 节外的键写入顶层;
 * - `key = value` 两侧空白去除;值两侧成对双引号去除(如 `"a b"` -> `a b`);
 * - 无法解析的行被忽略,不抛错。
 */

export function parseIni(text) {
  const out = {};
  if (typeof text !== 'string' || text.length === 0) return out;

  let section = null; // null 表示当前位于顶层

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const first = line[0];
    if (first === ';' || first === '#') continue;

    const secMatch = /^\[([^\]]*)\]$/.exec(line);
    if (secMatch) {
      const name = secMatch[1].trim();
      if (name === '') continue; // 无效节名,忽略
      section = name;
      if (Object.prototype.hasOwnProperty.call(out, name)) {
        // 同名节重复出现时沿用已有对象
        const existing = out[name];
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
          out[name] = {};
        }
      } else {
        out[name] = {};
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 没有 `=` 或键名为空,忽略

    const key = line.slice(0, eq).trim();
    if (key === '') continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }

    const target = section === null ? out : out[section];
    target[key] = value;
  }

  return out;
}

export default parseIni;
