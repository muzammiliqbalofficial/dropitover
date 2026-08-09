// Mode 3: room page. Everyone in the room is meshed together with WebRTC data
// channels, so files and text move directly between browsers in both directions.

import {
  $, copyText, deviceGlyph, escapeHtml, formatRelative, getIdentity,
  loadConfig, setIdentityName, toast,
} from './util.js';
import { PeerLink } from './peer.js';
import { TransferLog, wireDropzone } from './ui.js';

const roomId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');

const state = {
  config: null,
  identity: getIdentity(),
  selfId: null,
  peers: new Map(), // peerId -> {info, link, connState}
  expiresAt: null,
};

const transfers = new TransferLog($('#transfers'), $('#transfers-empty'));
const socket = io({ transports: ['websocket', 'polling'] });

init().catch((err) => toast(err.message, 'error'));

async function init() {
  state.config = await loadConfig();
  $('#device-name').value = state.identity.name;
  $('#device-name').addEventListener('change', (event) => {
    const name = setIdentityName(event.target.value);
    if (name) {
      state.identity.name = name;
      socket.emit('identity:update', { name });
    }
  });

  const url = `${window.location.origin}/r/${roomId}`;
  $('#room-code').textContent = roomId;
  $('#room-url').textContent = url;
  $('#room-qr').src = `/api/qr?data=${encodeURIComponent(url)}`;
  $('#copy-room').addEventListener('click', () => copyText(url));

  wireDropzone($('#room-drop'), $('#room-files'), sendFiles);
  $('#send-text').addEventListener('click', sendText);

  wireSignaling();
}

function showState(id) {
  for (const el of ['state-loading', 'state-missing', 'state-full']) $(`#${el}`).hidden = el !== id;
  $('#room').hidden = Boolean(id);
}

function wireSignaling() {
  socket.on('connect', () => {
    socket.emit('hello', state.identity, (res) => {
      state.selfId = res.id;
      joinRoom();
    });
  });

  socket.on('disconnect', () => {
    $('#room-status').textContent = 'Reconnecting…';
    for (const peer of state.peers.values()) peer.link?.close();
    state.peers.clear();
    renderParticipants();
  });

  socket.on('signal', ({ from, fromName, description, candidate }) => {
    let peer = state.peers.get(from);
    if (!peer?.link && description?.type === 'offer') {
      // A newcomer is calling us (they always initiate) — answer them.
      peer = addPeer(peer?.info || { id: from, name: fromName, deviceType: 'desktop' }, false);
    }
    peer?.link?.handleSignal({ description, candidate });
  });

  socket.on('room:peer-joined', (info) => {
    toast(`${info.name} joined.`, 'success');
    // The newcomer starts the WebRTC handshake, so we just note their presence.
    if (!state.peers.has(info.id)) {
      state.peers.set(info.id, { info, link: null, connState: 'connecting' });
      renderParticipants();
    }
  });

  socket.on('room:peer-updated', (info) => {
    const peer = state.peers.get(info.id);
    if (!peer) return;
    peer.info = info;
    if (peer.link) peer.link.peerName = info.name;
    renderParticipants();
  });

  socket.on('room:peer-left', ({ id, name }) => {
    const peer = state.peers.get(id);
    if (!peer) return;
    peer.link?.close();
    state.peers.delete(id);
    renderParticipants();
    toast(`${name || 'A participant'} left the room.`, 'warn');
  });
}

function joinRoom() {
  socket.emit('room:join', { roomId }, (res) => {
    if (!res?.ok) {
      showState(res?.error === 'room_full' ? 'state-full' : 'state-missing');
      return;
    }

    state.expiresAt = res.expiresAt;
    showState(null);
    $('#room-expiry').textContent =
      `Room link stays valid for about ${formatRelative(res.expiresAt)} after the last person joins. ` +
      'Nothing shared here is stored on the server.';

    // We are the newcomer: open a connection to each peer already here.
    for (const info of res.peers) addPeer(info, true);
    renderParticipants();
  });
}

