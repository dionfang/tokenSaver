import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('冒烟:基本转义', () => {
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
});

test('四类字符混合出现', () => {
  assert.equal(
    escapeHtml('Tom & Jerry <b>"quoted"</b>'),
    'Tom &amp; Jerry &lt;b&gt;&quot;quoted&quot;&lt;/b&gt;'
  );
  assert.equal(
    escapeHtml('&<>"'),
    '&amp;&lt;&gt;&quot;'
  );
  assert.equal(
    escapeHtml('a & b < c > d " e'),
    'a &amp; b &lt; c &gt; d &quot; e'
  );
});

test('普通文本(不含特殊字符)保持不变', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
  assert.equal(escapeHtml('你好,世界'), '你好,世界');
  assert.equal(escapeHtml('纯中文文本 123 !@#'), '纯中文文本 123 !@#');
  assert.equal(escapeHtml(''), '');
});

test('数字入参转为字符串后不转义', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(-7), '-7');
  assert.equal(escapeHtml(3.14), '3.14');
});
