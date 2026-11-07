export function parseIni(text) {
  const out = {};
  let section = out;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) {
      const name = sec[1].trim();
      if (!name) continue;
      if (!out[name]) out[name] = {};
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
