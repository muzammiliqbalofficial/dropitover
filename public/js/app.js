// Landing page: Mode 1 (nearby devices, P2P), Mode 2 (link share), Mode 3 entry.

import {
  $, copyText, deviceGlyph, escapeHtml, fileGlyph, formatBytes, formatRelative,
  getIdentity, loadConfig, setIdentityName, toast,
} from './util.js';
import { PeerLink } from './peer.js';
import { TransferLog, confirmModal, wireDropzone } from './ui.js';

const EXPIRY_LABELS = {
  '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '3d': '3 days', '7d': '7 days',
};

const state = {
  config: null,
  identity: getIdentity(),
  selfId: null,
  peers: new Map(),
  links: new Map(),
  outgoing: new Map(),
  selection: [],
  share: null,
};

const transfers = new TransferLog($('#transfers'), $('#transfers-empty'));
const socket = io({ transports: ['websocket', 'polling'] });

init().catch((err) => toast(err.message, 'error'));

async function init() {
  state.config = await loadConfig();

  $('#device-name').value = state.identity.name;
  $('#link-limits').textContent =
    `or tap to choose — up to ${formatBytes(state.config.maxFileSize)} per file, no limit on how many`;
  $('#ice-note').textContent = state.config.hasTurn ? 'STUN + TURN' : 'STUN only';

  const expiry = $('#link-expiry');
  expiry.replaceChildren(
    ...state.config.expiryOptions.map((option) => {
      const el = document.createElement('option');
      el.value = option;
      el.textContent = EXPIRY_LABELS[option] || option;
      if (option === state.config.defaultExpiry) {
        el.selected = true;
        el.textContent += ' (default)';
      }
      return el;
    })
  );

  wireIdentity();
  wireSignaling();
  wireLinkShare();
  wireRooms();
}

// --- Identity ---------------------------------------------------------------

function wireIdentity() {
  const input = $('#device-name');
  input.addEventListener('change', () => {
    const name = setIdentityName(input.value);
    if (!name) {
      input.value = state.identity.name;
      return;
    }
    state.identity.name = name;
    socket.emit('identity:update', { name });
    toast('Other devices now see you as ' + name, 'success', 2200);
  });
}

// --- Mode 1: nearby devices -------------------------------------------------

function wireSignaling() {
  socket.on('connect', () => {
    state.selfId = socket.id;
    socket.emit('hello', state.identity, (res) => {
      state.selfId = res.id;
      renderPeers(res.peers);
    });
  });

  socket.on('disconnect', () => {
    $('#peer-count').textContent = 'Offline';
    renderPeers([]);
  });

  socket.on('peers', (peers) => renderPeers(peers));

  socket.on('signal', ({ from, description, candidate }) => {
    const link = state.links.get(from);
    if (link) link.handleSignal({ description, candidate });
  });

  socket.on('transfer:incoming', async ({ from, fromName, transferId, summary }) => {
    const accepted = await confirmModal({
      title: `${fromName} wants to send you something`,
      message: describeSummary(summary),
      confirmLabel: 'Accept',
      cancelLabel: 'Decline',
    });
    // The link must exist before we answer, so the incoming offer has a home.
    if (accepted) ensureLink(from, false, fromName);
    socket.emit('transfer:response', { to: from, transferId, accepted });
  });

  socket.on('transfer:response', async ({ from, fromName, transferId, accepted }) => {
    const pending = state.outgoing.get(transferId);
    if (!pending) return;
    state.outgoing.delete(transferId);

    if (!accepted) {
      toast(`${fromName} declined the transfer.`, 'warn');
      return;
    }

    try {
      const link = ensureLink(from, true, fromName);
      await link.waitOpen();
      if (pending.text) await link.sendText(pending.text);
      for (const file of pending.files) await link.sendFile(file);
      toast(`Sent to ${fromName}.`, 'success');
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
  });
}

function renderPeers(peers) {
  const others = peers.filter((p) => p.id !== state.selfId);
  state.peers = new Map(others.map((p) => [p.id, p]));

  // Drop connections to peers that have gone away.
  for (const [peerId, link] of state.links) {
    if (!state.peers.has(peerId)) {
      link.close();
      state.links.delete(peerId);
    }
  }

  const list = $('#peers');
  list.replaceChildren(
    ...others.map((peer) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'peer';
      button.innerHTML = `
        <span class="avatar">${deviceGlyph(peer.deviceType)}</span>
        <span class="meta">
          <span class="name">${escapeHtml(peer.name)}</span>
          <span class="status">Tap to send</span>
        </span>`;
      button.addEventListener('click', () => openSendSheet(peer));
      li.appendChild(button);
      return li;
    })
  );

  $('#peers-empty').hidden = others.length > 0;
  $('#peer-count').textContent = others.length
    ? `${others.length} device${others.length === 1 ? '' : 's'} nearby`
    : 'No devices yet';
}

