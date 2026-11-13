import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类特殊字符混合出现', () => {
  assert.equal(
    escapeHtml('<a href="x" & y>'),
    '&lt;a href=&quot;x&quot; &amp; y&gt;'
  );
});

test('普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('hello 世界 123 foo_bar'), 'hello 世界 123 foo_bar');
});

test('数字入参先转字符串', () => {
  assert.equal(escapeHtml(404), '404');
  assert.equal(escapeHtml(0), '0');
});
