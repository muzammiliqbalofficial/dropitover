// Recipient page for a Mode 2 link. Downloads stream through the browser with a
// progress bar; the server decrypts on the fly.

import {
  $, BlobAssembler, copyText, fetchJson, fileGlyph,
  formatBytes, formatRelative, markBooted, saveBlob, toast,
} from './util.js';

const linkId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');

init();

async function init() {
  markBooted();
  try {
    const share = await fetchJson(`/api/links/${encodeURIComponent(linkId)}`);
    render(share);
  } catch (err) {
    $('#state-loading').hidden = true;
    $('#state-expired').hidden = false;
    if (err.status && err.status !== 410) $('#expired-note').textContent = err.message;
  }
}

function render(share) {
  $('#state-loading').hidden = true;
  $('#share').hidden = false;

  const parts = [];
  if (share.files.length) {
    parts.push(`${share.files.length} file${share.files.length === 1 ? '' : 's'} · ${formatBytes(share.totalSize)}`);
  }
  if (share.text) parts.push('a message');
  $('#share-sub').textContent = parts.join(' and ');
  $('#share-expiry').textContent = `Works for ${formatRelative(share.expiresAt)}`;
  $('#burn-warning').hidden = !share.burnAfterRead;

  const list = $('#share-items');
  list.replaceChildren();

  if (share.text) list.appendChild(textItem(share.text));
  for (const file of share.files) list.appendChild(fileItem(share, file));

  // Keep the expiry label honest while the page sits open.
  setInterval(() => {
    if (share.expiresAt <= Date.now()) {
      $('#share').hidden = true;
      $('#state-expired').hidden = false;
      return;
    }
    $('#share-expiry').textContent = `Works for ${formatRelative(share.expiresAt)}`;
  }, 30_000);
}

function textItem(text) {
  const li = document.createElement('li');
  li.className = 'item';
  li.innerHTML = `
    <div class="line">
      <span class="icon"><svg class="icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>
      <div class="meta" style="min-width:0">
        <div class="title">Message</div>
        <div class="note">${text.length} characters</div>
      </div>
      <div class="spacer"></div>
      <button class="btn-sm copy">Copy</button>
    </div>
    <pre class="text-body"></pre>`;
  $('.text-body', li).textContent = text;
  $('.copy', li).addEventListener('click', () => copyText(text));
  return li;
}

function fileItem(share, file) {
  const li = document.createElement('li');
  li.className = 'item';
  li.innerHTML = `
    <div class="line">
      <span class="icon">${fileGlyph(file.mime, file.name)}</span>
      <div class="meta" style="min-width:0">
        <div class="title"></div>
        <div class="note">${formatBytes(file.size)}</div>
      </div>
      <div class="spacer"></div>
      <button class="btn-sm btn-primary save">Save</button>
    </div>
    <div class="progress" hidden><span></span></div>`;

  $('.title', li).textContent = file.name;
  const button = $('.save', li);
  const bar = $('.progress', li);
  const fill = $('.progress > span', li);
  const note = $('.note', li);

  button.addEventListener('click', async () => {
    const url = `/api/links/${encodeURIComponent(share.id)}/files/${encodeURIComponent(file.id)}`;
    button.disabled = true;
    bar.hidden = false;
    bar.classList.remove('failed', 'done');
    fill.style.width = '0%';

    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Couldn't download that (${res.status})`);
      }

      if (!res.body) {
        // No streaming support — hand the URL to the browser instead.
        window.location.href = url;
        return;
      }

      const total = Number(res.headers.get('content-length')) || file.size;
      const reader = res.body.getReader();
      const assembler = new BlobAssembler();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        assembler.push(value);
        const pct = total ? Math.min(100, (assembler.total / total) * 100) : 0;
        fill.style.width = `${pct}%`;
        note.textContent = `${formatBytes(assembler.total)} of ${formatBytes(total)}`;
      }

      fill.style.width = '100%';
      bar.classList.add('done');
      note.textContent = formatBytes(file.size);
      saveBlob(assembler.toBlob(file.mime), file.name);
      button.textContent = 'Saved';
      toast(`Saved ${file.name}.`, 'success');

      if (share.burnAfterRead) {
        note.textContent = `${formatBytes(file.size)}, now deleted`;
      }
    } catch (err) {
      bar.classList.add('failed');
      note.textContent = err.message;
      toast(err.message, 'error', 6000);
    } finally {
      button.disabled = false;
    }
  });

  return li;
}
