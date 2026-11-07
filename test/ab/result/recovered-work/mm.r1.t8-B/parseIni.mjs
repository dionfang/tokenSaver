/**
 * 解析 INI 文本为对象。
 * 规则:
 *  - 空行、以 ; 或 # 开头的注释行忽略
 *  - [sec] 行切换当前节,后续键写入 out[sec]
 *  - 节外的键写入顶层
 *  - key = value 两侧空白去除;值两侧成对双引号去除
 *  - 无法解析的行忽略,不抛错
 */
export function parseIni(text) {
  const out = {};
  let section = null;

  const lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const first = line[0];
    if (first === ';' || first === '#') continue;

    // 节标题
    if (first === '[') {
      const m = /^\[\s*([^\[\]]*?)\s*\]$/.exec(line);
      if (!m) continue; // 无法解析,忽略
      const name = m[1];
      if (!name) continue;
      section = name;
      if (!isPlainSection(out[name])) out[name] = {};
      continue;
    }

    // 键值对
    const eq = line.indexOf('=');
    if (eq === -1) continue; // 无法解析,忽略
    const key = line.slice(0, eq).trim();
    if (!key) continue; // 无法解析,忽略

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.charCodeAt(0) === 34 /* " */ && value.charCodeAt(value.length - 1) === 34) {
      value = value.slice(1, -1);
    }

    const target = section === null ? out : out[section];
    define(target, key, value);
  }

  return out;
}

function isPlainSection(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function define(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export default parseIni;
