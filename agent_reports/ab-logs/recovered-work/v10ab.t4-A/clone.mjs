export function deepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    const arr = [];
    for (let i = 0; i < value.length; i++) {
      arr[i] = deepClone(value[i]);
    }
    return arr;
  }
  const obj = {};
  for (const key of Object.keys(value)) {
    obj[key] = deepClone(value[key]);
  }
  return obj;
}
