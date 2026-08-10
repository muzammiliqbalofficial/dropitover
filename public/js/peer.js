// WebRTC peer link: one RTCPeerConnection + one ordered data channel, used by
// both Mode 1 (nearby devices) and Mode 3 (rooms).
//
// Everything below travels browser-to-browser. The server only relays the SDP
// and ICE candidates in `signal` messages — never a single byte of payload.

import { Emitter, BlobAssembler } from './util.js';

const HIGH_WATER = 8 * 1024 * 1024; // pause sending above this much buffered
const LOW_WATER = 1 * 1024 * 1024; // resume once the buffer drains below it
const DEFAULT_CHUNK = 64 * 1024;
const MAX_CHUNK = 256 * 1024;

// How long to let ICE negotiate before telling the user something is wrong.
// Browsers can sit in `checking` for minutes on a hopeless network, so we say
// so ourselves rather than leaving "Connecting…" on screen forever.
const STALL_AFTER_MS = 20_000;

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Turns a bare failure into something the user can act on. */
function relayHint(lead) {
  return `${lead} Try putting both devices on the same Wi‑Fi, or send a link instead. That works anywhere.`;
}

/**
 * Events: `state` (connection state string), `open`, `close`, `error`,
 * `progress` ({direction,id,name,size,transferred,done}), `file` (received),
 * `text` (received), `sent` ({id,name,kind}).
 */
