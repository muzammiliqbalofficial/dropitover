'use strict';

const http = require('http');
const path = require('path');
const express = require('express');

const config = require('./config');
const { createStore } = require('./store');
const { LinkService } = require('./links');
const { RoomRegistry } = require('./rooms');
const { attachSignaling } = require('./signaling');
const { createApiRouter, formatBytes } = require('./routes/api');

const PUBLIC_DIR = path.resolve(config.root, 'public');

const store = createStore(config.redisUrl);

const links = new LinkService({
  store,
  storageDir: config.storageDir,
  masterKey: config.masterKey,
  expiryOptions: config.expiryOptions,
  defaultExpiry: config.defaultExpiry,
});

const rooms = new RoomRegistry({
  ttlSeconds: config.roomTtlSeconds,
  maxParticipants: config.roomMaxParticipants,
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/api', createApiRouter({ links, config, rooms }));

app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));

// Room and download pages are single files with the id read from the URL.
app.get('/r/:roomId', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'room.html')));
app.get('/d/:linkId', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'download.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, _req, res, _next) => {
  console.error('[http]', err);
  if (res.headersSent) return res.destroy();
  return res.status(500).json({ error: 'server_error', message: err.message });
});

const server = http.createServer(app);
server.requestTimeout = 0; // large uploads may legitimately take a long time
server.headersTimeout = 65_000;

attachSignaling(server, { rooms, config });

const sweeper = setInterval(async () => {
  try {
    const { removed } = await links.sweep();
    if (removed) console.log(`[cleanup] removed ${removed} expired share(s)`);
  } catch (err) {
    console.error('[cleanup] sweep failed:', err.message);
  }
}, config.cleanupIntervalMs);
sweeper.unref();

links.sweep().catch(() => {});

server.listen(config.port, config.host, () => {
  console.log(`ShareBeam listening on http://${config.host}:${config.port}`);
  console.log(`  max file size   ${formatBytes(config.maxFileSize)} (no file-count limit)`);
  console.log(`  default expiry  ${config.defaultExpiry} (options: ${Object.keys(config.expiryOptions).join(', ')})`);
  console.log(`  storage         ${config.storageDir} (AES-256-GCM at rest, Mode 2 only)`);
  console.log(`  ICE servers     ${JSON.stringify(config.iceServers.map((s) => s.urls))}`);
  if (config.iceServers.length === 1) {
    console.log('  note: no TURN configured — see README for when direct P2P needs a relay.');
  }
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down.`);
  clearInterval(sweeper);
  server.close(() => {
    Promise.resolve(store.close?.()).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, links, rooms, store };
