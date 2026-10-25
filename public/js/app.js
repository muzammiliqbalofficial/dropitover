// Landing page: Mode 1 (nearby devices, P2P), Mode 2 (encrypted link share),
// Mode 3 entry (create/join a room).

import {
  $, copyText, deviceGlyph, escapeHtml, fetchJson, fileGlyph, formatBytes,
  formatRelative, getIdentity, loadConfig, markBooted, setIdentityName,
  supportsWebRtc, toast,
} from './util.js';
import { PeerLink } from './peer.js';
import { Signaling } from './ws.js';
import { uploadShare } from './upload.js';
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
const signaling = new Signaling('/ws/net');

async function boot() {
  try {
    await init();
  } catch {
    $('#peer-count').textContent = 'Connecting…';
    setTimeout(boot, 10_000);
  }
}
wireMobileMenu();
boot();

async function init() {
  state.config = await loadConfig();

  $('#device-name').value = state.identity.name;
  $('#link-limits').textContent =
    `or tap to choose. Up to ${formatBytes(state.config.maxFileSize)} each, as many as you like`;

  $('#link-expiry').replaceChildren(
    ...state.config.expiryOptions.map((option) => {
      const el = document.createElement('option');
      el.value = option;
      el.textContent = EXPIRY_LABELS[option] || option;
      if (option === state.config.defaultExpiry) el.selected = true;
      return el;
    })
  );

  wireMobileMenu();
  wireIdentity();
  wireModeDock();
  wireLinkShare();
  wireRooms();

  // Link sharing works without WebRTC; the peer-to-peer modes don't.
  if (supportsWebRtc()) {
    wireSignaling();
  } else {
    $('#peer-count').textContent = 'Not available';
    $('#peers-empty').textContent =
      "This browser can't talk to other devices directly. That usually means you're inside WhatsApp " +
      'or Instagram. Open the page in Chrome or Safari. Sending a link still works here.';
  }

  markBooted();
}

function wireMobileMenu() {
  const toggle = $('#menu-toggle');
  const nav = $('#top-nav');
  if (!toggle || !nav) return;
  const menuIcon = toggle.querySelector('.menu-icon');
  const closeIcon = toggle.querySelector('.close-icon');

  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('open', open);
    if (menuIcon) menuIcon.hidden = open;
    if (closeIcon) closeIcon.hidden = !open;
  };

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = nav.classList.contains('open');
    setOpen(!isOpen);
  });

  document.addEventListener('click', (e) => {
    if (nav.classList.contains('open') && !nav.contains(e.target) && !toggle.contains(e.target)) {
      setOpen(false);
    }
  });

  nav.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });
}

function wireIdentity() {
  const input = $('#device-name');
  input.addEventListener('change', () => {
    const name = setIdentityName(input.value);
    if (!name) {
      input.value = state.identity.name;
      return;
    }
    state.identity.name = name;
    signaling.send('identity', { name });
    toast(`Others now see you as ${name}`, 'success', 2200);
  });
}

function wireModeDock() {
  const tabs = [
    { btn: $('#tab-p2p'), panel: $('#mode-p2p') },
    { btn: $('#tab-link'), panel: $('#mode-link') },
    { btn: $('#tab-room'), panel: $('#mode-room') },
  ];
  tabs.forEach(({ btn, panel }) => {
    if (!btn || !panel) return;
    btn.addEventListener('click', () => {
      tabs.forEach((t) => {
        const active = t.btn === btn;
        t.btn.classList.toggle('active', active);
        t.btn.setAttribute('aria-selected', String(active));
        t.panel.hidden = !active;
      });
    });
  });

  // If user drops a file anywhere on window when in p2p mode with no peers, auto-switch to link tab
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (e.target.closest('#link-drop') || e.target.closest('.modal')) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length && $('#mode-p2p') && !$('#mode-p2p').hidden && state.peers.size === 0) {
      $('#tab-link')?.click();
      addFiles(files);
    }
  });
}

// --- Mode 1: nearby devices -------------------------------------------------