function describeSummary(summary = {}) {
  const bits = [];
  if (summary.fileCount) {
    bits.push(`${summary.fileCount} file${summary.fileCount === 1 ? '' : 's'} (${formatBytes(summary.totalSize || 0)})`);
  }
  if (summary.hasText) bits.push('a text note');
  return bits.length ? `They want to send ${bits.join(' and ')}.` : 'They want to send you something.';
}

/** Small compose modal for picking files and/or typing text for one peer. */
function openSendSheet(peer) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>Send to ${escapeHtml(peer.name)}</h3>
      <p>Files stream directly to that device — nothing is uploaded to the server.</p>
      <div class="dropzone" tabindex="0" role="button">
        <strong>Choose files</strong>
        <span class="chosen">or drop them here</span>
      </div>
      <input type="file" multiple hidden>
      <div class="mt">
        <label class="field">Or send text</label>
        <textarea rows="3" placeholder="Type or paste text…"></textarea>
      </div>
      <div class="row mt">
        <button class="cancel">Cancel</button>
        <button class="btn-primary send">Send</button>
      </div>
    </div>`;

  const input = $('input[type=file]', backdrop);
  const zone = $('.dropzone', backdrop);
  const chosen = $('.chosen', backdrop);
  const textarea = $('textarea', backdrop);
  let files = [];

  wireDropzone(zone, input, (picked) => {
    files = files.concat(picked);
    chosen.textContent = `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(
      files.reduce((sum, f) => sum + f.size, 0)
    )}`;
  });

  const close = () => backdrop.remove();
  $('.cancel', backdrop).addEventListener('click', close);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });

  $('.send', backdrop).addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!files.length && !text) {
      toast('Pick a file or type something first.', 'warn');
      return;
    }
    close();
    requestTransfer(peer, files, text);
  });

  document.body.appendChild(backdrop);
  textarea.focus();
}

function requestTransfer(peer, files, text) {
  const summary = {
    fileCount: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    hasText: Boolean(text),
    names: files.slice(0, 5).map((f) => f.name),
  };

  socket.emit('transfer:offer', { to: peer.id, summary }, (ack) => {
    if (!ack?.ok) {
      toast('That device is no longer reachable.', 'error');
      return;
    }
    state.outgoing.set(ack.transferId, { peerId: peer.id, files, text });
    toast(`Waiting for ${peer.name} to accept…`);
  });
}

function ensureLink(peerId, initiator, peerName) {
  const existing = state.links.get(peerId);
  if (existing && !existing.closed) return existing;

  const link = new PeerLink({
    peerId,
    peerName: peerName || state.peers.get(peerId)?.name || 'Peer',
    initiator,
    iceServers: state.config.iceServers,
    sendSignal: (message) => socket.emit('signal', message),
  });

  link.on('progress', (p) => transfers.progress({ ...p, peer: link.peerName }));
  link.on('file', (f) => {
    transfers.completeFile({ ...f, direction: 'in' });
    toast(`Received ${f.name} from ${f.from}`, 'success');
  });
  link.on('text', (t) => {
    transfers.addText({ ...t, direction: 'in' });
    toast(`Text received from ${t.from}`, 'success');
  });
  link.on('error', (err) => toast(err.message, 'error', 6000));
  link.on('close', () => {
    if (state.links.get(peerId) === link) state.links.delete(peerId);
  });

  state.links.set(peerId, link);
  return link;
}

// --- Mode 2: link share -----------------------------------------------------

function wireLinkShare() {
  wireDropzone($('#link-drop'), $('#link-files'), addFiles);
  $('#link-send').addEventListener('click', createShare);
  $('#copy-url').addEventListener('click', () => copyText(state.share.url));
  $('#result-new').addEventListener('click', resetShareForm);
  $('#result-revoke').addEventListener('click', revokeShare);
}

function addFiles(files) {
  const tooBig = files.filter((f) => f.size > state.config.maxFileSize);
  if (tooBig.length) {
    toast(
      `${tooBig[0].name} is ${formatBytes(tooBig[0].size)} — the limit is ${formatBytes(state.config.maxFileSize)} per file.`,
      'error',
      6000
    );
  }
  state.selection = state.selection.concat(files.filter((f) => f.size <= state.config.maxFileSize));
  renderSelection();
}

function renderSelection() {
  const list = $('#link-file-list');
  list.replaceChildren(
    ...state.selection.map((file, index) => {
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `
        <div class="line">
          <span class="icon">${fileGlyph(file.type, file.name)}</span>
          <div class="meta" style="min-width:0">
            <div class="title"></div>
            <div class="note">${formatBytes(file.size)}</div>
          </div>
          <div class="spacer"></div>
          <button class="btn-sm btn-ghost remove" aria-label="Remove">✕</button>
        </div>`;
      $('.title', li).textContent = file.name;
      $('.remove', li).addEventListener('click', () => {
        state.selection.splice(index, 1);
        renderSelection();
      });
      return li;
    })
  );
}

function createShare() {
  const text = $('#link-text').value.trim();
  if (!state.selection.length && !text) {
    toast('Add a file or some text first.', 'warn');
    return;
  }

  const form = new FormData();
  state.selection.forEach((file) => form.append('files', file, file.name));
  if (text) form.append('text', text);
  form.append('expiry', $('#link-expiry').value);
  form.append('burnAfterRead', String($('#link-burn').checked));

  const button = $('#link-send');
  const fill = $('#upload-fill');
  const note = $('#upload-note');
  button.disabled = true;
  $('#upload-wrap').hidden = false;
  $('#link-result').hidden = true;
  fill.style.width = '0%';
  note.textContent = 'Encrypting and uploading…';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/links');

  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const pct = (event.loaded / event.total) * 100;
    fill.style.width = `${pct}%`;
    note.textContent = `${formatBytes(event.loaded)} of ${formatBytes(event.total)} uploaded`;
  });

  xhr.addEventListener('load', () => {
    button.disabled = false;
    let body = {};
    try {
      body = JSON.parse(xhr.responseText);
    } catch {
      /* handled below */
    }
    if (xhr.status !== 201) {
      $('#upload-wrap').hidden = true;
      toast(body.message || `Upload failed (${xhr.status})`, 'error', 6000);
      return;
    }
    note.textContent = 'Done — encrypted and stored.';
    fill.style.width = '100%';
    showShare(body);
  });

  xhr.addEventListener('error', () => {
    button.disabled = false;
    $('#upload-wrap').hidden = true;
    toast('Upload failed — check your connection.', 'error');
  });

  xhr.send(form);
}

function showShare(share) {
  state.share = share;
  $('#link-result').hidden = false;
  $('#result-url').textContent = share.url;
  $('#result-open').href = share.url;
  $('#result-qr').src = share.qr;
  $('#result-expiry').textContent = formatRelative(share.expiresAt);
  $('#result-files').textContent = share.files.length
    ? `${share.files.length} file${share.files.length === 1 ? '' : 's'} · ${formatBytes(share.totalSize)}`
    : 'Text only';
  $('#result-burn').hidden = !share.burnAfterRead;
  copyText(share.url).catch(() => {});
}

function resetShareForm() {
  state.selection = [];
  state.share = null;
  renderSelection();
  $('#link-text').value = '';
  $('#link-result').hidden = true;
  $('#upload-wrap').hidden = true;
}

async function revokeShare() {
  if (!state.share) return;
  const ok = await confirmModal({
    title: 'Delete this share?',
    message: 'The link stops working immediately and the encrypted files are removed from the server.',
    confirmLabel: 'Delete',
    cancelLabel: 'Keep',
    danger: true,
  });
  if (!ok) return;

  const res = await fetch(`/api/links/${state.share.id}`, {
    method: 'DELETE',
    headers: { 'x-owner-token': state.share.ownerToken },
  });
  if (res.ok) {
    toast('Share deleted.', 'success');
    resetShareForm();
  } else {
    toast('Could not delete the share.', 'error');
  }
}

// --- Mode 3: rooms ----------------------------------------------------------

function wireRooms() {
  $('#create-room').addEventListener('click', () => {
    socket.emit('room:create', {}, (res) => {
      if (!res?.ok) {
        toast('Could not create a room.', 'error');
        return;
      }
      window.location.href = `/r/${res.roomId}`;
    });
  });

  const join = () => {
    const raw = $('#join-code').value.trim();
    if (!raw) return;
    const code = raw.split('/').filter(Boolean).pop().split('?')[0];
    window.location.href = `/r/${encodeURIComponent(code)}`;
  };

  $('#join-room').addEventListener('click', join);
  $('#join-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join();
  });
}
