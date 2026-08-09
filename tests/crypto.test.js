import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAG_BYTES, decryptPart, deriveFileKey, encryptPart, fromHex,
  hashNetworkId, randomId, randomIv, randomSalt, timingSafeEqual, toHex,
} from '../src/lib/crypto.js';

const MASTER = new Uint8Array(32).fill(7);
const text = (s) => new TextEncoder().encode(s);

test('hex helpers round-trip', () => {
  const bytes = new Uint8Array([0, 1, 15, 16, 128, 255]);
  assert.equal(toHex(bytes), '00010f1080ff');
  assert.deepEqual(fromHex('00010f1080ff'), bytes);
  assert.throws(() => fromHex('abc'), TypeError);
  assert.throws(() => fromHex('zz'), TypeError);
});

test('random ids avoid look-alike characters and are unique in practice', () => {
  const ids = new Set(Array.from({ length: 500 }, () => randomId(10)));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[2-9a-hjkmnp-z]{10}$/);
});

test('a part encrypts and decrypts back to the original bytes', async () => {
  const key = await deriveFileKey(MASTER, randomSalt(), 'link:file');
  const iv = randomIv();
  const plaintext = text('the eagle lands at midnight');

  const ciphertext = await encryptPart(key, iv, 0, plaintext);
  assert.equal(ciphertext.length, plaintext.length + TAG_BYTES, 'ciphertext carries a 16-byte tag');
  assert.notDeepEqual(ciphertext.slice(0, plaintext.length), plaintext);

  assert.deepEqual(await decryptPart(key, iv, 0, ciphertext), plaintext);
});

test('an empty part is still authenticated', async () => {
  const key = await deriveFileKey(MASTER, randomSalt(), 'link:empty');
  const iv = randomIv();
  const ciphertext = await encryptPart(key, iv, 0, new Uint8Array(0));

  assert.equal(ciphertext.length, TAG_BYTES);
  assert.equal((await decryptPart(key, iv, 0, ciphertext)).length, 0);
});

test('tampered ciphertext fails instead of returning data', async () => {
  const key = await deriveFileKey(MASTER, randomSalt(), 'link:file');
  const iv = randomIv();
  const ciphertext = await encryptPart(key, iv, 0, text('sensitive payload'));

  const tampered = Uint8Array.from(ciphertext);
  tampered[0] ^= 0xff;
  await assert.rejects(decryptPart(key, iv, 0, tampered));
});

test('parts cannot be reordered — the index is authenticated', async () => {
  const key = await deriveFileKey(MASTER, randomSalt(), 'link:file');
  const iv = randomIv();
  const ciphertext = await encryptPart(key, iv, 3, text('chunk three'));

  await assert.rejects(decryptPart(key, iv, 4, ciphertext), 'wrong part index must fail');
  assert.deepEqual(await decryptPart(key, iv, 3, ciphertext), text('chunk three'));
});

test('each file gets a different key, so one leak does not unlock the rest', async () => {
  const salt = randomSalt();
  const iv = randomIv();
  const keyA = await deriveFileKey(MASTER, salt, 'link:fileA');
  const keyB = await deriveFileKey(MASTER, salt, 'link:fileB');

  const ciphertext = await encryptPart(keyA, iv, 0, text('for A only'));
  await assert.rejects(decryptPart(keyB, iv, 0, ciphertext));
});

test('a different master key cannot read the ciphertext', async () => {
  const salt = randomSalt();
  const iv = randomIv();
  const ciphertext = await encryptPart(await deriveFileKey(MASTER, salt, 'l:f'), iv, 0, text('secret'));

  const otherMaster = new Uint8Array(32).fill(9);
  await assert.rejects(decryptPart(await deriveFileKey(otherMaster, salt, 'l:f'), iv, 0, ciphertext));
});

test('key derivation is deterministic for the same inputs', async () => {
  const salt = randomSalt();
  const iv = randomIv();
  const plaintext = text('stable');

  const ciphertext = await encryptPart(await deriveFileKey(MASTER, salt, 'l:f'), iv, 0, plaintext);
  const rederived = await deriveFileKey(MASTER, salt, 'l:f');
  assert.deepEqual(await decryptPart(rederived, iv, 0, ciphertext), plaintext);
});

test('network ids are stable, non-reversible and hide the raw IP', async () => {
  const a = await hashNetworkId('203.0.113.10');
  const b = await hashNetworkId('203.0.113.10');
  const c = await hashNetworkId('203.0.113.11');

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a.includes('203'), false);
});

test('token comparison rejects mismatches and handles missing values', () => {
  assert.equal(timingSafeEqual('abc123', 'abc123'), true);
  assert.equal(timingSafeEqual('abc123', 'abc124'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual(null, undefined), true, 'both empty');
  assert.equal(timingSafeEqual('token', null), false);
});
