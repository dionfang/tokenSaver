import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类特殊字符混合出现', () => {
  assert.equal(escapeHtml('& < > "'), '&amp; &lt; &gt; &quot;');
  assert.equal(
    escapeHtml('<a href="x">Tom & Jerry</a>'),
    '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;'
  );
  assert.equal(
    escapeHtml('&&<<>>""'),
    '&amp;&amp;&lt;&lt;&gt;&gt;&quot;&quot;'
  );
});

test('不含特殊字符的普通文本保持不变', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
  assert.equal(escapeHtml('你好，世界'), '你好，世界');
  assert.equal(escapeHtml('中文与 English 混排 123 !@#'), '中文与 English 混排 123 !@#');
  assert.equal(escapeHtml(''), '');
});

test('数字入参先转 String', () => {
  assert.equal(escapeHtml(123), '123');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(-1.5), '-1.5');
  assert.equal(escapeHtml(NaN), 'NaN');
});
