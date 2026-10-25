import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../src/routes/api.js';
import worker from '../src/index.js';
import { LinkStore } from '../src/lib/links.js';
import { UsageTracker } from '../src/lib/limits.js';

const valid = { name: 'Example User', email: 'user@example.com', category: 'Bug Report', subject: 'Transfer stopped', message: 'A harmless reproduction.' };
function request(body = valid, options = {}) {
  return new Request('https://dropitover.com/api/contact', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://dropitover.com' },
    body: JSON.stringify(body), ...options,
  });
}
const handle = (req, env = {}) => handleApi(req, env, {}, new URL(req.url));

test('contact validates input, origin, method, and streamed body size before touching storage', async () => {
  for (const [req, status] of [
    [request(null), 400], [request({ ...valid, email: 'not-an-email' }), 400],
    [request({ ...valid, category: 'unknown' }), 400], [request({ ...valid, message: ' ' }), 400],
    [request({ ...valid, subject: 'x'.repeat(201) }), 400],
    [request(valid, { headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }), 403],
    [request(valid, { headers: { 'content-type': 'text/plain' } }), 415],
    [request(valid, { body: '{broken' }), 400],
    [request({ ...valid, message: 'x'.repeat(17000) }), 413],
    [new Request('https://dropitover.com/api/contact'), 405],
  ]) assert.equal((await handle(req)).status, status);
});

test('contact confirms only a persisted, parameterized ticket and keeps IPs out of storage', async () => {
  let values;
  const DB = { prepare(sql) {
    assert.match(sql, /INSERT INTO contact_inquiries[\s\S]*SELECT[\s\S]*COUNT\(\*\)/);
    return { bind(...args) { values = args; return { async run() { return { meta: { changes: 1 } }; } }; } };
  } };
  const res = await handle(request({ ...valid, name: '  Example User  ' }, {
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.123' },
  }), { DB });
  assert.equal(res.status, 201);
  const ticket = await res.json();
  assert.equal(ticket.ok, true);
  assert.match(ticket.ticketId, /^[0-9a-f-]{36}$/);
  assert.equal(values[0], ticket.ticketId);
  assert.equal(values[3], valid.name);
  assert.ok(!values.includes('192.0.2.123'));
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('quota returns 429 with retry timing; storage failure never claims success', async () => {
  const limited = { DB: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }) } };
  const res = await handle(request(), limited);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  const failed = await handle(request(), {});
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('ticketId'));
});

test('scheduled cleanup includes support records older than 90 days', async (t) => {
  t.mock.method(LinkStore.prototype, 'sweep', async () => ({ expired: 0, abandoned: 0 }));
  t.mock.method(UsageTracker.prototype, 'sweep', async () => 0);
  let cutoff;
  let pending;
  const before = Date.now() - 90 * 86400000;
  const DB = { prepare(sql) {
    assert.equal(sql, 'DELETE FROM contact_inquiries WHERE created_at < ?');
    return { bind(value) { cutoff = value; return { async run() { return { success: true }; } }; } };
  } };
  await worker.scheduled({}, { DB, MASTER_KEY: '00'.repeat(32) }, { waitUntil(promise) { pending = promise; } });
  await pending;
  assert.ok(cutoff >= before && cutoff <= Date.now() - 90 * 86400000);
});
