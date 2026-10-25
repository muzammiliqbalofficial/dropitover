import { hashNetworkId } from '../lib/crypto.js';

const MAX_BODY = 16 * 1024;
const CATEGORIES = ['General Support', 'Bug Report', 'Feature Request', 'Security Disclosure', 'Business & Press'];
const reply = (status, data, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

export async function handleContact(request, env) {
  if (request.method !== 'POST') return reply(405, { message: 'Use POST to submit an inquiry.' }, { allow: 'POST' });
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return reply(403, { message: 'Submit this form from DropItOver.' });
  }
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return reply(415, { message: 'Expected a JSON inquiry.' });
  }

  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) return reply(400, { message: 'Please complete the form.' });
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        return reply(413, { message: 'Your inquiry is too long. Use up to 5,000 message characters.' });
      }
      chunks.push(value);
    }
    body = JSON.parse(await new Blob(chunks).text());
  } catch {
    return reply(400, { message: 'Could not read your inquiry. Please try again.' });
  }

  const fields = { name: 100, email: 254, category: 40, subject: 200, message: 5000 };
  for (const [field, max] of Object.entries(fields)) {
    if (typeof body?.[field] !== 'string' || !body[field].trim() || body[field].trim().length > max) {
      return reply(400, { message: `Please provide a valid ${field} (up to ${max} characters).` });
    }
    body[field] = body[field].trim();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || !CATEGORIES.includes(body.category)) {
    return reply(400, { message: 'Check your email address and inquiry category.' });
  }

  const now = Date.now();
  const midnight = new Date(now).setUTCHours(0, 0, 0, 0);
  const ticketId = crypto.randomUUID();
  const ipHash = await hashNetworkId(request.headers.get('CF-Connecting-IP') || 'local-dev');
  try {
    // One SQLite statement makes the quota check and ticket insert atomic.
    const result = await env.DB.prepare(`
      INSERT INTO contact_inquiries (id, created_at, ip_hash, name, email, category, subject, message)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM contact_inquiries WHERE ip_hash = ? AND created_at >= ?) < 5
    `).bind(ticketId, now, ipHash, body.name, body.email, body.category, body.subject, body.message, ipHash, midnight).run();
    if (result.meta.changes !== 1) {
      return reply(429, { message: 'You have reached the five inquiries per day limit. Please try tomorrow.' }, {
        'retry-after': String(Math.ceil((midnight + 86400000 - now) / 1000)),
      });
    }
    return reply(201, { ok: true, ticketId });
  } catch {
    console.error('[contact] Could not store inquiry');
    return reply(503, { message: 'Your inquiry could not be saved. Please retry or email support@dropitover.com.' });
  }
}
