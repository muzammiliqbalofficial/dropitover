import test from 'node:test';
import assert from 'node:assert/strict';

import { hasRelay, mintCloudflareTurn, normalizeIceServers } from '../src/lib/turn.js';

test('normalises the object form Cloudflare returns', () => {
  const servers = normalizeIceServers({
    iceServers: {
      urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'abc',
      credential: 'xyz',
    },
  });

  assert.equal(servers.length, 1);
  assert.equal(servers[0].urls.length, 2);
  assert.equal(servers[0].username, 'abc');
  assert.equal(servers[0].credential, 'xyz');
});

test('normalises the array form, and a bare single url', () => {
  const array = normalizeIceServers({
    iceServers: [
      { urls: 'turn:relay.example:3478', username: 'u', credential: 'c' },
      { url: 'stun:stun.example:3478' },
    ],
  });

  assert.equal(array.length, 2);
  assert.deepEqual(array[0].urls, ['turn:relay.example:3478']);
  assert.deepEqual(array[1].urls, ['stun:stun.example:3478'], 'legacy `url` key is accepted');
  assert.equal(array[1].username, undefined, 'no credentials invented for STUN');
});

test('junk responses yield null rather than a broken ICE config', () => {
  assert.equal(normalizeIceServers(null), null);
  assert.equal(normalizeIceServers({}), null);
  assert.equal(normalizeIceServers({ iceServers: [] }), null);
  assert.equal(normalizeIceServers({ iceServers: [{ nope: true }] }), null);
});

test('hasRelay distinguishes an actual relay from STUN-only', () => {
  assert.equal(hasRelay([{ urls: ['stun:stun.l.google.com:19302'] }]), false);
  assert.equal(hasRelay([{ urls: ['turn:relay.example:3478'] }]), true);
  assert.equal(hasRelay([{ urls: ['turns:relay.example:5349'] }]), true);
  assert.equal(
    hasRelay([{ urls: ['stun:a:1'] }, { urls: ['stun:b:2', 'turn:c:3'] }]),
    true,
    'a relay anywhere in the list counts'
  );
  assert.equal(hasRelay([]), false);
});

test('minting is skipped when the TURN secrets are absent', async () => {
  assert.equal(await mintCloudflareTurn({}), null);
  assert.equal(await mintCloudflareTurn({ TURN_KEY_ID: 'key' }), null, 'token also required');
  assert.equal(await mintCloudflareTurn({ TURN_API_TOKEN: 'tok' }), null, 'key id also required');
  assert.equal(await mintCloudflareTurn({ TURN_KEY_ID: '  ', TURN_API_TOKEN: ' ' }), null, 'blank counts as unset');
});

test('a failing credential API degrades to STUN instead of throwing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 401 });
  try {
    const result = await mintCloudflareTurn(
      { TURN_KEY_ID: 'key', TURN_API_TOKEN: 'tok' },
      { now: Date.now() + 9e9 } // past any cached value from another test
    );
    assert.equal(result, null);
  } finally {
    globalThis.fetch = original;
  }
});
