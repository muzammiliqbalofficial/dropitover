// Mode 2 upload client.
//
// Files are cut into fixed-size parts and PUT one at a time. The Worker
// encrypts each part with AES-256-GCM before it touches R2, so a single request
// never exceeds the Workers body limit and a 2 GB file is just 256 chunks.

import { fetchJson } from './util.js';

const MAX_ATTEMPTS = 3;

/**
 * @param {{files: File[], text: string, expiry: string, burnAfterRead: boolean,
 *          onProgress?: (p: {sent: number, total: number, label: string}) => void}} options
 * @returns {Promise<object>} the finalized share (url, qrUrl, expiresAt, ownerToken…)
 */
export async function uploadShare({ files, text, expiry, burnAfterRead, onProgress = () => {} }) {
  const manifest = await fetchJson('/api/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      files: files.map((file) => ({ name: file.name, size: file.size, mime: file.type })),
      text: text || '',
      expiry,
      burnAfterRead,
    }),
  });

  const { id, ownerToken, partSize } = manifest;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;

  for (const [fileIndex, file] of files.entries()) {
    const planned = manifest.files[fileIndex];

    for (let part = 0; part < planned.partCount; part += 1) {
      const start = part * partSize;
      const chunk = file.slice(start, Math.min(start + partSize, file.size));
      const url = `/api/links/${id}/files/${planned.id}/parts/${part}`;

      await withRetry(() =>
        putPart(url, ownerToken, chunk, (loaded) => {
          onProgress({ sent: completed + loaded, total, label: file.name });
        })
      );

      completed += chunk.size;
      onProgress({ sent: completed, total, label: file.name });
    }
  }

  const share = await fetchJson(`/api/links/${id}/finalize`, {
    method: 'POST',
    headers: { 'x-owner-token': ownerToken },
  });

  return { ...share, ownerToken };
}

function putPart(url, ownerToken, blob, onChunkProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('x-owner-token', ownerToken);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onChunkProgress(event.loaded);
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(safeJson(xhr.responseText));
        return;
      }
      const body = safeJson(xhr.responseText);
      const error = new Error(body.message || `Upload failed (${xhr.status})`);
      error.status = xhr.status;
      reject(error);
    });

    xhr.addEventListener('error', () => reject(new Error('Lost connection while sending.')));
    xhr.addEventListener('abort', () => reject(new Error('Sending cancelled.')));
    xhr.send(blob);
  });
}

/** Retries transient failures; a 4xx from the Worker is final. */
async function withRetry(task) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      if (attempt < MAX_ATTEMPTS) await sleep(400 * attempt);
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
