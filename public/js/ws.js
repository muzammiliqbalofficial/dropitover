// Signaling client: a thin WebSocket wrapper with request/ack semantics and
// automatic reconnect. Talks to the NetworkHub (Mode 1) or Room (Mode 3)
// Durable Object depending on the path it is opened with.

import { Emitter } from './util.js';

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

export class Signaling extends Emitter {
  /** @param {string} path e.g. `/ws/net` or `/ws/room/abc123` */
  constructor(path) {
    super();
    this.path = path;
    this.seq = 0;
    this.pending = new Map();
    this.queue = [];
    this.attempt = 0;
    this.manualClose = false;
    this.connect();
  }

  get url() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${this.path}`;
  }

  get isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener('open', () => {
      this.attempt = 0;
      for (const frame of this.queue.splice(0)) this.ws.send(frame);
      this.emit('open');
    });

    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.t === 'ack') {
        const resolver = this.pending.get(message.id);
        if (resolver) {
          this.pending.delete(message.id);
          clearTimeout(resolver.timer);
          resolver.resolve(message.d);
        }
        return;
      }
      this.emit(message.t, message.d);
    });

    this.ws.addEventListener('close', () => {
      this.emit('close');
      if (this.manualClose) return;
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      setTimeout(() => this.connect(), delay);
    });

    this.ws.addEventListener('error', () => this.emit('socket-error'));
  }

  send(type, data = {}) {
    const frame = JSON.stringify({ t: type, d: data });
    if (this.isOpen) this.ws.send(frame);
    else this.queue.push(frame);
  }

  /** Sends a message and resolves with the server's ack payload. */
  request(type, data = {}, timeoutMs = 12_000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The server did not respond.'));
      }, timeoutMs);

      this.pending.set(id, { resolve, timer });
      const frame = JSON.stringify({ t: type, d: data, ack: id });
      if (this.isOpen) this.ws.send(frame);
      else this.queue.push(frame);
    });
  }

  close() {
    this.manualClose = true;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}
