'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RoomRegistry } = require('../server/rooms');

const HOUR = 3600 * 1000;

function harness({ ttlSeconds = 12 * 3600, maxParticipants = 2 } = {}) {
  const clock = { now: Date.UTC(2026, 0, 1) };
  let counter = 0;
  const rooms = new RoomRegistry({
    ttlSeconds,
    maxParticipants,
    now: () => clock.now,
    idFactory: () => `room${++counter}`,
  });
  return { rooms, clock };
}

const peer = (id, name) => ({ id, name, deviceType: 'desktop' });

test('creating a room yields an id and a TTL-based expiry', () => {
  const { rooms, clock } = harness({ ttlSeconds: 12 * 3600 });
  const room = rooms.create();

  assert.equal(room.id, 'room1');
  assert.equal(room.participants.length, 0);
  assert.equal(room.createdAt, clock.now);
  assert.equal(room.expiresAt - clock.now, 12 * HOUR);
  assert.equal(rooms.get(room.id).id, room.id);
});

test('room ids are unique even when the id factory repeats itself', () => {
  const clock = { now: 0 };
  const ids = ['dup', 'dup', 'other'];
  let index = 0;
  const rooms = new RoomRegistry({ now: () => clock.now, idFactory: () => ids[Math.min(index++, ids.length - 1)] });

  assert.equal(rooms.create().id, 'dup');
  assert.equal(rooms.create().id, 'other');
  assert.equal(rooms.size, 2);
});

test('joining an unknown room reports room_not_found', () => {
  const { rooms } = harness();
  assert.deepEqual(rooms.join('nope', peer('s1', 'Phone')), { ok: false, error: 'room_not_found' });
});

test('the second person to join sees the first as an existing peer', () => {
  const { rooms } = harness();
  const room = rooms.create();

  const first = rooms.join(room.id, peer('s1', 'Laptop'));
  assert.equal(first.ok, true);
  assert.deepEqual(first.peers, [], 'nobody was there yet');

  const second = rooms.join(room.id, peer('s2', 'Phone'));
  assert.equal(second.ok, true);
  assert.equal(second.peers.length, 1);
  assert.equal(second.peers[0].id, 's1');
  assert.equal(rooms.get(room.id).participants.length, 2);
});

test('the same socket cannot join twice', () => {
  const { rooms } = harness();
  const room = rooms.create();
  rooms.join(room.id, peer('s1', 'Laptop'));

  assert.deepEqual(rooms.join(room.id, peer('s1', 'Laptop')), { ok: false, error: 'already_joined' });
  assert.equal(rooms.get(room.id).participants.length, 1);
});

test('a room refuses joins past maxParticipants', () => {
  const { rooms } = harness({ maxParticipants: 2 });
  const room = rooms.create();
  rooms.join(room.id, peer('s1'));
  rooms.join(room.id, peer('s2'));

  assert.deepEqual(rooms.join(room.id, peer('s3')), { ok: false, error: 'room_full' });
  assert.equal(rooms.get(room.id).participants.length, 2);
});

test('leaving frees a slot and reports who left', () => {
  const { rooms } = harness({ maxParticipants: 2 });
  const room = rooms.create();
  rooms.join(room.id, peer('s1', 'Laptop'));
  rooms.join(room.id, peer('s2', 'Phone'));

  const left = rooms.leave(room.id, 's1');
  assert.equal(left.ok, true);
  assert.equal(left.participant.name, 'Laptop');
  assert.equal(rooms.get(room.id).participants.length, 1);

  assert.equal(rooms.join(room.id, peer('s3', 'Tablet')).ok, true);
  assert.deepEqual(rooms.leave(room.id, 'ghost'), { ok: false, error: 'not_a_participant' });
  assert.deepEqual(rooms.leave('nope', 's1'), { ok: false, error: 'room_not_found' });
});

test('an empty room stays joinable until its TTL, so a refresh still works', () => {
  const { rooms, clock } = harness({ ttlSeconds: 3600 });
  const room = rooms.create();
  rooms.join(room.id, peer('s1'));
  rooms.leave(room.id, 's1');

  assert.ok(rooms.get(room.id), 'still reservable while empty');
  clock.now += 30 * 60 * 1000;
  assert.equal(rooms.join(room.id, peer('s1-reconnected')).ok, true);
});

test('each join extends the room by a full TTL', () => {
  const { rooms, clock } = harness({ ttlSeconds: 3600 });
  const room = rooms.create();
  clock.now += 50 * 60 * 1000;

  rooms.join(room.id, peer('s1'));
  assert.equal(rooms.get(room.id).expiresAt - clock.now, HOUR);
});

test('expired rooms disappear and sweep reclaims them', () => {
  const { rooms, clock } = harness({ ttlSeconds: 3600 });
  const room = rooms.create();

  clock.now += HOUR;
  assert.equal(rooms.get(room.id), null, 'expiry instant counts as expired');
  assert.deepEqual(rooms.join(room.id, peer('s1')), { ok: false, error: 'room_not_found' });

  const fresh = rooms.create();
  rooms.rooms.set(room.id, { ...room }); // put the stale record back to test sweep()
  assert.equal(rooms.sweep(), 1);
  assert.equal(rooms.size, 1);
  assert.ok(rooms.get(fresh.id));
});
