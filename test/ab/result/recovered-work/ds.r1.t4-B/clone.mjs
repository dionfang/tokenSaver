export function deepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepClone);
  }
  const result = {};
  for (const key of Object.keys(value)) {
    result[key] = deepClone(value[key]);
  }
  return result;
}