'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const { LinkService, isExpired, publicLink } = require('../server/links');
const { MemoryStore } = require('../server/store');

const EXPIRY_OPTIONS = { '1h': 3600, '6h': 21600, '24h': 86400, '3d': 259200, '7d': 604800 };
const HOUR = 3600 * 1000;

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharebeam-test-'));
  const clock = { now: Date.UTC(2026, 0, 1) };
  const store = new MemoryStore();
  const links = new LinkService({
    store,
    storageDir: dir,
    masterKey: crypto.randomBytes(32),
    expiryOptions: EXPIRY_OPTIONS,
    defaultExpiry: '24h',
    now: () => clock.now,
  });
  return { dir, clock, store, links, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function makeShare(links, { expiry, burnAfterRead = false, text = null, contents = ['hello world'] } = {}) {
  const draft = await links.createDraft();
  const files = [];
  for (const [index, body] of contents.entries()) {
    files.push(
      // eslint-disable-next-line no-await-in-loop -- storeFile writes one file at a time on purpose
      await links.storeFile(draft, Readable.from([Buffer.from(body)]), {
        name: `file-${index}.txt`,
        mime: 'text/plain',
      })
    );
  }
  return links.finalize(draft, { files, text, expiry, burnAfterRead });
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

test('resolveExpiry accepts every documented window and falls back to the default', () => {
  const { links, cleanup } = harness();
  try {
    for (const [option, seconds] of Object.entries(EXPIRY_OPTIONS)) {
      assert.deepEqual(links.resolveExpiry(option), { option, seconds });
    }
    assert.deepEqual(links.resolveExpiry(undefined), { option: '24h', seconds: 86400 });
    assert.deepEqual(links.resolveExpiry('30m'), { option: '24h', seconds: 86400 });
    assert.deepEqual(links.resolveExpiry('9999d'), { option: '24h', seconds: 86400 });
  } finally {
    cleanup();
  }
});

test('expiresAt is created + the selected window, up to 7 days', async () => {
  const { links, clock, cleanup } = harness();
  try {
    const oneHour = await makeShare(links, { expiry: '1h' });
    assert.equal(oneHour.expiresAt - clock.now, HOUR);

    const week = await makeShare(links, { expiry: '7d' });
    assert.equal(week.expiresAt - clock.now, 7 * 24 * HOUR);

    const fallback = await makeShare(links, {});
    assert.equal(fallback.expiry, '24h');
    assert.equal(fallback.expiresAt - clock.now, 24 * HOUR);
  } finally {
    cleanup();
  }
});

test('a share resolves before expiry and is gone (with its files) afterwards', async () => {
  const { links, clock, dir, cleanup } = harness();
  try {
    const share = await makeShare(links, { expiry: '1h' });
    assert.ok(await links.get(share.id));

    clock.now += 59 * 60 * 1000;
    assert.ok(await links.get(share.id), 'still valid one minute before expiry');

    clock.now += 2 * 60 * 1000;
    assert.equal(await links.get(share.id), null, 'expired');
    assert.equal(fs.existsSync(path.join(dir, share.id)), false, 'files deleted from disk');
  } finally {
    cleanup();
  }
});

test('isExpired treats the exact expiry instant as expired', () => {
  const link = { expiresAt: 1000 };
  assert.equal(isExpired(link, 999), false);
  assert.equal(isExpired(link, 1000), true);
  assert.equal(isExpired(link, 1001), true);
  assert.equal(isExpired(null, 0), true);
  assert.equal(isExpired({}, 0), true);
});

test('files are AES-encrypted on disk and decrypt back to the original bytes', async () => {
  const { links, dir, cleanup } = harness();
  try {
    const secret = 'the eagle lands at midnight';
    const share = await makeShare(links, { contents: [secret] });
    const file = share.files[0];

    const onDisk = fs.readFileSync(path.join(dir, share.id, `${file.id}.enc`));
    assert.notEqual(onDisk.toString('utf8'), secret, 'ciphertext must not contain the plaintext');
    assert.ok(file.salt && file.iv && file.authTag, 'crypto parameters recorded');

    const opened = links.openFile(share, file.id);
    assert.equal((await readStream(opened.stream)).toString('utf8'), secret);
    assert.equal(file.size, Buffer.byteLength(secret));
  } finally {
    cleanup();
  }
});

test('tampered ciphertext fails the auth tag check instead of returning data', async () => {
  const { links, dir, cleanup } = harness();
  try {
    const share = await makeShare(links, { contents: ['sensitive payload'] });
    const file = share.files[0];
    const target = path.join(dir, share.id, `${file.id}.enc`);
    const bytes = fs.readFileSync(target);
    bytes[0] ^= 0xff;
    fs.writeFileSync(target, bytes);

    const opened = links.openFile(share, file.id);
    await assert.rejects(readStream(opened.stream));
  } finally {
    cleanup();
  }
});

test('burn-after-read deletes the share only once every file is collected', async () => {
  const { links, cleanup } = harness();
  try {
    const share = await makeShare(links, { burnAfterRead: true, contents: ['a', 'b'] });

    await links.markDownloaded(share.id, share.files[0].id);
    const partial = await links.get(share.id);
    assert.ok(partial, 'still available while a second file is outstanding');
    assert.equal(partial.files[0].downloaded, true);

    await links.markDownloaded(share.id, share.files[1].id);
    assert.equal(await links.get(share.id), null, 'destroyed after the last file');
  } finally {
    cleanup();
  }
});

test('burn-after-read with a note waits for the note to be read too', async () => {
  const { links, cleanup } = harness();
  try {
    const share = await makeShare(links, { burnAfterRead: true, text: 'wifi password', contents: ['a'] });

    await links.markDownloaded(share.id, share.files[0].id);
    assert.ok(await links.get(share.id), 'note not read yet');

    await links.markTextRead(share.id);
    assert.equal(await links.get(share.id), null);
  } finally {
    cleanup();
  }
});

test('shares without the burn flag survive being downloaded', async () => {
  const { links, cleanup } = harness();
  try {
    const share = await makeShare(links, { burnAfterRead: false });
    await links.markDownloaded(share.id, share.files[0].id);
    assert.ok(await links.get(share.id));
  } finally {
    cleanup();
  }
});

test('metadata survives losing the cache, because meta.json is the source of truth', async () => {
  const { links, store, cleanup } = harness();
  try {
    const share = await makeShare(links, { expiry: '6h' });
    await store.del(`link:${share.id}`);

    const recovered = await links.get(share.id);
    assert.ok(recovered);
    assert.equal(recovered.expiresAt, share.expiresAt);
    assert.equal(recovered.files.length, 1);
  } finally {
    cleanup();
  }
});

test('sweep removes expired shares and leaves live ones alone', async () => {
  const { links, clock, dir, cleanup } = harness();
  try {
    const short = await makeShare(links, { expiry: '1h' });
    const long = await makeShare(links, { expiry: '7d' });

    assert.deepEqual(await links.sweep(), { removed: 0, scanned: 2 });

    clock.now += 2 * HOUR;
    const result = await links.sweep();
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(path.join(dir, short.id)), false);
    assert.equal(fs.existsSync(path.join(dir, long.id)), true);
  } finally {
    cleanup();
  }
});

test('public metadata never leaks the owner token or crypto parameters', async () => {
  const { links, cleanup } = harness();
  try {
    const share = await makeShare(links, { text: 'note' });
    const view = publicLink(share);
    assert.equal(view.ownerToken, undefined);
    assert.equal(view.files[0].salt, undefined);
    assert.equal(view.files[0].iv, undefined);
    assert.equal(view.files[0].authTag, undefined);
    assert.equal(view.text, 'note');
    assert.ok(share.ownerToken.length >= 12);
  } finally {
    cleanup();
  }
});
