/**
 * 深拷贝 JSON 类型数据（对象、数组、字符串、数字、布尔值、null）。
 * 不使用 JSON.parse / JSON.stringify。
 *
 * @param {*} value 待拷贝的值
 * @returns {*} 与入参结构一致、引用独立的副本
 */
export function deepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    const result = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      result[i] = deepClone(value[i]);
    }
    return result;
  }

  const result = {};
  for (const key of Object.keys(value)) {
    result[key] = deepClone(value[key]);
  }
  return result;
}

export default deepClone;
