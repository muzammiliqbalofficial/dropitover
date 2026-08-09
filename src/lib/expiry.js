// Pure expiry + chunking logic. No Cloudflare bindings here, so the same code
// runs under `node --test`.

/** Selectable expiry windows, in seconds. */
export const EXPIRY_OPTIONS = Object.freeze({
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '24h': 24 * 60 * 60,
  '3d': 3 * 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
});

export const DEFAULT_EXPIRY = '24h';

/** Maps an expiry option to seconds, falling back to the configured default. */
export function resolveExpiry(option, fallback = DEFAULT_EXPIRY) {
  const safeFallback = EXPIRY_OPTIONS[fallback] ? fallback : DEFAULT_EXPIRY;
  const key = EXPIRY_OPTIONS[option] ? option : safeFallback;
  return { option: key, seconds: EXPIRY_OPTIONS[key] };
}

export function expiresAtFor(now, option, fallback = DEFAULT_EXPIRY) {
  const { seconds } = resolveExpiry(option, fallback);
  return now + seconds * 1000;
}

/** The expiry instant itself counts as expired. */
export function isExpired(record, now = Date.now()) {
  if (!record || typeof record.expiresAt !== 'number') return true;
  return record.expiresAt <= now;
}

/**
 * True once every file — and the note, if there is one — has been collected.
 * Burn-after-read shares are destroyed at that point, not before, so a
 * multi-file share isn't lost after the first click.
 */
export function isFullyCollected({ files = [], text = null, textRead = false }) {
  return files.every((f) => f.downloaded) && (!text || textRead);
}

/**
 * Splits a file into equal encryption/upload parts (the last one is the
 * remainder). R2 multipart requires every part but the last to be identical in
 * size and at least 5 MiB.
 */
export function planParts(size, partSize) {
  if (!Number.isFinite(size) || size < 0) throw new RangeError('size must be a non-negative number');
  if (!Number.isFinite(partSize) || partSize <= 0) throw new RangeError('partSize must be positive');

  const partCount = Math.max(1, Math.ceil(size / partSize));
  const parts = [];
  for (let index = 0; index < partCount; index += 1) {
    const offset = index * partSize;
    parts.push({ index, offset, length: Math.min(partSize, Math.max(0, size - offset)) });
  }
  return { partCount, partSize, parts };
}

/**
 * Byte range of one encrypted part inside the stored object. Each part carries
 * its own 16-byte GCM tag, so ciphertext offsets drift from plaintext offsets.
 */
export function cipherRangeFor(index, { size, partSize, tagBytes = 16 }) {
  const plainOffset = index * partSize;
  if (plainOffset > size) throw new RangeError('part index out of range');
  const plainLength = Math.min(partSize, size - plainOffset);
  return {
    offset: plainOffset + index * tagBytes,
    length: plainLength + tagBytes,
    plainLength,
  };
}

/** Total size of the stored ciphertext for a file of `size` bytes. */
export function cipherSizeFor(size, partSize, tagBytes = 16) {
  const { partCount } = planParts(size, partSize);
  return size + partCount * tagBytes;
}
