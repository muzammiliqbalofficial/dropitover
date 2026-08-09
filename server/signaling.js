'use strict';

const { Server } = require('socket.io');
const { networkIdFor, randomId } = require('./crypto');

/**
 * WebRTC signaling + presence.
 *
 * This server only ever carries SDP offers/answers, ICE candidates and small
 * control messages (transfer requests, join/leave notices). Actual file bytes
 * and shared text for Mode 1 and Mode 3 travel over the browsers' WebRTC data
 * channels and never reach this process.
 *
 * Mode 1 "same WiFi" discovery works by grouping sockets by the public IP the
 * connection arrives from: devices behind one NAT share a public IP, so they are
 * shown to each other as nearby peers. Browsers cannot do real LAN discovery, so
 * this is the closest workable equivalent — and it needs TRUST_PROXY set
 * correctly when running behind a reverse proxy.
 */

const ADJECTIVES = ['Swift', 'Quiet', 'Bright', 'Calm', 'Clever', 'Bold', 'Cosmic', 'Amber', 'Violet', 'Rapid'];
const NOUNS = ['Falcon', 'Otter', 'Comet', 'Maple', 'Harbor', 'Lynx', 'Ember', 'Pebble', 'Willow', 'Nimbus'];

function generateName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}

function clientIp(socket, trustProxy) {
  if (trustProxy) {
    const header = socket.handshake.headers['x-forwarded-for'];
    if (header) {
      const first = String(header).split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
  }
  return normalizeIp(socket.handshake.address || '');
}

function normalizeIp(ip) {
  // ::ffff:192.168.0.5 -> 192.168.0.5 so IPv4 and IPv4-mapped clients group together.
  return String(ip).replace(/^::ffff:/, '');
}

function publicView(socket) {
  return {
    id: socket.id,
    name: socket.data.name,
    deviceType: socket.data.deviceType,
  };
}

function sanitizeName(name) {
  const trimmed = String(name || '').trim().slice(0, 32);
  return trimmed || generateName();
}

function attachSignaling(httpServer, { rooms, config }) {
  const io = new Server(httpServer, {
    maxHttpBufferSize: 1e6, // control messages only — file bytes never come through here
    cors: { origin: false },
  });

  const netRoom = (networkId) => `net:${networkId}`;
  const chatRoom = (roomId) => `room:${roomId}`;

  function networkPeers(networkId) {
    const sockets = io.sockets.adapter.rooms.get(netRoom(networkId)) || new Set();
    const peers = [];
    for (const id of sockets) {
      const s = io.sockets.sockets.get(id);
      if (s && s.data.ready) peers.push(publicView(s));
    }
    return peers;
  }

  function broadcastPeers(networkId) {
    io.to(netRoom(networkId)).emit('peers', networkPeers(networkId));
  }

  /** Only same-network peers or co-members of a room may signal each other. */
  function canReach(from, to) {
    if (!to || to.id === from.id) return false;
    if (from.data.networkId && from.data.networkId === to.data.networkId) return true;
    return Boolean(from.data.roomId) && from.data.roomId === to.data.roomId;
  }

  io.on('connection', (socket) => {
    const ip = clientIp(socket, config.trustProxy);
    socket.data = {
      ready: false,
      name: generateName(),
      deviceType: 'desktop',
      networkId: networkIdFor(ip),
      roomId: null,
    };

    socket.on('hello', (payload = {}, ack) => {
      socket.data.name = sanitizeName(payload.name);
      socket.data.deviceType = ['mobile', 'tablet', 'desktop'].includes(payload.deviceType)
        ? payload.deviceType
        : 'desktop';
      socket.data.ready = true;
      socket.join(netRoom(socket.data.networkId));

      if (typeof ack === 'function') {
        ack({
          id: socket.id,
          name: socket.data.name,
          networkId: socket.data.networkId,
          peers: networkPeers(socket.data.networkId).filter((p) => p.id !== socket.id),
        });
      }
      broadcastPeers(socket.data.networkId);
    });

    socket.on('identity:update', (payload = {}) => {
      socket.data.name = sanitizeName(payload.name);
      broadcastPeers(socket.data.networkId);
      if (socket.data.roomId) {
        socket.to(chatRoom(socket.data.roomId)).emit('room:peer-updated', publicView(socket));
      }
    });

    socket.on('peers:refresh', (_payload, ack) => {
      const peers = networkPeers(socket.data.networkId).filter((p) => p.id !== socket.id);
      if (typeof ack === 'function') ack({ peers });
    });

    // --- Mode 1: ask before sending -----------------------------------------
    socket.on('transfer:offer', (payload = {}, ack) => {
      const target = io.sockets.sockets.get(payload.to);
      if (!canReach(socket, target)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'peer_unavailable' });
        return;
      }
      const transferId = randomId(10);
      target.emit('transfer:incoming', {
        from: socket.id,
        fromName: socket.data.name,
        transferId,
        summary: payload.summary || {},
      });
      if (typeof ack === 'function') ack({ ok: true, transferId });
    });

    socket.on('transfer:response', (payload = {}) => {
      const target = io.sockets.sockets.get(payload.to);
      if (!canReach(socket, target)) return;
      target.emit('transfer:response', {
        from: socket.id,
        fromName: socket.data.name,
        transferId: payload.transferId,
        accepted: Boolean(payload.accepted),
      });
    });

    // --- WebRTC signaling (Modes 1 and 3) -----------------------------------
    socket.on('signal', (payload = {}) => {
      const target = io.sockets.sockets.get(payload.to);
      if (!canReach(socket, target)) return;
      target.emit('signal', {
        from: socket.id,
        fromName: socket.data.name,
        description: payload.description,
        candidate: payload.candidate,
      });
    });

    // --- Mode 3: rooms -------------------------------------------------------
    socket.on('room:create', (payload = {}, ack) => {
      const room = rooms.create({ name: payload.name ? String(payload.name).slice(0, 60) : null });
      if (typeof ack === 'function') {
        ack({ ok: true, roomId: room.id, expiresAt: room.expiresAt });
      }
    });

    socket.on('room:join', (payload = {}, ack) => {
      const roomId = String(payload.roomId || '');
      const result = rooms.join(roomId, publicView(socket));
      if (!result.ok) {
        if (typeof ack === 'function') ack({ ok: false, error: result.error });
        return;
      }

      socket.data.roomId = roomId;
      socket.join(chatRoom(roomId));
      socket.to(chatRoom(roomId)).emit('room:peer-joined', publicView(socket));

      if (typeof ack === 'function') {
        ack({
          ok: true,
          roomId,
          self: publicView(socket),
          peers: result.peers,
          expiresAt: result.room.expiresAt,
        });
      }
    });

    socket.on('room:leave', () => leaveRoom(socket));

    socket.on('disconnect', () => {
      leaveRoom(socket);
      if (socket.data.ready) broadcastPeers(socket.data.networkId);
    });
  });

  function leaveRoom(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    rooms.leave(roomId, socket.id);
    socket.leave(chatRoom(roomId));
    socket.data.roomId = null;
    io.to(chatRoom(roomId)).emit('room:peer-left', { id: socket.id, name: socket.data.name });
  }

  const sweeper = setInterval(() => rooms.sweep(), 60_000);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  return io;
}

module.exports = { attachSignaling, normalizeIp, generateName };
