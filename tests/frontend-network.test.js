import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fetchJson, Emitter } from '../public/js/util.js';

test('HTTP 499, upstream failures, and fetch failures have actionable safe messages', async (t) => {
  for (const status of [499, 502]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('upstream internals', { status }));
    await assert.rejects(fetchJson('/api/config'), err => err.status === status && !/499|Request failed|internals/.test(err.message));
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(fetchJson('/api/config'), /Check your connection/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'Daily quota reached.' }), { status: 429 }));
  await assert.rejects(fetchJson('/api/links'), /Daily quota reached/);
});

test('signaling retries offline and passive failures without excluding crawler browsers', async () => {
  let source = await readFile(new URL('../public/js/ws.js', import.meta.url), 'utf8');
  source = source.replace(/import .*?;\s*/, '').replace('export class Signaling', 'globalThis.Signaling = class Signaling');
  const timers = new Map();
  let counter = 0;
  let connections = 0;
  const sockets = [];
  class Socket {
    static OPEN = 1;
    constructor() { connections++; this.handlers = {}; sockets.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    close() { this.handlers.close?.(); }
  }
  const context = vm.createContext({ Emitter, WebSocket: Socket, navigator: { onLine: false, userAgent: 'Mediapartners-Google HeadlessChrome' },
    window: { location: { protocol: 'https:', host: 'dropitover.com' } },
    setTimeout(fn) { timers.set(++counter, fn); return counter; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  const signaling = new context.Signaling('/ws/net');
  const tick = () => { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); };
  tick();
  assert.equal(connections, 0);
  assert.equal(timers.size, 1);
  context.navigator.onLine = true;
  tick();
  assert.equal(connections, 1);
  const pending = signaling.request('hello');
  sockets[0].close();
  await assert.rejects(pending, /interrupted/);
  assert.equal(signaling.queue.length, 0);
  assert.equal(timers.size, 1);
  tick();
  assert.equal(connections, 2);
  signaling.close();
  assert.equal(timers.size, 0);
});
