'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  require('dotenv').config();
} catch {
  // dotenv is optional at runtime; env vars may come from the platform instead.
}

const ROOT = path.resolve(__dirname, '..');

/** Selectable expiry windows, in seconds. */
const EXPIRY_OPTIONS = Object.freeze({
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '24h': 24 * 60 * 60,
  '3d': 3 * 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
});

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  const items = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function resolvePath(value, fallback) {
  return path.resolve(ROOT, value || fallback);
}

const storageDir = resolvePath(process.env.STORAGE_DIR, 'data/uploads');
fs.mkdirSync(storageDir, { recursive: true });

function loadMasterKey() {
  const inline = (process.env.MASTER_KEY || '').trim();
  if (inline) {
    const key = Buffer.from(inline, 'hex');
    if (key.length !== 32) {
      throw new Error('MASTER_KEY must be exactly 64 hex characters (32 bytes)');
    }
    return key;
  }

  const keyFile = resolvePath(process.env.MASTER_KEY_FILE, 'data/.masterkey');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });

  if (fs.existsSync(keyFile)) {
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    if (key.length !== 32) {
      throw new Error(`Master key file ${keyFile} is corrupt (expected 64 hex characters)`);
    }
    return key;
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  console.warn(
    `[config] No MASTER_KEY set — generated one and saved it to ${keyFile}.\n` +
      '         Losing that file makes every stored share permanently unreadable.'
  );
  return key;
}

function buildIceServers() {
  const servers = [
    {
      urls: list(process.env.STUN_URLS, [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
      ]),
    },
  ];

  const turnUrls = list(process.env.TURN_URLS, []);
  if (turnUrls.length) {
    servers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }
  return servers;
}

const defaultExpiry = EXPIRY_OPTIONS[process.env.DEFAULT_EXPIRY] ? process.env.DEFAULT_EXPIRY : '24h';

// Express treats a string as a list of trusted addresses, so numeric hop counts
// must stay numbers.
const rawTrustProxy = (process.env.TRUST_PROXY || '0').trim();
const trustProxy = /^\d+$/.test(rawTrustProxy) ? Number(rawTrustProxy) : rawTrustProxy;

module.exports = {
  root: ROOT,
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy,

  maxFileSize: int(process.env.MAX_FILE_SIZE, 2 * 1024 * 1024 * 1024),
  maxTotalSize: int(process.env.MAX_TOTAL_SIZE, 8 * 1024 * 1024 * 1024),
  maxTextLength: int(process.env.MAX_TEXT_LENGTH, 200000),

  expiryOptions: EXPIRY_OPTIONS,
  defaultExpiry,

  storageDir,
  cleanupIntervalMs: int(process.env.CLEANUP_INTERVAL, 300) * 1000,
  masterKey: loadMasterKey(),

  roomTtlSeconds: int(process.env.ROOM_TTL, 12 * 60 * 60),
  roomMaxParticipants: int(process.env.ROOM_MAX_PARTICIPANTS, 8),

  redisUrl: process.env.REDIS_URL || '',
  iceServers: buildIceServers(),

  EXPIRY_OPTIONS,
};
