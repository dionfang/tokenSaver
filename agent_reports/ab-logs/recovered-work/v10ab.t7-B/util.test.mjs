import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类特殊字符混合出现', () => {
  assert.equal(
    escapeHtml('<a href="x">&'),
    '&lt;a href=&quot;x&quot;&gt;&amp;'
  );
});

test('普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('你好,世界 123 abc'), '你好,世界 123 abc');
});

test('数字入参先转 String', () => {
  assert.equal(escapeHtml(123), '123');
  assert.equal(escapeHtml(4.56), '4.56');
});
