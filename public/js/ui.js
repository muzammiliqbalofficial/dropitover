// Shared UI pieces: the transfer log (progress bars + download buttons) and the
// accept/decline modal.

import { $, escapeHtml, fileGlyph, formatBytes, saveBlob } from './util.js';

/**
 * A live list of transfers. Each entry renders a progress bar while bytes move
 * and turns into a download button (files) or an inline block (text) when done.
 */
export class TransferLog {
  constructor(listEl, emptyEl) {
    this.list = listEl;
    this.empty = emptyEl;
    this.entries = new Map();
  }

  refreshEmpty() {
    if (this.empty) this.empty.hidden = this.entries.size > 0;
  }

  ensure(id) {
    let entry = this.entries.get(id);
    if (entry) return entry;

    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="line">
        <span class="icon"></span>
        <div class="meta" style="min-width:0">
          <div class="title"></div>
          <div class="note"></div>
        </div>
        <div class="spacer"></div>
        <div class="action"></div>
      </div>
      <div class="progress"><span></span></div>
      <div class="body"></div>`;
    this.list.prepend(li);

    entry = {
      li,
      icon: $('.icon', li),
      title: $('.title', li),
      note: $('.note', li),
      action: $('.action', li),
      bar: $('.progress', li),
      fill: $('.progress > span', li),
      body: $('.body', li),
    };
    this.entries.set(id, entry);
    this.refreshEmpty();
    return entry;
  }

  /** @param {{direction:'in'|'out', id:string, name:string, size:number, transferred:number, done:boolean, peer?:string}} p */
  progress(p) {
    const entry = this.ensure(p.id);
    const pct = p.size ? Math.min(100, (p.transferred / p.size) * 100) : p.done ? 100 : 0;
    const arrow = p.direction === 'in' ? '↓' : '↑';
    const who = p.peer ? ` ${p.direction === 'in' ? 'from' : 'to'} ${escapeHtml(p.peer)}` : '';

    entry.icon.textContent = fileGlyph(p.mime, p.name);
    entry.title.textContent = p.name;
    entry.note.innerHTML = `${arrow} ${formatBytes(p.transferred)} / ${formatBytes(p.size)}${who}`;
    entry.fill.style.width = `${pct}%`;
    if (p.done) entry.bar.classList.add('done');
  }

  failed(id, message) {
    const entry = this.ensure(id);
    entry.bar.classList.add('failed');
    entry.note.textContent = message;
  }

  /** Marks a received file as complete and offers it for download. */
  completeFile({ id, name, size, blob, from, direction = 'in' }) {
    const entry = this.ensure(id);
    entry.icon.textContent = fileGlyph(blob.type, name);
    entry.title.textContent = name;
    entry.note.textContent = `${formatBytes(size)} · ${direction === 'in' ? `from ${from}` : `sent to ${from}`}`;
    entry.fill.style.width = '100%';
    entry.bar.classList.add('done');

    const button = document.createElement('button');
    button.className = 'btn-sm btn-primary';
    button.textContent = 'Save';
    button.addEventListener('click', () => saveBlob(blob, name));
    entry.action.replaceChildren(button);
  }

  /** Renders a received or sent text snippet with a copy button. */
  addText({ id, content, from, direction = 'in' }) {
    const entry = this.ensure(id);
    entry.icon.textContent = '📝';
    entry.title.textContent = direction === 'in' ? `Message from ${from}` : `Message sent to ${from}`;
    entry.note.textContent = `${content.length} characters`;
    entry.bar.hidden = true;

    const pre = document.createElement('pre');
    pre.className = 'text-body';
    pre.textContent = content;
    entry.body.replaceChildren(pre);

    const button = document.createElement('button');
    button.className = 'btn-sm';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
      const { copyText } = await import('./util.js');
      copyText(content);
    });
    entry.action.replaceChildren(button);
  }
}

/**
 * Modal with a confirm/cancel pair.
 * @returns {Promise<boolean>} true when confirmed.
 */
export function confirmModal({ title, message, confirmLabel = 'Accept', cancelLabel = 'Decline', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3></h3>
        <p></p>
        <div class="row">
          <button class="cancel">${escapeHtml(cancelLabel)}</button>
          <button class="confirm ${danger ? 'btn-danger' : 'btn-primary'}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    $('h3', backdrop).textContent = title;
    $('p', backdrop).textContent = message;

    const done = (value) => {
      backdrop.remove();
      resolve(value);
    };
    $('.cancel', backdrop).addEventListener('click', () => done(false));
    $('.confirm', backdrop).addEventListener('click', () => done(true));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) done(false);
    });
    document.body.appendChild(backdrop);
    $('.confirm', backdrop).focus();
  });
}

/** Wires a click/drag-and-drop zone to a hidden file input. */
export function wireDropzone(zone, input, onFiles) {
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles(Array.from(input.files));
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) =>
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove('drag');
    })
  );
  zone.addEventListener('drop', (event) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) onFiles(files);
  });
}
