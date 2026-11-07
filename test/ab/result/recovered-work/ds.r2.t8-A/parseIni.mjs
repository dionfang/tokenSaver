/**
 * Parse INI text into a plain object.
 *
 * Rules:
 * - Empty lines and comment lines starting with ';' or '#' are ignored.
 * - A "[section]" line switches the current section; following keys are
 *   written to out[section].
 * - Keys outside any section are written to the top level.
 * - "key = value" is trimmed on both sides; a pair of surrounding double
 *   quotes is stripped from the value ("a b" -> a b).
 * - Unparseable lines are ignored and never throw.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseIni(text) {
  const out = {};
  let current = null;

  const source = String(text ?? "").replace(/^\uFEFF/, "");

  for (const rawLine of source.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith(";") || line.startsWith("#")) continue;

    if (line.startsWith("[")) {
      const sectionMatch = /^\[([^\]]*)\]$/.exec(line);
      if (!sectionMatch) continue;
      const name = sectionMatch[1].trim();
      if (name === "") continue;
      current = name;
      if (
        out[name] === null ||
        typeof out[name] !== "object" ||
        Array.isArray(out[name])
      ) {
        out[name] = {};
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (key === "") continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    const target = current === null ? out : out[current];
    target[key] = value;
  }

  return out;
}