export function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }

  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) {
      result[key] = deepClone(value[key]);
    }
    return result;
  }

  return value;
}