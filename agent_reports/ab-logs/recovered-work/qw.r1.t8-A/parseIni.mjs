export function parseIni(text) {
  const out = {};
  let section = null;
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const secMatch = /^\[(.*)\]$/.exec(line);
    if (secMatch) {
      section = secMatch[1].trim();
      if (section && typeof out[section] !== 'object') out[section] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    const target = section ? out[section] : out;
    if (target) target[key] = value;
  }
  return out;
}
