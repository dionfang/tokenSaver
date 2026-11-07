export function deepClone(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = deepClone(value[i]);
    }
    return out;
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = deepClone(value[key]);
  }
  return out;
}
