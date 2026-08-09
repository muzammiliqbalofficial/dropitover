import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPIRY_OPTIONS, cipherRangeFor, cipherSizeFor, expiresAtFor,
  isExpired, isFullyCollected, planParts, resolveExpiry,
} from '../src/lib/expiry.js';

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 0, 1);

test('every documented expiry window resolves to the right number of seconds', () => {
  assert.deepEqual(resolveExpiry('1h'), { option: '1h', seconds: 3600 });
  assert.deepEqual(resolveExpiry('6h'), { option: '6h', seconds: 21600 });
  assert.deepEqual(resolveExpiry('24h'), { option: '24h', seconds: 86400 });
  assert.deepEqual(resolveExpiry('3d'), { option: '3d', seconds: 259200 });
  assert.deepEqual(resolveExpiry('7d'), { option: '7d', seconds: 604800 });
  assert.equal(Object.keys(EXPIRY_OPTIONS).length, 5);
});

test('unknown or missing windows fall back to the default, and a bad default falls back to 24h', () => {
  assert.deepEqual(resolveExpiry(undefined), { option: '24h', seconds: 86400 });
  assert.deepEqual(resolveExpiry('30m'), { option: '24h', seconds: 86400 });
  assert.deepEqual(resolveExpiry('99y'), { option: '24h', seconds: 86400 });
  assert.deepEqual(resolveExpiry(null, '6h'), { option: '6h', seconds: 21600 });
  assert.deepEqual(resolveExpiry('nope', 'also-nope'), { option: '24h', seconds: 86400 });
});

test('expiresAtFor adds exactly the selected window, up to 7 days', () => {
  assert.equal(expiresAtFor(NOW, '1h') - NOW, HOUR);
  assert.equal(expiresAtFor(NOW, '24h') - NOW, 24 * HOUR);
  assert.equal(expiresAtFor(NOW, '7d') - NOW, 7 * 24 * HOUR);
  assert.equal(expiresAtFor(NOW, undefined) - NOW, 24 * HOUR, 'default is 24 hours');
});

test('the expiry instant itself counts as expired', () => {
  const record = { expiresAt: NOW + HOUR };
  assert.equal(isExpired(record, NOW), false);
  assert.equal(isExpired(record, NOW + HOUR - 1), false);
  assert.equal(isExpired(record, NOW + HOUR), true);
  assert.equal(isExpired(record, NOW + HOUR + 1), true);
});

test('malformed records are treated as expired rather than valid', () => {
  assert.equal(isExpired(null, NOW), true);
  assert.equal(isExpired(undefined, NOW), true);
  assert.equal(isExpired({}, NOW), true);
  assert.equal(isExpired({ expiresAt: 'soon' }, NOW), true);
});

test('burn-after-read waits for every file and the note', () => {
  const files = [{ downloaded: false }, { downloaded: false }];
  assert.equal(isFullyCollected({ files }), false);

  files[0].downloaded = true;
  assert.equal(isFullyCollected({ files }), false, 'one file still outstanding');

  files[1].downloaded = true;
  assert.equal(isFullyCollected({ files }), true);

  assert.equal(isFullyCollected({ files, text: 'wifi password', textRead: false }), false);
  assert.equal(isFullyCollected({ files, text: 'wifi password', textRead: true }), true);
  assert.equal(isFullyCollected({ files: [], text: 'note', textRead: true }), true, 'text-only share');
});

test('planParts splits a file into equal parts with a remainder at the end', () => {
  const partSize = 8 * 1024 * 1024;

  const exact = planParts(partSize * 3, partSize);
  assert.equal(exact.partCount, 3);
  assert.ok(exact.parts.every((p) => p.length === partSize));

  const ragged = planParts(partSize * 2 + 100, partSize);
  assert.equal(ragged.partCount, 3);
  assert.equal(ragged.parts[2].length, 100);
  assert.equal(ragged.parts[2].offset, partSize * 2);

  const small = planParts(10, partSize);
  assert.equal(small.partCount, 1);
  assert.equal(small.parts[0].length, 10);

  const empty = planParts(0, partSize);
  assert.equal(empty.partCount, 1, 'an empty file still has one (empty) part');
  assert.equal(empty.parts[0].length, 0);
});

test('a 2 GB file plans a sane number of parts', () => {
  const twoGb = 2 * 1024 * 1024 * 1024;
  const { partCount } = planParts(twoGb, 8 * 1024 * 1024);
  assert.equal(partCount, 256);
});

test('planParts rejects nonsense input', () => {
  assert.throws(() => planParts(-1, 1024), RangeError);
  assert.throws(() => planParts(1024, 0), RangeError);
  assert.throws(() => planParts(Number.NaN, 1024), RangeError);
});

test('ciphertext ranges account for the per-part auth tag', () => {
  const partSize = 8 * 1024 * 1024;
  const size = partSize * 2 + 100;

  const first = cipherRangeFor(0, { size, partSize });
  assert.deepEqual(first, { offset: 0, length: partSize + 16, plainLength: partSize });

  const second = cipherRangeFor(1, { size, partSize });
  assert.equal(second.offset, partSize + 16, 'starts right after the first part and its tag');
  assert.equal(second.length, partSize + 16);

  const last = cipherRangeFor(2, { size, partSize });
  assert.equal(last.offset, partSize * 2 + 32);
  assert.equal(last.plainLength, 100);
  assert.equal(last.length, 116);

  assert.equal(cipherSizeFor(size, partSize), size + 3 * 16);
  assert.throws(() => cipherRangeFor(9, { size, partSize }), RangeError);
});

test('ranges tile the stored object with no gaps or overlaps', () => {
  const partSize = 5 * 1024 * 1024;
  const size = partSize * 4 + 7;
  const { partCount } = planParts(size, partSize);

  let cursor = 0;
  for (let index = 0; index < partCount; index += 1) {
    const range = cipherRangeFor(index, { size, partSize });
    assert.equal(range.offset, cursor, `part ${index} starts where the previous one ended`);
    cursor += range.length;
  }
  assert.equal(cursor, cipherSizeFor(size, partSize));
});
