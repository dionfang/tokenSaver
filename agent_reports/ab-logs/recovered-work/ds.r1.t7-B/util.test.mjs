import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类特殊字符混合出现', () => {
  assert.equal(
    escapeHtml('a & b < c > d " e'),
    'a &amp; b &lt; c &gt; d &quot; e'
  );
  assert.equal(
    escapeHtml('<a href="x&y">A & B</a>'),
    '&lt;a href=&quot;x&amp;y&quot;&gt;A &amp; B&lt;/a&gt;'
  );
});

test('普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('你好,世界!'), '你好,世界!');
  assert.equal(escapeHtml('hello world 123'), 'hello world 123');
});

test('数字入参先转 String 再原样返回', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(-3.5), '-3.5');
});
