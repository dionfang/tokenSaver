// 解析 INI 文本为对象:空行/注释行忽略,[sec] 切节,节外键写顶层,值去两侧空白与成对双引号,无法解析的行忽略。
export function parseIni(text) {
  const out = {};
  let section = null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) {
      section = secMatch[1].trim();
      if (!(section in out)) out[section] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    const target = section ? out[section] : out;
    target[key] = value;
  }
  return out;
}
