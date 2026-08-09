import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomState } from '../src/lib/rooms.js';

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 0, 1);

const room = (overrides = {}) =>
  RoomState.create({ id: 'abc12345', now: NOW, ttlSeconds: 12 * 3600, maxParticipants: 2, ...overrides });

const peer = (id, name = id) => ({ id, name, deviceType: 'desktop' });

test('creating a room stamps its lifetime from the TTL', () => {
  const r = room();
  assert.equal(r.id, 'abc12345');
  assert.equal(r.createdAt, NOW);
  assert.equal(r.expiresAt - NOW, 12 * HOUR);
  assert.deepEqual(r.participants, []);
  assert.equal(r.isExpired(NOW), false);
});

test('the second person to join sees the first as an existing peer', () => {
  const r = room();

  const first = r.join(peer('s1', 'Laptop'), NOW);
  assert.equal(first.ok, true);
  assert.deepEqual(first.peers, [], 'nobody was there yet');

  const second = r.join(peer('s2', 'Phone'), NOW + 1000);
  assert.equal(second.ok, true);
  assert.equal(second.peers.length, 1);
  assert.equal(second.peers[0].name, 'Laptop');
  assert.equal(r.participants.length, 2);
});

test('the peer list handed to a newcomer is a copy, not live state', () => {
  const r = room({ maxParticipants: 4 });
  r.join(peer('s1', 'Laptop'), NOW);
  const { peers } = r.join(peer('s2'), NOW);

  peers[0].name = 'tampered';
  assert.equal(r.participants[0].name, 'Laptop');
});

test('the same connection cannot join twice', () => {
  const r = room();
  r.join(peer('s1'), NOW);
  assert.deepEqual(r.join(peer('s1'), NOW), { ok: false, error: 'already_joined' });
  assert.equal(r.participants.length, 1);
});

test('a full room refuses further joins', () => {
  const r = room({ maxParticipants: 2 });
  r.join(peer('s1'), NOW);
  r.join(peer('s2'), NOW);

  assert.deepEqual(r.join(peer('s3'), NOW), { ok: false, error: 'room_full' });
  assert.equal(r.participants.length, 2);
});

test('an expired room refuses joins', () => {
  const r = room({ ttlSeconds: 3600 });
  assert.deepEqual(r.join(peer('s1'), NOW + HOUR), { ok: false, error: 'room_expired' });
  assert.equal(r.isExpired(NOW + HOUR), true, 'the expiry instant counts as expired');
  assert.equal(r.isExpired(NOW + HOUR - 1), false);
});

test('leaving frees a slot and reports who left', () => {
  const r = room({ maxParticipants: 2 });
  r.join(peer('s1', 'Laptop'), NOW);
  r.join(peer('s2', 'Phone'), NOW);

  const left = r.leave('s1');
  assert.equal(left.ok, true);
  assert.equal(left.participant.name, 'Laptop');
  assert.equal(r.participants.length, 1);
  assert.equal(r.join(peer('s3'), NOW).ok, true);

  assert.deepEqual(r.leave('ghost'), { ok: false, error: 'not_a_participant' });
});

test('each join buys another full TTL so a refresh never kills the room', () => {
  const r = room({ ttlSeconds: 3600 });
  const late = NOW + 50 * 60 * 1000;

  r.join(peer('s1'), late);
  assert.equal(r.expiresAt - late, HOUR);
});

test('renaming a participant is reflected in the room', () => {
  const r = room();
  r.join(peer('s1', 'Laptop'), NOW);

  assert.equal(r.update('s1', { name: 'Work laptop' }).name, 'Work laptop');
  assert.equal(r.participants[0].name, 'Work laptop');
  assert.equal(r.update('ghost', { name: 'x' }), null);
});

test('a room survives a round trip through Durable Object storage', () => {
  const r = room({ ttlSeconds: 3600 });
  r.join(peer('s1'), NOW);

  const restored = RoomState.fromJSON(JSON.parse(JSON.stringify(r.toJSON())));
  assert.equal(restored.id, r.id);
  assert.equal(restored.expiresAt, r.expiresAt);
  assert.equal(restored.maxParticipants, r.maxParticipants);
  assert.deepEqual(restored.participants, [], 'participants are live sockets, never stored');
});
