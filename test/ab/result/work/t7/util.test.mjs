import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('混合:四类特殊字符同时出现', () => {
  assert.equal(escapeHtml('&<>"'), '&amp;&lt;&gt;&quot;');
  assert.equal(escapeHtml('a & b < c > d " e'), 'a &amp; b &lt; c &gt; d &quot; e');
});

test('普通文本(含中文)不转义', () => {
  assert.equal(escapeHtml('你好,世界'), '你好,世界');
  assert.equal(escapeHtml('Hello, TokenSaver 123!'), 'Hello, TokenSaver 123!');
});

test('数字入参:先转 String 再转义', () => {
  assert.equal(escapeHtml(123), '123');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(-7.5), '-7.5');
});
