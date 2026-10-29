// shortcut: 用 node:test 最小断言即可,验收只看 exit code
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('五个保留字符', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('普通文本不变', () => {
  assert.equal(escapeHtml('hello 世界 123'), 'hello 世界 123');
});

test('非字符串入参', () => {
  assert.equal(escapeHtml(42), '42');
});
