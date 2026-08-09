// Pure room state used by the Room Durable Object. Kept free of Cloudflare
// bindings so it can be unit-tested directly.

export class RoomState {
  /**
   * @param {{id: string, name?: string|null, createdAt: number, expiresAt: number,
   *          ttlSeconds?: number, maxParticipants?: number}} init
   */
  constructor({ id, name = null, createdAt, expiresAt, ttlSeconds = 12 * 60 * 60, maxParticipants = 8 }) {
    this.id = id;
    this.name = name;
    this.createdAt = createdAt;
    this.expiresAt = expiresAt;
    this.ttlSeconds = ttlSeconds;
    this.maxParticipants = maxParticipants;
    this.participants = [];
  }

  static create({ id, name = null, now, ttlSeconds = 12 * 60 * 60, maxParticipants = 8 }) {
    return new RoomState({
      id,
      name,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      ttlSeconds,
      maxParticipants,
    });
  }

  isExpired(now) {
    return this.expiresAt <= now;
  }

  /**
   * @returns {{ok: true, peers: object[]} | {ok: false, error: 'room_expired'|'room_full'|'already_joined'}}
   */
  join(participant, now) {
    if (this.isExpired(now)) return { ok: false, error: 'room_expired' };
    if (this.participants.some((p) => p.id === participant.id)) return { ok: false, error: 'already_joined' };
    if (this.participants.length >= this.maxParticipants) return { ok: false, error: 'room_full' };

    const peers = this.participants.map((p) => ({ ...p }));
    this.participants.push({ ...participant, joinedAt: now });
    // Every join buys the room another full TTL, so a refresh never kills it.
    this.expiresAt = now + this.ttlSeconds * 1000;
    return { ok: true, peers };
  }

  leave(participantId) {
    const index = this.participants.findIndex((p) => p.id === participantId);
    if (index === -1) return { ok: false, error: 'not_a_participant' };
    const [participant] = this.participants.splice(index, 1);
    return { ok: true, participant };
  }

  update(participantId, patch) {
    const participant = this.participants.find((p) => p.id === participantId);
    if (!participant) return null;
    Object.assign(participant, patch);
    return participant;
  }

  /** Durable part of the room — participants are live connections, not storage. */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      ttlSeconds: this.ttlSeconds,
      maxParticipants: this.maxParticipants,
    };
  }

  static fromJSON(json) {
    return new RoomState(json);
  }
}
