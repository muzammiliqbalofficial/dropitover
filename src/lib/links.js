// Mode 2 storage: metadata in D1, AES-256-GCM ciphertext in R2.
//
// Files arrive from the browser in fixed-size parts (PART_SIZE). Each part is
// encrypted inside the Worker with its own IV and the part index as additional
// authenticated data, then written to R2 — as a single object for small files,
// or as one R2 multipart upload part for larger ones. That keeps every request
// far below the Workers body limit while still supporting multi-GB files.

import {
  TAG_BYTES, decryptPart, deriveFileKey, encryptPart, fromHex, randomId, randomIv, randomSalt, toHex,
} from './crypto.js';
import { cipherRangeFor, expiresAtFor, isExpired, isFullyCollected, planParts, resolveExpiry } from './expiry.js';

const r2KeyFor = (linkId, fileId) => `links/${linkId}/${fileId}`;

export class LinkStore {
  /**
   * @param {{DB: D1Database, BUCKET: R2Bucket}} env
   * @param {object} config
   * @param {Uint8Array} masterKey
   */
  constructor(env, config, masterKey) {
    this.db = env.DB;
    this.bucket = env.BUCKET;
    this.config = config;
    this.masterKey = masterKey;
  }

  now() {
    return Date.now();
  }

  /**
   * Reserves a share and plans every file's parts. Nothing is readable until
   * `finalize()` flips the status to ready.
   */
  async create({ files = [], text = null, expiry, burnAfterRead = false }) {
    const now = this.now();
    const { option } = resolveExpiry(expiry, this.config.defaultExpiry);
    const id = randomId(10);
    const ownerToken = randomId(24);
    const { partSize } = this.config;

    const planned = [];
    for (const file of files) {
      const size = Number(file.size) || 0;
      const { partCount } = planParts(size, partSize);
      const fileId = randomId(8);
      const ivs = Array.from({ length: partCount }, () => toHex(randomIv()));
      const key = r2KeyFor(id, fileId);

      // Multi-part files stream into an R2 multipart upload; single-part files
      // are written with a plain put when their only part arrives.
      const uploadId = partCount > 1 ? (await this.bucket.createMultipartUpload(key)).uploadId : null;

      planned.push({
        id: fileId,
        name: String(file.name || 'file').slice(0, 255),
        mime: String(file.mime || 'application/octet-stream').slice(0, 128),
        size,
        partSize,
        partCount,
        ivs,
        r2Key: key,
        uploadId,
      });
    }

    const statements = [
      this.db
        .prepare(
          `INSERT INTO links (id, owner_token, created_at, expires_at, expiry, burn_after_read, text, status, total_size)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        )
        .bind(
          id,
          ownerToken,
          now,
          expiresAtFor(now, option, this.config.defaultExpiry),
          option,
          burnAfterRead ? 1 : 0,
          text || null,
          planned.reduce((sum, f) => sum + f.size, 0)
        ),
      ...planned.map((f) =>
        this.db
          .prepare(
            `INSERT INTO files (link_id, id, name, mime, size, part_size, part_count, salt, ivs, r2_key, upload_id, etags)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`
          )
          .bind(
            id,
            f.id,
            f.name,
            f.mime,
            f.size,
            f.partSize,
            f.partCount,
            toHex(randomSalt()),
            JSON.stringify(f.ivs),
            f.r2Key,
            f.uploadId
          )
      ),
    ];

    await this.db.batch(statements);

    return {
      id,
      ownerToken,
      partSize,
      expiry: option,
      files: planned.map((f) => ({ id: f.id, name: f.name, size: f.size, partCount: f.partCount })),
    };
  }

  /**
   * Encrypts and stores one part.
   * @param {Uint8Array} bytes plaintext for this part
   */
  async uploadPart(linkId, fileId, index, bytes) {
    const file = await this.fileRow(linkId, fileId);
    if (!file) return { ok: false, error: 'file_not_found' };
    if (index < 0 || index >= file.part_count) return { ok: false, error: 'bad_part_index' };

    const { plainLength } = cipherRangeFor(index, { size: file.size, partSize: file.part_size });
    if (bytes.length !== plainLength) {
      return { ok: false, error: 'bad_part_size', expected: plainLength, received: bytes.length };
    }

    const ivs = JSON.parse(file.ivs);
    const key = await deriveFileKey(this.masterKey, fromHex(file.salt), `${linkId}:${fileId}`);
    const ciphertext = await encryptPart(key, fromHex(ivs[index]), index, bytes);

    if (file.part_count === 1) {
      await this.bucket.put(file.r2_key, ciphertext);
      await this.db
        .prepare('UPDATE files SET uploaded_parts = 1 WHERE link_id = ? AND id = ?')
        .bind(linkId, fileId)
        .run();
      return { ok: true, uploadedParts: 1, complete: true };
    }

    const upload = this.bucket.resumeMultipartUpload(file.r2_key, file.upload_id);
    const uploaded = await upload.uploadPart(index + 1, ciphertext);

    // Parts are uploaded one at a time per file, so this read-modify-write of
    // the etag list has no concurrent writer.
    const etags = JSON.parse(file.etags);
    const known = etags.filter((e) => e.partNumber !== uploaded.partNumber);
    known.push({ partNumber: uploaded.partNumber, etag: uploaded.etag });
    known.sort((a, b) => a.partNumber - b.partNumber);

    await this.db
      .prepare('UPDATE files SET etags = ?, uploaded_parts = ? WHERE link_id = ? AND id = ?')
      .bind(JSON.stringify(known), known.length, linkId, fileId)
      .run();

    if (known.length === file.part_count) {
      await upload.complete(known);
      return { ok: true, uploadedParts: known.length, complete: true };
    }
    return { ok: true, uploadedParts: known.length, complete: false };
  }

  /** Flips the share to ready and starts its expiry clock. */
  async finalize(linkId) {
    const link = await this.db.prepare('SELECT * FROM links WHERE id = ?').bind(linkId).first();
    if (!link) return { ok: false, error: 'link_not_found' };

    const files = await this.fileRows(linkId);
    const missing = files.filter((f) => f.uploaded_parts < f.part_count);
    if (missing.length) return { ok: false, error: 'upload_incomplete', missing: missing.map((f) => f.id) };

    const now = this.now();
    const expiresAt = expiresAtFor(now, link.expiry, this.config.defaultExpiry);
    await this.db
      .prepare("UPDATE links SET status = 'ready', expires_at = ? WHERE id = ?")
      .bind(expiresAt, linkId)
      .run();

    return { ok: true, record: await this.get(linkId, { includePending: true }) };
  }

  async linkRow(id) {
    if (!/^[a-z0-9]{4,32}$/.test(String(id || ''))) return null;
    return this.db.prepare('SELECT * FROM links WHERE id = ?').bind(id).first();
  }

  async fileRow(linkId, fileId) {
    return this.db.prepare('SELECT * FROM files WHERE link_id = ? AND id = ?').bind(linkId, fileId).first();
  }

  async fileRows(linkId) {
    const { results } = await this.db
      .prepare('SELECT * FROM files WHERE link_id = ? ORDER BY rowid')
      .bind(linkId)
      .all();
    return results || [];
  }

  /** @returns {Promise<object|null>} null when unknown, unfinished or expired. */
  async get(id, { includePending = false } = {}) {
    const link = await this.linkRow(id);
    if (!link) return null;
    if (!includePending && link.status !== 'ready') return null;

    const record = toRecord(link, await this.fileRows(id));
    if (isExpired(record, this.now())) {
      await this.destroy(id);
      return null;
    }
    return record;
  }

  /**
   * Decrypted read stream for one file: ranged reads from R2, one part decrypted
   * at a time, so memory stays flat regardless of file size.
   */
  async openFile(record, fileId, { onComplete } = {}) {
    const file = record.files.find((f) => f.id === fileId);
    if (!file) return null;

    const key = await deriveFileKey(this.masterKey, fromHex(file.salt), `${record.id}:${fileId}`);
    const ivs = file.ivs.map(fromHex);
    const bucket = this.bucket;
    let index = 0;

    const stream = new ReadableStream({
      async pull(controller) {
        if (index >= file.partCount) {
          controller.close();
          // Burn-after-read deletion has to wait for the last byte, otherwise
          // the object would vanish mid-download.
          if (onComplete) onComplete();
          return;
        }
        const range = cipherRangeFor(index, { size: file.size, partSize: file.partSize, tagBytes: TAG_BYTES });
        const object = await bucket.get(file.r2Key, { range: { offset: range.offset, length: range.length } });
        if (!object) {
          controller.error(new Error('stored object is missing'));
          return;
        }
        const ciphertext = new Uint8Array(await object.arrayBuffer());
        controller.enqueue(await decryptPart(key, ivs[index], index, ciphertext));
        index += 1;
      },
    });

    return { file, stream };
  }

  /** Records a completed download; destroys burn-after-read shares when done. */
  async markDownloaded(linkId, fileId) {
    await this.db
      .prepare('UPDATE files SET downloaded = 1 WHERE link_id = ? AND id = ?')
      .bind(linkId, fileId)
      .run();
    return this.burnIfCollected(linkId);
  }

  async markTextRead(linkId) {
    await this.db.prepare('UPDATE links SET text_read = 1 WHERE id = ?').bind(linkId).run();
    return this.burnIfCollected(linkId);
  }

  async burnIfCollected(linkId) {
    const link = await this.linkRow(linkId);
    if (!link || !link.burn_after_read) return false;

    const record = toRecord(link, await this.fileRows(linkId));
    if (!isFullyCollected(record)) return false;

    await this.destroy(linkId);
    return true;
  }

  async destroy(id) {
    const files = await this.fileRows(id);

    for (const file of files) {
      if (file.upload_id && file.uploaded_parts < file.part_count) {
        // Never completed — drop the dangling multipart upload.
        await this.bucket.resumeMultipartUpload(file.r2_key, file.upload_id).abort().catch(() => {});
      }
    }
    if (files.length) {
      await this.bucket.delete(files.map((f) => f.r2_key)).catch(() => {});
    }

    await this.db.batch([
      this.db.prepare('DELETE FROM files WHERE link_id = ?').bind(id),
      this.db.prepare('DELETE FROM links WHERE id = ?').bind(id),
    ]);
  }

  /**
   * Cron sweep: deletes expired shares and abandoned uploads.
   * @returns {Promise<{expired: number, abandoned: number}>}
   */
  async sweep({ limit = 50, abandonedAfterMs = 60 * 60 * 1000 } = {}) {
    const now = this.now();

    const expired = await this.db
      .prepare('SELECT id FROM links WHERE expires_at <= ? LIMIT ?')
      .bind(now, limit)
      .all();

    const abandoned = await this.db
      .prepare("SELECT id FROM links WHERE status = 'pending' AND created_at < ? LIMIT ?")
      .bind(now - abandonedAfterMs, limit)
      .all();

    const ids = new Set([...(expired.results || []), ...(abandoned.results || [])].map((r) => r.id));
    for (const id of ids) await this.destroy(id);

    return { expired: (expired.results || []).length, abandoned: (abandoned.results || []).length };
  }
}

function toRecord(link, fileRows) {
  return {
    id: link.id,
    ownerToken: link.owner_token,
    createdAt: link.created_at,
    expiresAt: link.expires_at,
    expiry: link.expiry,
    burnAfterRead: Boolean(link.burn_after_read),
    text: link.text,
    textRead: Boolean(link.text_read),
    status: link.status,
    totalSize: link.total_size,
    files: fileRows.map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
      partSize: f.part_size,
      partCount: f.part_count,
      salt: f.salt,
      ivs: JSON.parse(f.ivs),
      r2Key: f.r2_key,
      uploadedParts: f.uploaded_parts,
      downloaded: Boolean(f.downloaded),
    })),
  };
}

/** Strips secrets before metadata goes to a client. */
export function publicLink(record) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    expiry: record.expiry,
    burnAfterRead: record.burnAfterRead,
    text: record.text,
    totalSize: record.totalSize,
    files: record.files.map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
      downloaded: f.downloaded,
    })),
  };
}
