'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { createEncryptStream, createDecryptStream, randomId } = require('./crypto');

const META_FILE = 'meta.json';

/**
 * Mode 2 (link share) storage.
 *
 * Layout on disk, one directory per share:
 *   <storageDir>/<linkId>/meta.json   plaintext metadata + per-file crypto params
 *   <storageDir>/<linkId>/<fileId>.enc  AES-256-GCM ciphertext
 *
 * `meta.json` is the source of truth so the TTL sweeper (and a server restart
 * with the in-memory store) can still find and expire shares. The key/value
 * store is a fast index in front of it with a matching TTL.
 */
class LinkService {
  constructor({ store, storageDir, masterKey, expiryOptions, defaultExpiry, now = () => Date.now() }) {
    this.store = store;
    this.storageDir = storageDir;
    this.masterKey = masterKey;
    this.expiryOptions = expiryOptions;
    this.defaultExpiry = defaultExpiry;
    this.now = now;
  }

  /** Maps an expiry option name to seconds, falling back to the configured default. */
  resolveExpiry(option) {
    const key = this.expiryOptions[option] ? option : this.defaultExpiry;
    return { option: key, seconds: this.expiryOptions[key] };
  }

  dirFor(id) {
    return path.join(this.storageDir, id);
  }

  /** Creates the directory a share's files stream into while the upload runs. */
  async createDraft() {
    const id = randomId(10);
    const dir = this.dirFor(id);
    await fsp.mkdir(dir, { recursive: true });
    return { id, dir };
  }

  async abortDraft(draft) {
    await fsp.rm(draft.dir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Streams one uploaded file through AES-256-GCM into the draft directory.
   * @param {{id: string, dir: string}} draft
   * @param {import('stream').Readable} source
   * @param {{name: string, mime: string}} info
   */
  async storeFile(draft, source, { name, mime }) {
    const fileId = randomId(8);
    const target = path.join(draft.dir, `${fileId}.enc`);
    const { cipher, salt, iv, authTag } = createEncryptStream(this.masterKey, `${draft.id}:${fileId}`);

    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        cb(null, chunk);
      },
    });

    await pipeline(source, counter, cipher, fs.createWriteStream(target));

    return {
      id: fileId,
      name: name || 'file',
      mime: mime || 'application/octet-stream',
      size,
      salt,
      iv,
      authTag: authTag(),
      downloaded: false,
    };
  }

  /** Writes metadata and makes the share publicly resolvable. */
  async finalize(draft, { files, text, expiry, burnAfterRead }) {
    const { option, seconds } = this.resolveExpiry(expiry);
    const createdAt = this.now();
    const link = {
      id: draft.id,
      createdAt,
      expiresAt: createdAt + seconds * 1000,
      expiry: option,
      // Lets the sender revoke the share early; never included in public metadata.
      ownerToken: randomId(16),
      burnAfterRead: Boolean(burnAfterRead),
      text: text || null,
      textRead: false,
      files,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
    };

    await fsp.writeFile(path.join(draft.dir, META_FILE), JSON.stringify(link, null, 2));
    await this.store.set(`link:${link.id}`, link, seconds);
    return link;
  }

  /** @returns {Promise<object|null>} null when the share is unknown or expired. */
  async get(id) {
    if (!/^[a-z0-9]{4,32}$/.test(String(id || ''))) return null;

    let link = await this.store.get(`link:${id}`);
    if (!link) {
      link = await this.readMeta(id);
      if (link) {
        const ttl = Math.ceil((link.expiresAt - this.now()) / 1000);
        if (ttl > 0) await this.store.set(`link:${id}`, link, ttl);
      }
    }
    if (!link) return null;

    if (isExpired(link, this.now())) {
      await this.destroy(id);
      return null;
    }
    return link;
  }

  async readMeta(id) {
    try {
      const raw = await fsp.readFile(path.join(this.dirFor(id), META_FILE), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async save(link) {
    const ttl = Math.ceil((link.expiresAt - this.now()) / 1000);
    await fsp.writeFile(path.join(this.dirFor(link.id), META_FILE), JSON.stringify(link, null, 2));
    if (ttl > 0) await this.store.set(`link:${link.id}`, link, ttl);
  }

  /** Decrypted read stream for one file. Throws if the auth tag doesn't verify. */
  openFile(link, fileId) {
    const file = link.files.find((f) => f.id === fileId);
    if (!file) return null;
    const decipher = createDecryptStream(this.masterKey, `${link.id}:${file.id}`, file);
    const source = fs.createReadStream(path.join(this.dirFor(link.id), `${file.id}.enc`));
    source.on('error', (err) => decipher.destroy(err));
    return { file, stream: source.pipe(decipher) };
  }

  /**
   * Records a completed download and, for burn-after-read shares, destroys the
   * share once every file (and the note, if any) has been collected.
   */
  async markDownloaded(id, fileId) {
    const link = await this.get(id);
    if (!link) return null;
    const file = link.files.find((f) => f.id === fileId);
    if (file) file.downloaded = true;
    if (link.burnAfterRead && isFullyCollected(link)) {
      await this.destroy(id);
      return null;
    }
    await this.save(link);
    return link;
  }

  /** Called when a recipient has been shown the note attached to a share. */
  async markTextRead(id) {
    const link = await this.get(id);
    if (!link || !link.text || link.textRead) return link;
    link.textRead = true;
    if (link.burnAfterRead && isFullyCollected(link)) {
      await this.destroy(id);
      return null;
    }
    await this.save(link);
    return link;
  }

  async destroy(id) {
    await this.store.del(`link:${id}`);
    await fsp.rm(this.dirFor(id), { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Deletes every share whose expiry has passed, plus directories with no
   * readable metadata (aborted uploads) older than an hour.
   * @returns {Promise<{removed: number, scanned: number}>}
   */
  async sweep() {
    let entries;
    try {
      entries = await fsp.readdir(this.storageDir, { withFileTypes: true });
    } catch {
      return { removed: 0, scanned: 0 };
    }

    const now = this.now();
    let removed = 0;
    let scanned = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      scanned += 1;
      const link = await this.readMeta(entry.name);

      if (!link) {
        const dir = this.dirFor(entry.name);
        const stat = await fsp.stat(dir).catch(() => null);
        if (stat && now - stat.mtimeMs > 60 * 60 * 1000) {
          await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
          removed += 1;
        }
        continue;
      }

      if (isExpired(link, now)) {
        await this.destroy(link.id);
        removed += 1;
      }
    }

    return { removed, scanned };
  }
}

function isExpired(link, now = Date.now()) {
  return !link || typeof link.expiresAt !== 'number' || link.expiresAt <= now;
}

/** True once every file — and the note, if present — has been fetched at least once. */
function isFullyCollected(link) {
  const filesDone = link.files.every((f) => f.downloaded);
  const textDone = !link.text || link.textRead;
  return filesDone && textDone;
}

/** Strips secrets (crypto parameters, owner token) before sending metadata to a client. */
function publicLink(link) {
  return {
    id: link.id,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    expiry: link.expiry,
    burnAfterRead: link.burnAfterRead,
    text: link.text,
    totalSize: link.totalSize,
    files: link.files.map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
      downloaded: f.downloaded,
    })),
  };
}

module.exports = { LinkService, isExpired, isFullyCollected, publicLink, META_FILE };
