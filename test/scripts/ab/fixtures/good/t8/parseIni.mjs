export function parseIni(text) {
  const out = {};
  let section = '';
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim(); continue; }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    let val = kv[2].trim();
    const q = val.match(/^"(.*)"$/);
    if (q) val = q[1];
    const target = section ? (out[section] ||= {}) : out;
    target[key] = val;
  }
  return out;
}
