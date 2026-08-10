import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalRedirect, isCanonicalHost } from '../src/lib/canonical.js';

const HOST = 'dropitover.com';

test('plain http is redirected to https, which is what makes the app work at all', () => {
  assert.equal(canonicalRedirect('http://dropitover.com/', HOST), 'https://dropitover.com/');
  assert.equal(canonicalRedirect('http://dropitover.com/d/abc123', HOST), 'https://dropitover.com/d/abc123');
});

test('www is folded into the apex', () => {
  assert.equal(canonicalRedirect('https://www.dropitover.com/', HOST), 'https://dropitover.com/');
  assert.equal(canonicalRedirect('http://www.dropitover.com/r/xyz', HOST), 'https://dropitover.com/r/xyz');
});

test('the path, query and fragment survive the redirect', () => {
  assert.equal(
    canonicalRedirect('http://www.dropitover.com/d/abc?x=1&y=2', HOST),
    'https://dropitover.com/d/abc?x=1&y=2'
  );
  assert.equal(canonicalRedirect('http://dropitover.com/api/qr?data=hello%20there', HOST),
    'https://dropitover.com/api/qr?data=hello%20there');
});

test('a request already on the canonical address is left alone', () => {
  assert.equal(canonicalRedirect('https://dropitover.com/', HOST), null);
  assert.equal(canonicalRedirect('https://dropitover.com/d/abc123', HOST), null);
});

test('other hosts are never redirected, so the fallback address keeps working', () => {
  assert.equal(canonicalRedirect('https://dropitover.someone.workers.dev/', HOST), null);
  assert.equal(canonicalRedirect('http://127.0.0.1:8787/', HOST), null);
  assert.equal(canonicalRedirect('http://localhost:8787/d/abc', HOST), null);
});

test('a lookalike domain is not swept up', () => {
  assert.equal(canonicalRedirect('https://notdropitover.com/', HOST), null);
  assert.equal(canonicalRedirect('https://dropitover.com.evil.test/', HOST), null);
});

test('no canonical host configured means no redirects', () => {
  assert.equal(canonicalRedirect('http://dropitover.com/', ''), null);
  assert.equal(canonicalRedirect('http://dropitover.com/', undefined), null);
});

test('malformed input is ignored rather than throwing', () => {
  assert.equal(canonicalRedirect('not a url', HOST), null);
  assert.equal(canonicalRedirect('', HOST), null);
});

test('only the canonical host is treated as indexable', () => {
  assert.equal(isCanonicalHost('https://dropitover.com/', HOST), true);
  assert.equal(isCanonicalHost('https://www.dropitover.com/', HOST), false);
  assert.equal(isCanonicalHost('https://dropitover.someone.workers.dev/', HOST), false);
  assert.equal(isCanonicalHost('https://anything/', ''), true, 'unconfigured means index everything');
});
