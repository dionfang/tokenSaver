import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类字符混合出现', () => {
  assert.equal(
    escapeHtml('<a href="x">&'),
    '&lt;a href=&quot;x&quot;&gt;&amp;'
  );
  assert.equal(
    escapeHtml('&<>"&<>"'),
    '&amp;&lt;&gt;&quot;&amp;&lt;&gt;&quot;'
  );
});

test('普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
  assert.equal(escapeHtml('你好,世界'), '你好,世界');
  assert.equal(escapeHtml('a1b2中文ABC'), 'a1b2中文ABC');
});

test('数字入参', () => {
  assert.equal(escapeHtml(123), '123');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(-1.5), '-1.5');
});
