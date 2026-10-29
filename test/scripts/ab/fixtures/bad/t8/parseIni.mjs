export function parseIni(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) continue;
    const [k, v] = line.split('=');
    if (k && v !== undefined) out[k.trim()] = v.trim();
  }
  return out;
}
