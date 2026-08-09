// Mode 3 — rooms.
//
// One Durable Object instance per room id. It stores only the room's lifetime
// (created/expires) and relays signaling between the people inside. Files and
// text move directly between browsers over WebRTC data channels, so nothing
// shared in a room is ever seen by Cloudflare or by this code.

import { randomId } from '../lib/crypto.js';
import { RoomState } from '../lib/rooms.js';
import { MAX_MESSAGE_BYTES, OPEN, ack, parseMessage, sanitizeDeviceType, sanitizeName, send } from '../lib/protocol.js';

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async meta() {
    return (await this.state.storage.get('meta')) || null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      const body = await request.json();
      const room = RoomState.create({
        id: body.id,
        name: body.name ?? null,
        now: Date.now(),
        ttlSeconds: body.ttlSeconds,
        maxParticipants: body.maxParticipants,
      });
      await this.state.storage.put('meta', room.toJSON());
      await this.state.storage.setAlarm(room.expiresAt);
      return Response.json(room.toJSON());
    }

    const meta = await this.meta();

    if (url.pathname === '/info') {
      if (!meta || meta.expiresAt <= Date.now()) {
        return Response.json({ error: 'room_not_found' }, { status: 404 });
      }
      return Response.json({
        id: meta.id,
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        maxParticipants: meta.maxParticipants,
        participants: this.sockets().filter((ws) => ws.deserializeAttachment()?.ready).length,
      });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id: randomId(12), name: 'Device', deviceType: 'desktop', ready: false });

    // The socket is accepted even for a dead room so the client can be told
    // exactly why, instead of seeing a bare connection failure.
    if (!meta || meta.expiresAt <= Date.now()) {
      send(server, 'error', { code: 'room_not_found' });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  sockets(exclude) {
    return this.state.getWebSockets().filter((ws) => ws !== exclude && ws.readyState === OPEN);
  }

  socketById(id, exclude) {
    return this.sockets(exclude).find((ws) => ws.deserializeAttachment()?.id === id) || null;
  }

  participants(exclude) {
    return this.sockets(exclude)
      .map((ws) => ws.deserializeAttachment())
      .filter((info) => info?.ready)
      .map(({ id, name, deviceType }) => ({ id, name, deviceType }));
  }

  /** Rehydrates room rules from storage, with live sockets as the participants. */
  async loadRoom() {
    const meta = await this.meta();
    if (!meta) return null;
    const room = RoomState.fromJSON(meta);
    room.participants = this.participants();
    return room;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
    const message = parseMessage(raw);
    if (!message) return;

    const self = ws.deserializeAttachment();
    if (!self) return;
    const { type, data, ackId } = message;

    switch (type) {
      case 'hello': {
        const room = await this.loadRoom();
        if (!room) {
          ack(ws, ackId, { ok: false, error: 'room_not_found' });
          break;
        }

        const info = {
          ...self,
          name: sanitizeName(data.name),
          deviceType: sanitizeDeviceType(data.deviceType),
          ready: true,
        };
        const now = Date.now();
        const result = room.join({ id: info.id, name: info.name, deviceType: info.deviceType }, now);
        if (!result.ok) {
          ack(ws, ackId, { ok: false, error: result.error });
          break;
        }

        ws.serializeAttachment(info);
        await this.state.storage.put('meta', room.toJSON());
        await this.state.storage.setAlarm(room.expiresAt);

        ack(ws, ackId, {
          ok: true,
          self: { id: info.id, name: info.name, deviceType: info.deviceType },
          peers: result.peers,
          expiresAt: room.expiresAt,
          maxParticipants: room.maxParticipants,
        });

        for (const other of this.sockets(ws)) {
          if (other.deserializeAttachment()?.ready) {
            send(other, 'room:peer-joined', { id: info.id, name: info.name, deviceType: info.deviceType });
          }
        }
        break;
      }

      case 'identity': {
        const info = { ...self, name: sanitizeName(data.name, self.name) };
        ws.serializeAttachment(info);
        for (const other of this.sockets(ws)) {
          send(other, 'room:peer-updated', { id: info.id, name: info.name, deviceType: info.deviceType });
        }
        break;
      }

      case 'signal': {
        const target = this.socketById(data.to, ws);
        if (!target) break;
        send(target, 'signal', {
          from: self.id,
          fromName: self.name,
          description: data.description,
          candidate: data.candidate,
        });
        break;
      }

      case 'ping':
        ack(ws, ackId, { ok: true });
        break;

      default:
        break;
    }
  }

  async webSocketClose(ws) {
    const self = ws.deserializeAttachment();
    if (!self?.ready) return;
    for (const other of this.sockets(ws)) {
      send(other, 'room:peer-left', { id: self.id, name: self.name });
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /** TTL reached: drop the room and disconnect anyone still inside. */
  async alarm() {
    const meta = await this.meta();
    if (meta && meta.expiresAt > Date.now()) {
      await this.state.storage.setAlarm(meta.expiresAt);
      return;
    }
    for (const ws of this.sockets()) {
      send(ws, 'error', { code: 'room_expired' });
      try {
        ws.close(1000, 'room expired');
      } catch {
        /* already gone */
      }
    }
    await this.state.storage.deleteAll();
  }
}
