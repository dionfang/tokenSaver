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
    escapeHtml('<script>alert("x & y")</script>'),
    '&lt;script&gt;alert(&quot;x &amp; y&quot;)&lt;/script&gt;'
  );
});

test('普通文本(含中文)保持不变', () => {
  assert.equal(escapeHtml('Hello world 123'), 'Hello world 123');
  assert.equal(escapeHtml('你好,世界!转义测试。'), '你好,世界!转义测试。');
});

test('数字入参先转字符串', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(3.14), '3.14');
  assert.equal(escapeHtml(0), '0');
});
