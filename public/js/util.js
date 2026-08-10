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
  if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|svg|heic)$/.test(type)) return '🖼️';
  if (/^video\//.test(mime) || /\.(mp4|mov|mkv|webm)$/.test(type)) return '🎬';
  if (/^audio\//.test(mime) || /\.(mp3|wav|flac|m4a)$/.test(type)) return '🎵';
  if (/pdf/.test(type)) return '📕';
  if (/zip|rar|7z|tar|gz/.test(type)) return '🗜️';
  if (/(text|json|xml|javascript)|\.(txt|md|csv|js|ts|py|java|css|html)$/.test(type)) return '📄';
  return '📦';
}

export function deviceGlyph(deviceType) {
  if (deviceType === 'mobile') return '📱';
  if (deviceType === 'tablet') return '💊';
  return '💻';
}

export function detectDeviceType() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

const NAME_KEY = 'sharebeam:name';

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
  window.__sharebeamBooted = true;
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
    toast('Copied to clipboard', 'success', 2000);
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
    toast(ok ? 'Copied to clipboard' : 'Copy failed — select the link manually', ok ? 'success' : 'error', 2600);
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
