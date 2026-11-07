export function parseIni(text) {
  const out = {};
  let section = out;
  const lines = String(text ?? '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;

    const secMatch = /^\[(.+)\]$/.exec(line);
    if (secMatch) {
      const name = secMatch[1].trim();
      if (!name) continue;
      if (!out[name] || typeof out[name] !== 'object') out[name] = {};
      section = out[name];
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
    section[key] = value;
  }
  return out;
}
