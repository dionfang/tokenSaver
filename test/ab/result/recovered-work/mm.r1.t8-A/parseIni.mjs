export function parseIni(text) {
  const out = {};
  if (typeof text !== 'string' || text === '') return out;

  let section = null;

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith(';') || line.startsWith('#')) continue;

    const secMatch = /^\[(.*)\]$/.exec(line);
    if (secMatch) {
      const name = secMatch[1].trim();
      if (name === '') {
        section = null;
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(out, name)) {
        out[name] = {};
      }
      section = out[name];
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (key === '') continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    const target = section === null ? out : section;
    target[key] = value;
  }

  return out;
}

export default parseIni;
