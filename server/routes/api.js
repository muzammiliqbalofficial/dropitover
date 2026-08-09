'use strict';

const express = require('express');
const Busboy = require('busboy');
const QRCode = require('qrcode');

const { publicLink } = require('../links');

/**
 * HTTP API. Only Mode 2 (link sharing) moves payload bytes through here —
 * uploads are streamed straight into AES-256-GCM ciphertext on disk and are
 * decrypted on the way out. Modes 1 and 3 use nothing on this router beyond
 * /config and /qr.
 */
function createApiRouter({ links, config, rooms }) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size });
  });

  router.get('/config', (_req, res) => {
    res.json({
      iceServers: config.iceServers,
      maxFileSize: config.maxFileSize,
      maxTotalSize: config.maxTotalSize,
      maxTextLength: config.maxTextLength,
      expiryOptions: Object.keys(config.expiryOptions),
      defaultExpiry: config.defaultExpiry,
      roomTtlSeconds: config.roomTtlSeconds,
      roomMaxParticipants: config.roomMaxParticipants,
      hasTurn: config.iceServers.length > 1,
    });
  });

  // --- Mode 2: create a share ----------------------------------------------
  router.post('/links', async (req, res) => {
    if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) {
      return res.status(400).json({ error: 'expected_multipart', message: 'Send the share as multipart/form-data.' });
    }

    const draft = await links.createDraft();
    const files = [];
    const fields = Object.create(null);
    const pending = [];
    let totalSize = 0;
    let failure = null;
    let responded = false;

    const fail = (status, error, message) => {
      if (!failure) failure = { status, error, message };
    };

    const busboy = Busboy({
      headers: req.headers,
      limits: {
        fileSize: config.maxFileSize,
        files: 10_000, // effectively uncapped; guards against a runaway client
        fields: 20,
        fieldSize: config.maxTextLength + 1024,
      },
    });

    const finish = async () => {
      if (responded) return;
      responded = true;
      await Promise.allSettled(pending);

      const text = typeof fields.text === 'string' ? fields.text.trim() : '';
      if (!failure && text.length > config.maxTextLength) {
        fail(413, 'text_too_long', `Notes are limited to ${config.maxTextLength} characters.`);
      }
      if (!failure && files.length === 0 && !text) {
        fail(400, 'empty_share', 'Add at least one file or some text.');
      }

      if (failure) {
        await links.abortDraft(draft);
        return res.status(failure.status).json({ error: failure.error, message: failure.message });
      }

      const link = await links.finalize(draft, {
        files,
        text: text || null,
        expiry: fields.expiry,
        burnAfterRead: fields.burnAfterRead === 'true' || fields.burnAfterRead === '1',
      });

      const url = `${originOf(req, config)}/d/${link.id}`;
      return res.status(201).json({
        ...publicLink(link),
        url,
        ownerToken: link.ownerToken,
        qr: await QRCode.toDataURL(url, { margin: 1, width: 320 }),
      });
    };

    busboy.on('file', (_field, stream, info) => {
      if (failure) {
        stream.resume();
        return;
      }
      let truncated = false;
      stream.on('limit', () => {
        truncated = true;
        fail(413, 'file_too_large', `Each file must be ${formatBytes(config.maxFileSize)} or smaller.`);
      });

      pending.push(
        links
          .storeFile(draft, stream, { name: info.filename, mime: info.mimeType })
          .then((record) => {
            if (truncated || failure) return;
            totalSize += record.size;
            if (totalSize > config.maxTotalSize) {
              fail(413, 'share_too_large', `A single share is limited to ${formatBytes(config.maxTotalSize)}.`);
              return;
            }
            files.push(record);
          })
          .catch((err) => fail(500, 'upload_failed', err.message))
      );
    });

    busboy.on('field', (name, value, info) => {
      if (info?.valueTruncated) {
        fail(413, 'text_too_long', `Notes are limited to ${config.maxTextLength} characters.`);
        return;
      }
      fields[name] = value;
    });

    busboy.on('error', (err) => {
      fail(400, 'upload_failed', err.message);
      finish().catch(() => {});
    });

    busboy.on('close', () => {
      finish().catch((err) => {
        if (!res.headersSent) res.status(500).json({ error: 'upload_failed', message: err.message });
      });
    });

    req.on('aborted', async () => {
      responded = true;
      await Promise.allSettled(pending);
      await links.abortDraft(draft);
    });

    req.pipe(busboy);
    return undefined;
  });

  // --- Mode 2: read a share -------------------------------------------------
  router.get('/links/:id', async (req, res) => {
    const link = await links.get(req.params.id);
    if (!link) {
      return res.status(410).json({ error: 'link_expired', message: 'This link has expired or was already used up.' });
    }

    const body = publicLink(link);
    res.json(body);

    // Reading the note counts as collecting it for burn-after-read shares.
    if (link.burnAfterRead && link.text) {
      links.markTextRead(link.id).catch(() => {});
    }
    return undefined;
  });

  router.get('/links/:id/files/:fileId', async (req, res) => {
    const link = await links.get(req.params.id);
    if (!link) {
      return res.status(410).json({ error: 'link_expired', message: 'This link has expired or was already used up.' });
    }

    const opened = links.openFile(link, req.params.fileId);
    if (!opened) return res.status(404).json({ error: 'file_not_found', message: 'No such file in this share.' });

    res.setHeader('Content-Type', opened.file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', opened.file.size);
    res.setHeader('Content-Disposition', contentDisposition(opened.file.name));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    opened.stream.on('error', (err) => {
      console.error('[links] decrypt failed for', link.id, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'decrypt_failed' });
      else res.destroy(err);
    });

    res.on('close', () => opened.stream.destroy());
    res.on('finish', () => {
      links.markDownloaded(link.id, opened.file.id).catch(() => {});
    });

    opened.stream.pipe(res);
    return undefined;
  });

  router.delete('/links/:id', async (req, res) => {
    const link = await links.get(req.params.id);
    if (!link) return res.status(404).json({ error: 'link_not_found' });

    const token = req.get('x-owner-token') || req.query.token;
    if (!token || token !== link.ownerToken) return res.status(403).json({ error: 'forbidden' });

    await links.destroy(link.id);
    return res.json({ ok: true });
  });

  // --- Shared helpers -------------------------------------------------------
  router.get('/qr', async (req, res) => {
    const data = String(req.query.data || '');
    if (!data || data.length > 1024) return res.status(400).json({ error: 'invalid_qr_data' });

    try {
      const png = await QRCode.toBuffer(data, { type: 'png', margin: 1, width: 320 });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(png);
    } catch (err) {
      return res.status(500).json({ error: 'qr_failed', message: err.message });
    }
  });

  router.get('/rooms/:id', (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'room_not_found', message: 'This room no longer exists.' });
    return res.json({
      id: room.id,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      participants: room.participants.length,
      maxParticipants: rooms.maxParticipants,
    });
  });

  return router;
}

function originOf(req, config) {
  if (config.publicUrl) return config.publicUrl;
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function contentDisposition(name) {
  const fallback = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

module.exports = { createApiRouter, originOf, formatBytes };
