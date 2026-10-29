// 坏实现探针:漏转义双引号(verify t7 用它替换被测文件,检验用例是否拦得住)
export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
