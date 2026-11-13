export function parseIni(text) {
  const out = {};
  let current = null;

  const source = typeof text === "string" ? text : String(text ?? "");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;

    const sectionMatch = /^\[([^\]]*)\]$/.exec(line);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
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

    if (current === null) {
      out[key] = value;
    } else {
      if (out[current] === null || typeof out[current] !== "object") out[current] = {};
      out[current][key] = value;
    }
  }

  return out;
}