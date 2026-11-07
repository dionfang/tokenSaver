export function parseIni(text) {
  const out = {};
  let section = null;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;

    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) {
      section = secMatch[1].trim();
      if (!(section in out)) out[section] = {};
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue; // 无法解析的行忽略

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    const target = section && typeof out[section] === 'object' ? out[section] : out;
    target[key] = value;
  }

  return out;
}
