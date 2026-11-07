import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类特殊字符混合出现', () => {
  assert.equal(
    escapeHtml('<a href="x">Tom & Jerry</a>'),
    '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;'
  );
  assert.equal(escapeHtml('&<>'), '&amp;&lt;&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
});

test('不含特殊字符的普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
  assert.equal(escapeHtml('你好,世界'), '你好,世界');
  assert.equal(escapeHtml('纯中文文本没有特殊字符'), '纯中文文本没有特殊字符');
  assert.equal(escapeHtml(''), '');
});

test('数字入参', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(-1.5), '-1.5');
});
