// Mode 1 — same-network discovery.
//
// One Durable Object instance per hashed public IP. Browsers can't scan a LAN,
// so devices that reach the internet through the same NAT (identical public IP)
// are grouped here and shown to each other as nearby peers. The instance relays
// SDP/ICE between them and nothing else: the actual transfer is a direct
// WebRTC data channel between the two browsers.

import { randomId } from '../lib/crypto.js';
import { MAX_MESSAGE_BYTES, OPEN, ack, parseMessage, sanitizeDeviceType, sanitizeName, send } from '../lib/protocol.js';

export class NetworkHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation-aware accept: the instance can sleep between messages and
    // still keep every peer connected.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id: randomId(12), name: 'Device', deviceType: 'desktop', ready: false });

    return new Response(null, { status: 101, webSocket: client });
  }

  sockets(exclude) {
    return this.state.getWebSockets().filter((ws) => ws !== exclude && ws.readyState === OPEN);
  }

  socketById(id, exclude) {
    return this.sockets(exclude).find((ws) => ws.deserializeAttachment()?.id === id) || null;
  }

  peerList(exclude) {
    return this.sockets(exclude)
      .map((ws) => ws.deserializeAttachment())
      .filter((info) => info?.ready)
      .map(({ id, name, deviceType }) => ({ id, name, deviceType }));
  }

  broadcastPeers(exclude) {
    for (const ws of this.sockets(exclude)) {
      const self = ws.deserializeAttachment();
      if (!self?.ready) continue;
      send(ws, 'peers', this.peerList(exclude).filter((p) => p.id !== self.id));
    }
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
        const info = {
          ...self,
          name: sanitizeName(data.name),
          deviceType: sanitizeDeviceType(data.deviceType),
          ready: true,
        };
        ws.serializeAttachment(info);
        ack(ws, ackId, { id: info.id, name: info.name, peers: this.peerList(ws) });
        this.broadcastPeers();
        break;
      }

      case 'identity': {
        ws.serializeAttachment({ ...self, name: sanitizeName(data.name, self.name) });
        this.broadcastPeers();
        break;
      }

      case 'peers:refresh': {
        ack(ws, ackId, { peers: this.peerList(ws) });
        break;
      }

      // Mode 1 asks before it sends: the receiver gets a prompt and can decline
      // before any connection is negotiated.
      case 'transfer:offer': {
        const target = this.socketById(data.to, ws);
        if (!target) {
          ack(ws, ackId, { ok: false, error: 'peer_unavailable' });
          break;
        }
        const transferId = randomId(12);
        send(target, 'transfer:incoming', {
          from: self.id,
          fromName: self.name,
          transferId,
          summary: data.summary || {},
        });
        ack(ws, ackId, { ok: true, transferId });
        break;
      }

      case 'transfer:response': {
        const target = this.socketById(data.to, ws);
        if (!target) break;
        send(target, 'transfer:response', {
          from: self.id,
          fromName: self.name,
          transferId: data.transferId,
          accepted: Boolean(data.accepted),
        });
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
    for (const other of this.sockets(ws)) {
      const info = other.deserializeAttachment();
      if (info?.ready && self?.id) send(other, 'peer:gone', { id: self.id });
    }
    this.broadcastPeers(ws);
  }

  async webSocketError(ws) {
    this.broadcastPeers(ws);
  }
}
