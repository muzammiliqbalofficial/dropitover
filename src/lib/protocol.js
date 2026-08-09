// Tiny JSON envelope shared by the browser client and both Durable Objects.
//
//   client -> server: {"t": "hello", "d": {...}, "ack": 7}
//   server -> client: {"t": "peers", "d": [...]}  |  {"t": "ack", "id": 7, "d": {...}}
//
// Signaling only ever carries SDP, ICE candidates and small control messages —
// file bytes travel over the WebRTC data channel, never over this socket.

/** Largest signaling message accepted. SDP is a few KB; anything larger is abuse. */
export const MAX_MESSAGE_BYTES = 128 * 1024;

export function send(ws, type, data) {
  try {
    ws.send(JSON.stringify({ t: type, d: data }));
  } catch {
    // Socket went away between the readyState check and the send.
  }
}

export function ack(ws, id, data) {
  if (id === undefined || id === null) return;
  try {
    ws.send(JSON.stringify({ t: 'ack', id, d: data }));
  } catch {
    /* closed */
  }
}

export function parseMessage(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null;
  try {
    const message = JSON.parse(raw);
    if (!message || typeof message.t !== 'string') return null;
    return { type: message.t, data: message.d ?? {}, ackId: message.ack };
  } catch {
    return null;
  }
}

export function sanitizeName(name, fallback = 'Device') {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 32);
  return clean || fallback;
}

export function sanitizeDeviceType(type) {
  return ['mobile', 'tablet', 'desktop'].includes(type) ? type : 'desktop';
}

export const OPEN = 1;
