const SECTION_RE = /^\[(.*)\]$/;

function stripQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseIni(text) {
  const out = {};
  let current = null;
  const lines = String(text).split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      current = name;
      if (!isPlainObject(out[name])) out[name] = {};
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (key === '') continue;

    const value = stripQuotes(line.slice(eq + 1).trim());

    if (current === null) {
      out[key] = value;
    } else {
      if (!isPlainObject(out[current])) out[current] = {};
      out[current][key] = value;
    }
  }

  return out;
}