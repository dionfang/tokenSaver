export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  return Array.isArray(value) ? [...value] : { ...value };
}
