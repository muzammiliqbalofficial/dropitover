// Reads Worker vars/secrets into a plain config object.

import { EXPIRY_OPTIONS, DEFAULT_EXPIRY } from './expiry.js';
import { fromHex } from './crypto.js';

const MIN_PART_SIZE = 5 * 1024 * 1024; // R2 multipart minimum

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(value, fallback = []) {
  if (!value) return fallback;
  const items = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

export function readConfig(env) {
  const iceServers = [
    { urls: list(env.STUN_URLS, ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']) },
  ];
  const turnUrls = list(env.TURN_URLS);
  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: env.TURN_USERNAME || undefined,
      credential: env.TURN_CREDENTIAL || undefined,
    });
  }

  return {
    maxFileSize: int(env.MAX_FILE_SIZE, 2 * 1024 * 1024 * 1024),
    maxTotalSize: int(env.MAX_TOTAL_SIZE, 8 * 1024 * 1024 * 1024),
    maxTextLength: int(env.MAX_TEXT_LENGTH, 200_000),
    partSize: Math.max(MIN_PART_SIZE, int(env.PART_SIZE, 8 * 1024 * 1024)),
    defaultExpiry: EXPIRY_OPTIONS[env.DEFAULT_EXPIRY] ? env.DEFAULT_EXPIRY : DEFAULT_EXPIRY,
    expiryOptions: Object.keys(EXPIRY_OPTIONS),
    roomTtlSeconds: int(env.ROOM_TTL_SECONDS, 12 * 60 * 60),
    roomMaxParticipants: int(env.ROOM_MAX_PARTICIPANTS, 8),
    iceServers,
    hasTurn: turnUrls.length > 0,
  };
}

/** @throws with a setup hint when the deployment has no master key. */
export function masterKeyFrom(env) {
  const raw = (env.MASTER_KEY || '').trim();
  if (!raw) {
    throw new Error(
      'MASTER_KEY is not set. Generate one and store it as a secret:\n' +
        '  npx wrangler secret put MASTER_KEY'
    );
  }
  const key = fromHex(raw);
  if (key.length !== 32) throw new Error('MASTER_KEY must be 64 hex characters (32 bytes)');
  return key;
}