function wireSignaling() {
  const hello = async () => {
    try {
      const welcome = await signaling.request('hello', state.identity);
      state.selfId = welcome.id;
      renderPeers(welcome.peers || []);
    } catch {
      // A passive handshake failure is retried through the socket reconnect.
      signaling.ws?.close();
    }
  };
  signaling.on('open', hello);
  if (signaling.isOpen) hello();

  signaling.on('close', () => {
    $('#peer-count').textContent = 'Reconnecting…';
    renderPeers([]);
  });

  signaling.on('peers', (peers) => renderPeers(peers || []));

  signaling.on('signal', ({ from, description, candidate }) => {
    state.links.get(from)?.handleSignal({ description, candidate });
  });

  signaling.on('peer:gone', ({ id }) => {
    state.links.get(id)?.close();
    state.links.delete(id);
  });

  signaling.on('transfer:incoming', async ({ from, fromName, transferId, summary }) => {
    const accepted = await confirmModal({
      title: `${fromName} wants to send you something`,
      message: describeSummary(summary),
      confirmLabel: 'Accept',
      cancelLabel: 'Decline',
    });
    // The link must exist before we answer, so the incoming offer has a home.
    if (accepted) ensureLink(from, false, fromName);
    signaling.send('transfer:response', { to: from, transferId, accepted });
  });

  signaling.on('transfer:response', async ({ from, fromName, transferId, accepted }) => {
    const pending = state.outgoing.get(transferId);
    if (!pending) return;
    state.outgoing.delete(transferId);

    if (!accepted) {
      toast(`${fromName} said no thanks.`, 'warn');
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

  for (const [peerId, link] of state.links) {
    if (!state.peers.has(peerId)) {
      link.close();
      state.links.delete(peerId);
    }
  }

  $('#peers').replaceChildren(
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
  if (signaling.isOpen) {
    $('#peer-count').textContent = others.length
      ? `${others.length} device${others.length === 1 ? '' : 's'} nearby`
      : 'No devices yet';
  }
}

function describeSummary(summary = {}) {
  const bits = [];
  if (summary.fileCount) {
    bits.push(`${summary.fileCount} file${summary.fileCount === 1 ? '' : 's'} (${formatBytes(summary.totalSize || 0)})`);
  }
  if (summary.hasText) bits.push('a message');
  return bits.length ? `They want to send ${bits.join(' and ')}.` : 'They want to send you something.';
}

function openSendSheet(peer) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>Send to ${escapeHtml(peer.name)}</h3>
      <p>Goes straight to that device.</p>
      <div class="dropzone" tabindex="0" role="button" aria-label="Choose files to send to ${escapeHtml(peer.name)}">
        <strong>Choose files</strong>
        <span class="chosen">or drop them here</span>
      </div>
      <label for="sheet-files" class="sr-only">Choose files to send</label>
      <input id="sheet-files" type="file" multiple class="sr-only" aria-label="Choose files to send">
      <div class="mt">
        <label class="field" for="sheet-text">Or send text</label>
        <textarea id="sheet-text" rows="3" placeholder="Type or paste something…"></textarea>
      </div>
      <div class="row mt">
        <button class="cancel">Cancel</button>
        <button class="btn-primary send">Send</button>
      </div>
    </div>`;

  const input = $('input[type=file]', backdrop);
  const chosen = $('.chosen', backdrop);
  const textarea = $('textarea', backdrop);
  let files = [];

  wireDropzone($('.dropzone', backdrop), input, (picked) => {
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

async function requestTransfer(peer, files, text) {
  const summary = {
    fileCount: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    hasText: Boolean(text),
    names: files.slice(0, 5).map((f) => f.name),
  };

  try {
    const result = await signaling.request('transfer:offer', { to: peer.id, summary });
    if (!result?.ok) {
      toast('That device went offline.', 'error');
      return;
    }
    state.outgoing.set(result.transferId, { peerId: peer.id, files, text });
    toast(`Waiting for ${peer.name} to accept…`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function ensureLink(peerId, initiator, peerName) {
  const existing = state.links.get(peerId);
  if (existing && !existing.closed) return existing;

  const link = new PeerLink({
    peerId,
    peerName: peerName || state.peers.get(peerId)?.name || 'Peer',
    initiator,
    iceServers: state.config.iceServers,
    sendSignal: (message) => signaling.send('signal', message),
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
  link.on('stall', (err) => toast(err.message, 'warn', 12_000));
  link.on('error', (err) => toast(err.message, 'error', 12_000));
  link.on('close', () => {
    if (state.links.get(peerId) === link) state.links.delete(peerId);
  });

  state.links.set(peerId, link);
  return link;
}

// --- Mode 2: encrypted link share -------------------------------------------

function wireLinkShare() {
  wireDropzone($('#link-drop'), $('#link-files'), addFiles);
  $('#link-send').addEventListener('click', createShare);
  $('#copy-url').addEventListener('click', async () => {
    if (!state.share?.url) return;
    await copyText(state.share.url);
    const btn = $('#copy-url');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('btn-copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('btn-copied');
    }, 2000);
  });
  $('#result-new').addEventListener('click', resetShareForm);
  $('#result-revoke').addEventListener('click', revokeShare);
}

function addFiles(files) {
  const tooBig = files.filter((f) => f.size > state.config.maxFileSize);
  if (tooBig.length) {
    toast(
      `${tooBig[0].name} is ${formatBytes(tooBig[0].size)}. The most you can send is ${formatBytes(state.config.maxFileSize)} a file.`,
      'error',
      6000
    );
  }
  state.selection = state.selection.concat(files.filter((f) => f.size <= state.config.maxFileSize));
  renderSelection();
}

function renderSelection() {
  $('#link-file-list').replaceChildren(
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
          <button class="btn-sm btn-ghost remove" aria-label="Remove ${escapeHtml(file.name)}"><svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
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

async function createShare() {
  const text = $('#link-text').value.trim();
  if (!state.selection.length && !text) {
    toast('Add a file or type something first.', 'warn');
    return;
  }

  const button = $('#link-send');
  const fill = $('#upload-fill');
  const note = $('#upload-note');

  button.disabled = true;
  button.textContent = 'Encrypting & uploading…';
  $('#upload-wrap').hidden = false;
  $('#link-result').hidden = true;
  fill.style.width = '0%';
  note.textContent = state.selection.length ? 'Encrypting & sending…' : 'Saving…';

  try {
    const share = await uploadShare({
      files: state.selection,
      text,
      expiry: $('#link-expiry').value,
      burnAfterRead: $('#link-burn').checked,
      onProgress: ({ sent, total }) => {
        if (!total) return;
        fill.style.width = `${Math.min(100, (sent / total) * 100)}%`;
        note.textContent = `${formatBytes(sent)} of ${formatBytes(total)} sent`;
      },
    });

    fill.style.width = '100%';
    note.textContent = 'Done. Your link is ready.';
    button.textContent = 'Create Encrypted Link';
    showShare(share);
  } catch (err) {
    fill.style.width = '0%';
    note.textContent = 'Upload interrupted. Tap retry to send again.';
    button.textContent = 'Retry Encrypted Link';
    toast(err.message, 'error', 7000);
  } finally {
    button.disabled = false;
  }
}

function showShare(share) {
  state.share = share;
  $('#link-result').hidden = false;
  $('#result-url').textContent = share.url;
  $('#result-open').href = share.url;
  $('#result-qr').src = share.qrUrl;
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
  $('#link-send').textContent = 'Create Encrypted Link';
  $('#link-text').value = '';
  $('#link-result').hidden = true;
  $('#upload-wrap').hidden = true;
}

async function revokeShare() {
  if (!state.share) return;
  const ok = await confirmModal({
    title: 'Delete this?',
    message: 'The link stops working right away and the files are removed.',
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
    toast('Deleted.', 'success');
    resetShareForm();
  } else {
    toast("Couldn't delete it.", 'error');
  }
}

// --- Mode 3: rooms ----------------------------------------------------------

function wireRooms() {
  $('#create-room').addEventListener('click', async () => {
    const button = $('#create-room');
    button.disabled = true;
    button.textContent = 'Starting room…';
    try {
      const room = await fetchJson('/api/rooms', { method: 'POST' });
      window.location.href = `/r/${room.roomId}`;
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = 'Start a Room';
    }
  });

  const join = () => {
    const raw = $('#join-code').value.trim();
    if (!raw) {
      toast('Please enter a room code or paste a room link.', 'warn');
      $('#join-code').focus();
      return;
    }
    const joinBtn = $('#join-room');
    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining…';
    const code = raw.split('/').filter(Boolean).pop().split('?')[0];
    window.location.href = `/r/${encodeURIComponent(code)}`;
  };

  $('#join-room').addEventListener('click', join);
  $('#join-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join();
  });
}
