// Small shared helpers: formatting, toasts, device identity, API calls.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || value % 1 === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatRelative(timestamp) {
  const seconds = Math.max(0, Math.round((timestamp - Date.now()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.round(hours / 24)} days`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fileGlyph(mime = '', name = '') {
  const type = `${mime} ${name}`.toLowerCase();
  if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|svg|heic)$/.test(type)) {
    return '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  }
  if (/^video\//.test(mime) || /\.(mp4|mov|mkv|webm)$/.test(type)) {
    return '<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>';
  }
  if (/^audio\//.test(mime) || /\.(mp3|wav|flac|m4a)$/.test(type)) {
    return '<svg class="icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  }
  if (/pdf/.test(type)) {
    return '<svg class="icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  }
  if (/zip|rar|7z|tar|gz/.test(type)) {
    return '<svg class="icon" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
  }
  if (/(text|json|xml|javascript)|\.(txt|md|csv|js|ts|py|java|css|html)$/.test(type)) {
    return '<svg class="icon" viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>';
  }
  return '<svg class="icon" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
}

export function deviceGlyph(deviceType) {
  if (deviceType === 'mobile') {
    return '<svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
  }
  if (deviceType === 'tablet') {
    return '<svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';
  }
  return '<svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
}

export function detectDeviceType() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

const NAME_KEY = 'dropitover:name';

// In-app browsers (WhatsApp, Instagram) and private modes can make localStorage
// throw on access, not just on write. Reading it at startup therefore has to be
// guarded, or the whole module dies before the page ever renders.
let fallbackName = null;

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function getIdentity() {
  let name = readStored(NAME_KEY) || fallbackName;
  if (!name) {
    const platform = /iPhone|iPad|Android/i.test(navigator.userAgent) ? 'Phone' : 'Desktop';
    name = `${platform} ${Math.floor(Math.random() * 900 + 100)}`;
    fallbackName = name;
    writeStored(NAME_KEY, name);
  }
  return { name, deviceType: detectDeviceType() };
}

export function setIdentityName(name) {
  const clean = String(name || '').trim().slice(0, 32);
  if (clean) {
    fallbackName = clean;
    writeStored(NAME_KEY, clean);
  }
  return clean;
}

/** True once a page module has finished starting up — read by the boot watchdog. */
export function markBooted() {
  window.__dropitoverBooted = true;
}

/** Browsers without WebRTC (some in-app webviews) can still use link sharing. */
export function supportsWebRtc() {
  return typeof window.RTCPeerConnection === 'function';
}

export function toast(message, type = 'info', ms = 4200) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'success', 2000);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    toast(ok ? 'Copied' : 'Copy it by hand instead', ok ? 'success' : 'error', 2600);
    return ok;
  }
}

export async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = body.error;
    throw err;
  }
  return body;
}

let cachedConfig = null;
export async function loadConfig() {
  if (!cachedConfig) cachedConfig = await fetchJson('/api/config');
  return cachedConfig;
}

/** Saves a Blob to disk with the given filename. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Collects chunks into Blob parts so multi-GB transfers don't sit in JS memory. */
export class BlobAssembler {
  constructor({ flushBytes = 16 * 1024 * 1024 } = {}) {
    this.flushBytes = flushBytes;
    this.parts = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.total = 0;
  }

  push(chunk) {
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength ?? chunk.size ?? 0;
    this.total += chunk.byteLength ?? chunk.size ?? 0;
    if (this.pendingBytes >= this.flushBytes) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    this.parts.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  toBlob(mime) {
    this.flush();
    return new Blob(this.parts, { type: mime || 'application/octet-stream' });
  }
}

/** Minimal event emitter used by the WebRTC wrapper. */
export class Emitter {
  constructor() {
    this.handlers = new Map();
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.handlers.get(event).delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.handlers.get(event) || []) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[emitter] handler for "${event}" threw:`, err);
      }
    }
  }
}
