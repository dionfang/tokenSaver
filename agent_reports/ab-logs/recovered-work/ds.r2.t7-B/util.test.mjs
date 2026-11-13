import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类特殊字符混合出现', () => {
  assert.equal(
    escapeHtml('<a href="x">Tom & Jerry</a>'),
    '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;',
  );
});

test('普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('你好,世界! Hello World 123'), '你好,世界! Hello World 123');
});

test('数字入参先转 String 再转义', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(3.14), '3.14');
});
