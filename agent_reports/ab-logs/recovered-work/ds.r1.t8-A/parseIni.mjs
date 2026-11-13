export function parseIni(text) {
  const out = {};
  let section = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith(";") || line.startsWith("#")) continue;

    const sectionMatch = /^\[(.*)\]$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      section = name;
      if (!Object.prototype.hasOwnProperty.call(out, name)) {
        out[name] = {};
      }
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    if (key === "") continue;

    let value = line.slice(eqIndex + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    const target = section === null ? out : out[section];
    target[key] = value;
  }

  return out;
}

export default parseIni;