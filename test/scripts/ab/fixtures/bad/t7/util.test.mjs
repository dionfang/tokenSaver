import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escapeHtml.mjs';

test('只测一种字符(不够边界)', () => {
  assert.equal(escapeHtml('<'), '&lt;');
});
