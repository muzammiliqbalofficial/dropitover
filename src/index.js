// DropItOver on Cloudflare Workers.
//
//   /                     static assets (served before this Worker runs)
//   /r/<roomId>           room page          -> public/room.html
//   /d/<linkId>           recipient page     -> public/download.html
//   /api/*                HTTP API           -> src/routes/api.js
//   /ws/net               Mode 1 signaling   -> NetworkHub Durable Object
//   /ws/room/<roomId>     Mode 3 signaling   -> Room Durable Object
//
// Modes 1 and 3 never store anything: the Durable Objects relay SDP/ICE and the
// browsers move the bytes themselves. Mode 2 is the only path that persists, and
// it encrypts every chunk with AES-256-GCM before it reaches R2.

import { NetworkHub } from './do/network-hub.js';
import { Room } from './do/room.js';
import { handleApi } from './routes/api.js';
import { canonicalRedirect, isCanonicalHost } from './lib/canonical.js';
import { hashNetworkId } from './lib/crypto.js';
import { LinkStore } from './lib/links.js';
import { UsageTracker } from './lib/limits.js';
import { masterKeyFrom, readConfig } from './lib/config.js';

export { NetworkHub, Room };

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // http -> https and www -> apex, before anything else runs. Plain http is
    // not a secure context, so the peer-to-peer modes cannot work there.
    const redirect = canonicalRedirect(request.url, env.CANONICAL_HOST);
    if (redirect) return Response.redirect(redirect, 301);

    try {
      if (url.pathname === '/ws/net') return await connectNetwork(request, env);
      if (url.pathname.startsWith('/ws/room/')) return await connectRoom(request, env, url);

      // The workers.dev address still serves the site as a fallback, but must
      // not compete with the real domain in search results.
      const headers = isCanonicalHost(request.url, env.CANONICAL_HOST)
        ? SECURITY_HEADERS
        : { ...SECURITY_HEADERS, 'x-robots-tag': 'noindex' };

      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const response = await handleApi(request, env, ctx, url);
        return withHeaders(response, headers);
      }

      // Pretty URLs for the two sub-pages.
      if (url.pathname.startsWith('/r/')) return await serveAsset(env, url, '/room.html', undefined, headers);
      if (url.pathname.startsWith('/d/')) return await serveAsset(env, url, '/download.html', undefined, headers);

      // Anything else that isn't a static file.
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return withHeaders(asset, headers);
      return await serveAsset(env, url, '/404.html', 404, headers);
    } catch (err) {
      console.error('[worker]', err.stack || err.message);
      const wantsJson = url.pathname.startsWith('/api/');
      if (wantsJson) {
        return new Response(JSON.stringify({ error: 'server_error', message: err.message }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return new Response('Something went wrong.', { status: 500 });
    }
  },

  /** Cron trigger: delete expired shares and abandoned uploads. */
  async scheduled(event, env, ctx) {
    const config = readConfig(env);
    const store = new LinkStore(env, config, masterKeyFrom(env));
    const usage = new UsageTracker(env.DB, config.dailyLimits);

    ctx.waitUntil(
      Promise.all([store.sweep(), usage.sweep()])
        .then(([{ expired, abandoned }, counters]) => {
          if (expired || abandoned || counters) {
            console.log(`[cleanup] expired=${expired} abandoned=${abandoned} counters=${counters}`);
          }
        })
        .catch((err) => console.error('[cleanup]', err.message))
    );
  },
};

/**
 * Mode 1 grouping: everyone arriving from the same public IP lands in the same
 * Durable Object and therefore sees each other. The IP is hashed, never stored.
 */
async function connectNetwork(request, env) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected a websocket upgrade', { status: 426 });
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'local-dev';
  const networkId = await hashNetworkId(ip);
  const stub = env.NETWORK_HUB.get(env.NETWORK_HUB.idFromName(networkId));
  return stub.fetch(request);
}

async function connectRoom(request, env, url) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected a websocket upgrade', { status: 426 });
  }
  const roomId = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
  if (!/^[a-z0-9]{4,32}$/.test(roomId)) return new Response('bad room id', { status: 400 });

  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  return stub.fetch(request);
}

async function serveAsset(env, url, path, status, extraHeaders = SECURITY_HEADERS) {
  const response = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
  return withHeaders(response, { ...extraHeaders, 'cache-control': 'no-cache' }, status);
}

function withHeaders(response, extra, status) {
  const result = new Response(response.body, {
    status: status ?? response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const [key, value] of Object.entries(extra)) result.headers.set(key, value);
  return result;
}
