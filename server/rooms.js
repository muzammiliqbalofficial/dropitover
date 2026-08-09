'use strict';

const { randomId } = require('./crypto');

/**
 * Mode 3 room registry.
 *
 * A room is pure coordination state: who is in it and when it expires. File
 * bytes and text move directly between browsers over WebRTC data channels, so
 * nothing shared in a room is ever seen by this process.
 */
class RoomRegistry {
  constructor({
    ttlSeconds = 12 * 60 * 60,
    maxParticipants = 8,
    now = () => Date.now(),
    idFactory = () => randomId(8),
  } = {}) {
    this.ttlSeconds = ttlSeconds;
    this.maxParticipants = maxParticipants;
    this.now = now;
    this.idFactory = idFactory;
    this.rooms = new Map();
  }

  create({ name = null } = {}) {
    let id = this.idFactory();
    while (this.rooms.has(id)) id = this.idFactory();

    const createdAt = this.now();
    const room = {
      id,
      name,
      createdAt,
      expiresAt: createdAt + this.ttlSeconds * 1000,
      participants: [],
    };
    this.rooms.set(id, room);
    return room;
  }

  /** @returns {object|null} null when the room is unknown or expired. */
  get(id) {
    const room = this.rooms.get(id);
    if (!room) return null;
    if (room.expiresAt <= this.now()) {
      this.rooms.delete(id);
      return null;
    }
    return room;
  }

  /**
   * @returns {{ok: true, room: object, peers: object[]}
   *   | {ok: false, error: 'room_not_found'|'room_full'|'already_joined'}}
   */
  join(roomId, participant) {
    const room = this.get(roomId);
    if (!room) return { ok: false, error: 'room_not_found' };
    if (room.participants.some((p) => p.id === participant.id)) {
      return { ok: false, error: 'already_joined' };
    }
    if (room.participants.length >= this.maxParticipants) {
      return { ok: false, error: 'room_full' };
    }

    const peers = room.participants.slice();
    room.participants.push({ ...participant, joinedAt: this.now() });
    // A room stays alive for a full TTL from the last time someone joined.
    room.expiresAt = this.now() + this.ttlSeconds * 1000;
    return { ok: true, room, peers };
  }

  leave(roomId, participantId) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: 'room_not_found' };

    const index = room.participants.findIndex((p) => p.id === participantId);
    if (index === -1) return { ok: false, error: 'not_a_participant' };
    const [participant] = room.participants.splice(index, 1);

    // Empty rooms stay reservable until their TTL so a link survives a refresh.
    return { ok: true, room, participant };
  }

  /** Drops expired rooms. Called periodically by the server. */
  sweep() {
    const now = this.now();
    let removed = 0;
    for (const [id, room] of this.rooms) {
      if (room.expiresAt <= now) {
        this.rooms.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.rooms.size;
  }
}

module.exports = { RoomRegistry };
