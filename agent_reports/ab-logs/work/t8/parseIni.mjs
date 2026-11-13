// Parse INI text into an object.
// - Blank lines and lines starting with ';' or '#' are ignored.
// - '[sec]' switches the current section; following keys go to out[sec].
// - Keys before any section go to the top level.
// - 'key = value' is trimmed on both sides; paired surrounding double quotes
//   on the value are stripped ("a b" -> a b).
// - Unparseable lines are ignored without throwing.

export function parseIni(text) {
  const out = {};
  let section = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!Object.prototype.hasOwnProperty.call(out, section)) {
        out[section] = {};
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) continue; // no '=' or empty key: unparseable, skip

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    const target = section === null ? out : out[section];
    target[key] = value;
  }

  return out;
}
