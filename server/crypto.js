'use strict';

const crypto = require('crypto');

/**
 * AES-256-GCM encryption for Mode 2 files at rest.
 *
 * Every file gets its own key, derived from the master key with HKDF-SHA256 and
 * a random 16-byte salt, plus a random 12-byte IV. Salt, IV and the GCM auth tag
 * are stored in the share's metadata — never inside the ciphertext file — so a
 * stolen blob is useless on its own and tampering is detected on read.
 */

const ALGORITHM = 'aes-256-gcm';
const SALT_BYTES = 16;
const IV_BYTES = 12;

function deriveKey(masterKey, salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, Buffer.from(info, 'utf8'), 32));
}

/**
 * @returns {{cipher: import('crypto').CipherGCM, salt: string, iv: string, authTag: () => string}}
 */
function createEncryptStream(masterKey, info) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(masterKey, salt, info), iv);

  return {
    cipher,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: () => cipher.getAuthTag().toString('hex'),
  };
}

/**
 * @returns {import('crypto').DecipherGCM} throws on the final chunk if the
 * ciphertext or the auth tag was tampered with.
 */
function createDecryptStream(masterKey, info, { salt, iv, authTag }) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    deriveKey(masterKey, Buffer.from(salt, 'hex'), info),
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  return decipher;
}

/** URL-safe random id (base32-ish alphabet, no look-alike characters). */
function randomId(length = 12) {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Stable, non-reversible identifier for a public IP (used to group Mode 1 peers). */
function networkIdFor(ip) {
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
}

module.exports = { createEncryptStream, createDecryptStream, randomId, networkIdFor, ALGORITHM };
