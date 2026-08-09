// HTTP API. Mode 2 (link shares) is the only path that moves payload bytes;
// Modes 1 and 3 use nothing here beyond /config, /rooms and /qr.

import { LinkStore, publicLink } from '../lib/links.js';
import { masterKeyFrom, readConfig } from '../lib/config.js';
import { randomId, timingSafeEqual } from '../lib/crypto.js';
import { qrSvg } from '../lib/qr.js';

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(init.headers || {}) },
  });

const fail = (status, error, message) => json({ error, message }, { status });

export async function handleApi(request, env, ctx, url) {
  const path = url.pathname.replace(/^\/api\/?/, '');
  const segments = path.split('/').filter(Boolean);
  const config = readConfig(env);

  if (segments[0] === 'health') {
    return json({ ok: true, mode: 'cloudflare-workers' });
  }

  if (segments[0] === 'config') {
    return json({
      iceServers: config.iceServers,
      hasTurn: config.hasTurn,
      maxFileSize: config.maxFileSize,
      maxTotalSize: config.maxTotalSize,
      maxTextLength: config.maxTextLength,
      partSize: config.partSize,
      expiryOptions: config.expiryOptions,
      defaultExpiry: config.defaultExpiry,
      roomMaxParticipants: config.roomMaxParticipants,
    });
  }

  if (segments[0] === 'qr') {
    const data = url.searchParams.get('data') || '';
    if (!data || data.length > 1024) return fail(400, 'invalid_qr_data', 'Nothing to encode.');
    return new Response(qrSvg(data), {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    });
  }

  if (segments[0] === 'rooms') return handleRooms(request, env, config, segments);
  if (segments[0] === 'links') return handleLinks(request, env, ctx, url, config, segments);

  return fail(404, 'not_found', 'No such endpoint.');
}

// --- Mode 3: room records ---------------------------------------------------

