export function deepClone(value) {
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      result[i] = deepClone(value[i]);
    }
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value)) {
      result[key] = deepClone(value[key]);
    }
    return result;
  }
  return value;
}
