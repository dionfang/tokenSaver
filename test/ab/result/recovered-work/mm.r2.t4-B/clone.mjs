/**
 * deepClone - 深拷贝 JSON 类型数据（对象、数组、字符串、数字、布尔值、null）。
 * 不依赖 JSON.parse / JSON.stringify。
 */
export function deepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    const arr = new Array(value.length);
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

export default deepClone;