async function handleRooms(request, env, config, segments) {
  if (segments.length === 1 && request.method === 'POST') {
    const roomId = randomId(8);
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const created = await stub.fetch('https://room/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: roomId,
        ttlSeconds: config.roomTtlSeconds,
        maxParticipants: config.roomMaxParticipants,
      }),
    });
    const meta = await created.json();
    return json({ ok: true, roomId, expiresAt: meta.expiresAt }, { status: 201 });
  }

  if (segments.length === 2 && request.method === 'GET') {
    const roomId = segments[1];
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const info = await stub.fetch('https://room/info');
    return new Response(info.body, {
      status: info.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  return fail(405, 'method_not_allowed');
}

// --- Mode 2: link shares ----------------------------------------------------

async function handleLinks(request, env, ctx, url, config, segments) {
  const store = new LinkStore(env, config, masterKeyFrom(env));

  // POST /api/links — reserve a share and plan its parts
  if (segments.length === 1 && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'invalid_body', 'Expected a JSON manifest.');
    }

    const files = Array.isArray(body.files) ? body.files : [];
    const text = typeof body.text === 'string' ? body.text.trim() : '';

    if (!files.length && !text) return fail(400, 'empty_share', 'Add at least one file or some text.');
    if (text.length > config.maxTextLength) {
      return fail(413, 'text_too_long', `Notes are limited to ${config.maxTextLength} characters.`);
    }

    let total = 0;
    for (const file of files) {
      const size = Number(file.size);
      if (!Number.isFinite(size) || size < 0) return fail(400, 'invalid_file', 'Every file needs a valid size.');
      if (size > config.maxFileSize) {
        return fail(413, 'file_too_large', `Each file must be ${config.maxFileSize} bytes or smaller.`);
      }
      total += size;
    }
    if (total > config.maxTotalSize) {
      return fail(413, 'share_too_large', `A single share is limited to ${config.maxTotalSize} bytes.`);
    }

    const created = await store.create({
      files,
      text: text || null,
      expiry: body.expiry,
      burnAfterRead: Boolean(body.burnAfterRead),
    });
    return json(created, { status: 201 });
  }

  const linkId = segments[1];
  if (!linkId) return fail(404, 'not_found');

  // PUT /api/links/:id/files/:fileId/parts/:index — one encrypted chunk
  if (segments[2] === 'files' && segments[4] === 'parts' && request.method === 'PUT') {
    const link = await store.linkRow(linkId);
    if (!link) return fail(404, 'link_not_found', 'This share no longer exists.');
    if (!timingSafeEqual(request.headers.get('x-owner-token'), link.owner_token)) {
      return fail(403, 'forbidden', 'Wrong upload token.');
    }
    if (link.status !== 'pending') return fail(409, 'already_finalized', 'This share is already sealed.');

    const index = Number.parseInt(segments[5], 10);
    if (!Number.isInteger(index) || index < 0) return fail(400, 'bad_part_index');

    const bytes = new Uint8Array(await request.arrayBuffer());
    const result = await store.uploadPart(linkId, segments[3], index, bytes);
    if (!result.ok) return fail(result.error === 'file_not_found' ? 404 : 400, result.error, partErrorMessage(result));
    return json(result);
  }

  // POST /api/links/:id/finalize — seal the share and hand back the link + QR
  if (segments[2] === 'finalize' && request.method === 'POST') {
    const link = await store.linkRow(linkId);
    if (!link) return fail(404, 'link_not_found', 'This share no longer exists.');
    if (!timingSafeEqual(request.headers.get('x-owner-token'), link.owner_token)) {
      return fail(403, 'forbidden', 'Wrong upload token.');
    }

    const result = await store.finalize(linkId);
    if (!result.ok) return fail(409, result.error, 'Some parts never finished uploading.');

    const shareUrl = `${url.origin}/d/${linkId}`;
    return json({
      ...publicLink(result.record),
      url: shareUrl,
      qrUrl: `/api/qr?data=${encodeURIComponent(shareUrl)}`,
    });
  }

  // DELETE /api/links/:id — sender-initiated revoke
  if (segments.length === 2 && request.method === 'DELETE') {
    const link = await store.linkRow(linkId);
    if (!link) return fail(404, 'link_not_found');
    if (!timingSafeEqual(request.headers.get('x-owner-token'), link.owner_token)) {
      return fail(403, 'forbidden');
    }
    await store.destroy(linkId);
    return json({ ok: true });
  }

  const record = await store.get(linkId);
  if (!record) {
    return fail(410, 'link_expired', 'This link has expired or was already used up.');
  }

  // GET /api/links/:id — metadata for the recipient page
  if (segments.length === 2 && request.method === 'GET') {
    const body = publicLink(record);
    if (record.burnAfterRead && record.text && !record.textRead) {
      ctx.waitUntil(store.markTextRead(linkId));
    }
    return json(body);
  }

  // GET /api/links/:id/files/:fileId — decrypted download stream
  if (segments[2] === 'files' && segments.length === 4 && request.method === 'GET') {
    const fileId = segments[3];
    const opened = await store.openFile(record, fileId, {
      onComplete: () => ctx.waitUntil(store.markDownloaded(linkId, fileId)),
    });
    if (!opened) return fail(404, 'file_not_found', 'No such file in this share.');

    const headers = {
      'content-type': opened.file.mime || 'application/octet-stream',
      'content-disposition': contentDisposition(opened.file.name),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };

    // A streamed body normally goes out chunked, which costs the recipient their
    // progress bar. FixedLengthStream declares the plaintext length up front.
    if (typeof FixedLengthStream === 'function') {
      const sized = new FixedLengthStream(opened.file.size);
      opened.stream.pipeTo(sized.writable).catch((err) => console.error('[download]', err.message));
      return new Response(sized.readable, { headers });
    }

    return new Response(opened.stream, { headers: { ...headers, 'content-length': String(opened.file.size) } });
  }

  return fail(404, 'not_found');
}

function partErrorMessage(result) {
  if (result.error === 'bad_part_size') {
    return `This chunk should be ${result.expected} bytes but ${result.received} arrived.`;
  }
  if (result.error === 'bad_part_index') return 'That chunk is outside the planned range.';
  return 'The chunk could not be stored.';
}

function contentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
