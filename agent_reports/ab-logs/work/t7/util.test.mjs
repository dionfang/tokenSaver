import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类特殊字符混合转义', () => {
  assert.equal(escapeHtml('&<>"'), '&amp;&lt;&gt;&quot;');
  assert.equal(
    escapeHtml('<a href="x">&x</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;x&lt;/a&gt;'
  );
  assert.equal(escapeHtml('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
});

test('普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
  assert.equal(escapeHtml('你好，世界！'), '你好，世界！');
  assert.equal(escapeHtml('中文English123 .,;:'), '中文English123 .,;:');
});

test('数字入参先转 String 再处理', () => {
  assert.equal(escapeHtml(123), '123');
  assert.equal(escapeHtml(3.14), '3.14');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(-5), '-5');
});
