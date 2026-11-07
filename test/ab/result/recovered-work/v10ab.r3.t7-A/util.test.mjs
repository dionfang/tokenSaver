import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类特殊字符混合出现全部转义', () => {
  assert.equal(
    escapeHtml('<a href="x">&</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;'
  );
});

test('不含特殊字符的普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('你好,世界 abc 123'), '你好,世界 abc 123');
});

test('数字入参先转 String 再处理', () => {
  assert.equal(escapeHtml(123), '123');
});