export class PeerLink extends Emitter {
  /**
   * @param {{peerId: string, peerName: string, initiator: boolean,
   *          iceServers: RTCIceServer[], sendSignal: (msg: object) => void}} opts
   */
  constructor({ peerId, peerName, initiator, iceServers, sendSignal }) {
    super();
    this.peerId = peerId;
    this.peerName = peerName || 'Peer';
    this.initiator = Boolean(initiator);
    this.sendSignal = sendSignal;
    this.closed = false;
    this.queue = Promise.resolve();
    this.pendingCandidates = [];
    this.incoming = null;

    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'balanced' });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.sendSignal({ to: this.peerId, candidate: event.candidate.toJSON() });
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.emit('state', state);
      if (state === 'connected') this.clearStallTimer();
      if (state === 'failed') {
        this.clearStallTimer();
        this.emit('error', new Error(relayHint("Couldn't connect on this network.")));
        this.close();
      } else if (state === 'closed') {
        // `disconnected` is often transient — ICE recovers on its own, so only a
        // truly closed connection counts as gone.
        this.emit('close');
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') {
        // Ask the browser for a fresh set of candidates once before giving up;
        // this recovers connections that lost a network interface mid-handshake.
        try {
          this.pc.restartIce?.();
        } catch {
          /* not supported — the connection-state handler will report the failure */
        }
      }
    };

    this.stallTimer = setTimeout(() => {
      if (this.isOpen || this.closed) return;
      this.emit('stall', new Error(relayHint('Still trying to connect…')));
    }, STALL_AFTER_MS);

    if (this.initiator) {
      this.setupChannel(this.pc.createDataChannel('dropitover', { ordered: true }));
      this.negotiate();
    } else {
      this.pc.ondatachannel = (event) => this.setupChannel(event.channel);
    }
  }

  async negotiate() {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal({ to: this.peerId, description: this.pc.localDescription });
    } catch (err) {
      this.emit('error', err);
    }
  }

  setupChannel(channel) {
    this.dc = channel;
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = LOW_WATER;
    this.dc.onopen = () => {
      this.clearStallTimer();
      this.emit('open');
    };
    this.dc.onclose = () => this.emit('close');
    this.dc.onerror = (event) => this.emit('error', event.error || new Error('Data channel error'));
    this.dc.onmessage = (event) => this.handleMessage(event.data);
  }

  /** Feeds in an SDP description or ICE candidate received via the signaling server. */
  async handleSignal({ description, candidate }) {
    try {
      if (description) {
        await this.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.sendSignal({ to: this.peerId, description: this.pc.localDescription });
        }
        for (const pending of this.pendingCandidates.splice(0)) {
          await this.pc.addIceCandidate(pending).catch(() => {});
        }
      } else if (candidate) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate).catch(() => {});
        else this.pendingCandidates.push(candidate);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  get isOpen() {
    return this.dc && this.dc.readyState === 'open';
  }

  /** Resolves once the channel is open, or rejects after `timeout` ms. */
  waitOpen(timeout = 25_000) {
    if (this.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        offOpen();
        offErr();
        reject(new Error('Timed out waiting for the peer connection.'));
      }, timeout);
      const offOpen = this.on('open', () => {
        clearTimeout(timer);
        offOpen();
        offErr();
        resolve();
      });
      const offErr = this.on('error', (err) => {
        clearTimeout(timer);
        offOpen();
        offErr();
        reject(err);
      });
    });
  }

  chunkSize() {
    const max = this.pc.sctp?.maxMessageSize || DEFAULT_CHUNK;
    return Math.max(16 * 1024, Math.min(MAX_CHUNK, max - 512));
  }

  /** Serializes sends so two concurrent files can't interleave their chunks. */
  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  sendText(text) {
    return this.enqueue(async () => {
      if (!this.isOpen) throw new Error('Peer is not connected.');
      const id = uid();
      this.dc.send(JSON.stringify({ t: 'text', id, content: text }));
      this.emit('sent', { id, kind: 'text', name: 'Text', size: text.length });
      return id;
    });
  }

  sendFile(file) {
    return this.enqueue(async () => {
      if (!this.isOpen) throw new Error('Peer is not connected.');
      const id = uid();
      const meta = { id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' };
      this.dc.send(JSON.stringify({ t: 'file-start', ...meta }));
      this.emit('progress', { direction: 'out', ...meta, transferred: 0, done: false });

      const chunkSize = this.chunkSize();
      let offset = 0;
      let lastTick = 0;

      while (offset < file.size) {
        const buffer = await file.slice(offset, offset + chunkSize).arrayBuffer();
        await this.drain();
        if (!this.isOpen) throw new Error('Peer disconnected mid-transfer.');
        this.dc.send(buffer);
        offset += buffer.byteLength;
        const now = performance.now();
        if (now - lastTick > 100 || offset >= file.size) {
          lastTick = now;
          this.emit('progress', { direction: 'out', ...meta, transferred: offset, done: false });
        }
      }

      this.dc.send(JSON.stringify({ t: 'file-end', id }));
      this.emit('progress', { direction: 'out', ...meta, transferred: file.size, done: true });
      this.emit('sent', { id, kind: 'file', name: file.name, size: file.size });
      return id;
    });
  }

  /** Backpressure: wait until the channel's send buffer drains. */
  drain() {
    if (!this.dc || this.dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => {
      const onLow = () => {
        this.dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      this.dc.addEventListener('bufferedamountlow', onLow);
    });
  }

  handleMessage(data) {
    if (typeof data === 'string') {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }

      if (message.t === 'text') {
        this.emit('text', { id: message.id, content: String(message.content ?? ''), from: this.peerName });
        return;
      }

      if (message.t === 'file-start') {
        this.incoming = {
          meta: { id: message.id, name: message.name, size: message.size, mime: message.mime },
          assembler: new BlobAssembler(),
          lastTick: 0,
        };
        this.emit('progress', { direction: 'in', ...this.incoming.meta, transferred: 0, done: false });
        return;
      }

      if (message.t === 'file-end' && this.incoming) {
        const { meta, assembler } = this.incoming;
        const blob = assembler.toBlob(meta.mime);
        this.incoming = null;
        this.emit('progress', { direction: 'in', ...meta, transferred: blob.size, done: true });
        this.emit('file', { ...meta, size: blob.size, blob, from: this.peerName });
      }
      return;
    }

    if (!this.incoming) return; // stray binary chunk with no header — ignore
    this.incoming.assembler.push(data);
    const now = performance.now();
    if (now - this.incoming.lastTick > 100) {
      this.incoming.lastTick = now;
      this.emit('progress', {
        direction: 'in',
        ...this.incoming.meta,
        transferred: this.incoming.assembler.total,
        done: false,
      });
    }
  }

  clearStallTimer() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearStallTimer();
    try { this.dc?.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
    this.emit('close');
  }
}
