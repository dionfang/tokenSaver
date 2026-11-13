import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类字符混合出现', () => {
  assert.equal(
    escapeHtml('a & <b> "x"'),
    'a &amp; &lt;b&gt; &quot;x&quot;'
  );
  assert.equal(
    escapeHtml('<div id="a">&amp;</div>'),
    '&lt;div id=&quot;a&quot;&gt;&amp;amp;&lt;/div&gt;'
  );
});

test('普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('Hello world 123'), 'Hello world 123');
  assert.equal(escapeHtml('你好,世界!转义测试。'), '你好,世界!转义测试。');
  assert.equal(escapeHtml(''), '');
});

test('数字入参先转 String', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(3.14), '3.14');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(-1e3), '-1000');
});