function addPeer(info, initiator) {
  const existing = state.peers.get(info.id);
  if (existing?.link && !existing.link.closed) return existing;

  const link = new PeerLink({
    peerId: info.id,
    peerName: info.name,
    initiator,
    iceServers: state.config.iceServers,
    sendSignal: (message) => socket.emit('signal', message),
  });

  const peer = { info, link, connState: 'connecting' };
  state.peers.set(info.id, peer);

  link.on('state', (connState) => {
    peer.connState = connState;
    renderParticipants();
  });
  link.on('open', () => {
    peer.connState = 'connected';
    renderParticipants();
    toast(`Connected to ${info.name}.`, 'success', 2400);
  });
  link.on('progress', (p) => transfers.progress({ ...p, peer: peer.info.name }));
  link.on('file', (f) => transfers.completeFile({ ...f, direction: 'in' }));
  link.on('text', (t) => transfers.addText({ ...t, direction: 'in' }));
  link.on('error', (err) => toast(err.message, 'error', 6000));
  link.on('close', () => {
    peer.connState = 'closed';
    renderParticipants();
  });

  renderParticipants();
  return peer;
}

function connectedPeers() {
  return Array.from(state.peers.values()).filter((p) => p.link?.isOpen);
}

function renderParticipants() {
  const peers = Array.from(state.peers.values());
  const list = $('#participants');

  const self = document.createElement('li');
  self.className = 'peer self';
  self.innerHTML = `
    <span class="avatar">${deviceGlyph(state.identity.deviceType)}</span>
    <span class="meta">
      <span class="name">${escapeHtml(state.identity.name)} (you)</span>
      <span class="status">Host of this tab</span>
    </span>`;

  list.replaceChildren(
    self,
    ...peers.map((peer) => {
      const li = document.createElement('li');
      li.className = 'peer self';
      const status = {
        connected: ['on', 'Connected · direct'],
        connecting: ['warn', 'Connecting…'],
        new: ['warn', 'Connecting…'],
        checking: ['warn', 'Negotiating…'],
        disconnected: ['off', 'Disconnected'],
        failed: ['off', 'Connection failed — needs TURN'],
        closed: ['off', 'Disconnected'],
      }[peer.connState] || ['warn', 'Connecting…'];

      li.innerHTML = `
        <span class="avatar">${deviceGlyph(peer.info.deviceType)}</span>
        <span class="meta">
          <span class="name">${escapeHtml(peer.info.name)}</span>
          <span class="status"><span class="dot ${status[0]}"></span> ${status[1]}</span>
        </span>`;
      return li;
    })
  );

  const ready = connectedPeers().length;
  $('#room-status').textContent = ready
    ? `${ready} connected`
    : peers.length
      ? 'Connecting…'
      : 'Waiting for someone to join';
}

async function sendFiles(files) {
  const targets = connectedPeers();
  if (!targets.length) {
    toast('Nobody is connected yet — share the room link first.', 'warn');
    return;
  }

  for (const file of files) {
    for (const peer of targets) {
      try {
        await peer.link.sendFile(file);
      } catch (err) {
        toast(`Could not send ${file.name} to ${peer.info.name}: ${err.message}`, 'error', 6000);
      }
    }
  }
}

async function sendText() {
  const box = $('#room-text');
  const text = box.value.trim();
  if (!text) return;

  const targets = connectedPeers();
  if (!targets.length) {
    toast('Nobody is connected yet — share the room link first.', 'warn');
    return;
  }

  for (const peer of targets) {
    try {
      await peer.link.sendText(text);
    } catch (err) {
      toast(`Could not send text to ${peer.info.name}: ${err.message}`, 'error');
    }
  }
  transfers.addText({ id: `local-${Date.now()}`, content: text, from: 'everyone', direction: 'out' });
  box.value = '';
}
