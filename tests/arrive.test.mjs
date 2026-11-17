// A host handed over in the hash: node --test tests/arrive.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostFromHash, withHostFirst } from '../js/arrive.js';

test('a host name or an address after #host= is taken', () => {
  assert.equal(hostFromHash('#host=example.com'), 'example.com');
  assert.equal(hostFromHash('#host=8.8.8.8'), '8.8.8.8');
  assert.equal(hostFromHash('#host=nas'), 'nas');
  assert.equal(hostFromHash('#host=2001%3Adb8%3A%3A1'), '2001:db8::1');
  assert.equal(hostFromHash('#host=%5B2001:db8::1%5D'), '[2001:db8::1]');
});

test('anything that is not one host is refused', () => {
  for (const hash of ['', '#log', '#host=', '#host=a b', '#host=https://example.com', '#host=example.com/path', '#host=a,b', '#host=<script>', '#host=example.com&x=1',
    '#host=%E0%A4%A', '#host=' + 'a'.repeat(300), '#other=example.com', 'host=example.com', '#host=-bad.example', '#host=exa_mple.com']) {
    assert.equal(hostFromHash(hash), '', hash);
  }
});

test('the host goes first in the targets, once', () => {
  assert.equal(withHostFirst('8.8.8.8, cloudflare.com', 'example.com'), 'example.com, 8.8.8.8, cloudflare.com');
  assert.equal(withHostFirst('8.8.8.8, Example.com', 'example.com'), 'example.com, 8.8.8.8');
  assert.equal(withHostFirst('', 'example.com'), 'example.com');
  assert.equal(withHostFirst('8.8.8.8', ''), '8.8.8.8');
});
