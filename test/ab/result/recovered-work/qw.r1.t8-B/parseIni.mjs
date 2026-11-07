export function parseIni(text) {
  const out = {};
  let section = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      if (!(section in out)) out[section] = {};
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
    if (section) out[section][key] = value;
    else out[key] = value;
  }
  return out;
}
