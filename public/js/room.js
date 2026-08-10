// Mode 3: room page. Everyone in the room is meshed with WebRTC data channels,
// so files and text move directly between browsers in both directions. The Room
// Durable Object only relays SDP and ICE.

import {
  $, copyText, deviceGlyph, escapeHtml, formatRelative, getIdentity,
  loadConfig, markBooted, setIdentityName, supportsWebRtc, toast,
} from './util.js';
import { PeerLink } from './peer.js';
import { Signaling } from './ws.js';
import { TransferLog, wireDropzone } from './ui.js';

const roomId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');

// How long to wait for the room to answer before offering a retry, rather than
// leaving "Joining room…" on screen indefinitely.
const JOIN_TIMEOUT_MS = 15_000;

const state = {
  config: null,
  identity: getIdentity(),
  selfId: null,
  peers: new Map(),
  joined: false,
  joinWatchdog: null,
};

const transfers = new TransferLog($('#transfers'), $('#transfers-empty'));
const signaling = new Signaling(`/ws/room/${encodeURIComponent(roomId)}`);

init().catch((err) => toast(err.message, 'error'));

async function init() {
  state.config = await loadConfig();

  $('#device-name').value = state.identity.name;
  $('#device-name').addEventListener('change', (event) => {
    const name = setIdentityName(event.target.value);
    if (name) {
      state.identity.name = name;
      signaling.send('identity', { name });
    }
  });

  const url = `${window.location.origin}/r/${roomId}`;
  $('#room-code').textContent = roomId;
  $('#room-url').textContent = url;
  $('#room-qr').src = `/api/qr?data=${encodeURIComponent(url)}`;
  $('#copy-room').addEventListener('click', () => copyText(url));

  wireDropzone($('#room-drop'), $('#room-files'), sendFiles);
  $('#send-text').addEventListener('click', sendText);
  $('#retry-join').addEventListener('click', () => window.location.reload());

  if (!supportsWebRtc()) {
    showState('state-offline');
    $('#offline-note').textContent =
      "This browser can't make direct device-to-device connections. Open the link in Chrome or Safari, " +
      'or ask the sender to use "Send via link" instead — that works everywhere.';
    markBooted();
    return;
  }

  wireSignaling();
  startJoinWatchdog();
  markBooted();
}

function showState(id) {
  for (const el of ['state-loading', 'state-missing', 'state-full', 'state-offline']) {
    $(`#${el}`).hidden = el !== id;
  }
  $('#room').hidden = Boolean(id);
}

/** Never leave "Joining room…" up forever — offer a retry instead. */
function startJoinWatchdog() {
  clearTimeout(state.joinWatchdog);
  state.joinWatchdog = setTimeout(() => {
    if (state.joined) return;
    showState('state-offline');
  }, JOIN_TIMEOUT_MS);
}

function wireSignaling() {
  signaling.on('open', () => joinRoom());

  signaling.on('close', () => {
    if (!state.joined) return;
    $('#room-status').textContent = 'Reconnecting…';
    for (const peer of state.peers.values()) peer.link?.close();
    state.peers.clear();
    renderParticipants();
  });

  signaling.on('error', ({ code }) => {
    showState(code === 'room_full' ? 'state-full' : 'state-missing');
  });

  signaling.on('signal', ({ from, fromName, description, candidate }) => {
    let peer = state.peers.get(from);
    if (!peer?.link && description?.type === 'offer') {
      // A newcomer is calling us (newcomers always initiate) — answer them.
      peer = addPeer(peer?.info || { id: from, name: fromName, deviceType: 'desktop' }, false);
    }
    peer?.link?.handleSignal({ description, candidate });
  });

  signaling.on('room:peer-joined', (info) => {
    toast(`${info.name} joined.`, 'success');
    if (!state.peers.has(info.id)) {
      state.peers.set(info.id, { info, link: null, connState: 'connecting' });
      renderParticipants();
    }
  });

  signaling.on('room:peer-updated', (info) => {
    const peer = state.peers.get(info.id);
    if (!peer) return;
    peer.info = info;
    if (peer.link) peer.link.peerName = info.name;
    renderParticipants();
  });

  signaling.on('room:peer-left', ({ id, name }) => {
    const peer = state.peers.get(id);
    if (!peer) return;
    peer.link?.close();
    state.peers.delete(id);
    renderParticipants();
    toast(`${name || 'A participant'} left the room.`, 'warn');
  });
}

async function joinRoom() {
  let result;
  try {
    result = await signaling.request('hello', state.identity);
  } catch (err) {
    showState('state-offline');
    $('#offline-note').textContent = `The room didn't respond: ${err.message}`;
    return;
  }

  if (!result?.ok) {
    showState(result?.error === 'room_full' ? 'state-full' : 'state-missing');
    return;
  }

  state.joined = true;
  clearTimeout(state.joinWatchdog);
  state.selfId = result.self.id;
  showState(null);
  $('#room-expiry').textContent =
    `This room link stays valid for about ${formatRelative(result.expiresAt)} after the last person joins. ` +
    'Nothing shared here is stored — it goes straight between browsers.';

  // We are the newcomer: open a connection to everyone already here.
  for (const info of result.peers) addPeer(info, true);
  renderParticipants();
}

function addPeer(info, initiator) {
  const existing = state.peers.get(info.id);
  if (existing?.link && !existing.link.closed) return existing;

  const link = new PeerLink({
    peerId: info.id,
    peerName: info.name,
    initiator,
    iceServers: state.config.iceServers,
    sendSignal: (message) => signaling.send('signal', message),
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
  link.on('stall', (err) => {
    peer.connState = 'stalled';
    renderParticipants();
    toast(err.message, 'warn', 12_000);
  });
  link.on('error', (err) => toast(err.message, 'error', 12_000));
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

  const self = document.createElement('li');
  self.className = 'peer self';
  self.innerHTML = `
    <span class="avatar">${deviceGlyph(state.identity.deviceType)}</span>
    <span class="meta">
      <span class="name">${escapeHtml(state.identity.name)} (you)</span>
      <span class="status">This device</span>
    </span>`;

  $('#participants').replaceChildren(
    self,
    ...peers.map((peer) => {
      const li = document.createElement('li');
      li.className = 'peer self';
      const [dot, label] = {
        connected: ['on', 'Connected · direct'],
        connecting: ['warn', 'Connecting…'],
        new: ['warn', 'Connecting…'],
        checking: ['warn', 'Negotiating…'],
        disconnected: ['warn', 'Reconnecting…'],
        stalled: ['off', 'Blocked by this network'],
        failed: ['off', 'Blocked by this network'],
        closed: ['off', 'Disconnected'],
      }[peer.connState] || ['warn', 'Connecting…'];

      li.innerHTML = `
        <span class="avatar">${deviceGlyph(peer.info.deviceType)}</span>
        <span class="meta">
          <span class="name">${escapeHtml(peer.info.name)}</span>
          <span class="status"><span class="dot ${dot}"></span> ${label}</span>
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
