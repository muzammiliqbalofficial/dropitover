// WebCrypto helpers. Everything here works in Workers and in Node 18+, so the
// encryption round-trip is unit-testable.

export const TAG_BYTES = 16; // AES-GCM authentication tag appended to every part
const IV_BYTES = 12;
const SALT_BYTES = 16;
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

const encoder = new TextEncoder();

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const clean = String(hex).trim();
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new TypeError('invalid hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** URL-safe random id with no look-alike characters. */
export function randomId(length = 10) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export function randomIv() {
  return randomBytes(IV_BYTES);
}

export function randomSalt() {
  return randomBytes(SALT_BYTES);
}

/**
 * Stable, non-reversible id for a public IP. Mode 1 groups peers by this, so the
 * raw address is never stored or sent to any client.
 */
export async function hashNetworkId(ip) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`dropitover:${ip}`));
  return toHex(new Uint8Array(digest)).slice(0, 32);
}

/**
 * Per-file AES-256-GCM key: HKDF-SHA256 over the master key with a random salt
 * and the link/file pair as context. A leaked object is useless without the
 * master key, and keys never repeat across files.
 */
export async function deriveFileKey(masterKey, salt, info) {
  const base = await crypto.subtle.importKey('raw', masterKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts one part. The part index is authenticated as additional data, so
 * parts cannot be reordered, duplicated or dropped without the tag failing.
 */
export async function encryptPart(key, iv, index, plaintext) {
  const buffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`part:${index}`), tagLength: TAG_BYTES * 8 },
    key,
    plaintext
  );
  return new Uint8Array(buffer);
}

/** @throws when the ciphertext, the tag, or the part index doesn't match. */
export async function decryptPart(key, iv, index, ciphertext) {
  const buffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`part:${index}`), tagLength: TAG_BYTES * 8 },
    key,
    ciphertext
  );
  return new Uint8Array(buffer);
}

/** Constant-time-ish comparison for owner tokens. */
export function timingSafeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
