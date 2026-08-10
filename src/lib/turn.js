// TURN relay credentials.
//
// STUN alone gets a direct path through most home routers, but fails on
// symmetric NAT — which is what most mobile carriers use. Without a relay, a
// phone on mobile data and a laptop on Wi-Fi will sit at "Connecting…" forever.
//
// Cloudflare Realtime issues short-lived TURN credentials over a REST API, so
// no long-lived password ever reaches the browser. Set TURN_KEY_ID and
// TURN_API_TOKEN as secrets to switch it on; without them the app falls back to
// STUN only and says so in the UI.

const ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const DEFAULT_TTL = 2 * 60 * 60; // seconds

// Credentials are per-key, not per-user, so one mint serves every visitor this
// isolate handles. Refreshed well before expiry.
let cached = null;

/**
 * Normalises the two shapes Cloudflare's API has used for this response.
 * @returns {RTCIceServer[]|null}
 */
export function normalizeIceServers(payload) {
  const raw = payload?.iceServers ?? payload;
  if (!raw) return null;

  const list = Array.isArray(raw) ? raw : [raw];
  const servers = list
    .filter((entry) => entry && (entry.urls || entry.url))
    .map((entry) => {
      const urls = entry.urls ?? entry.url;
      const server = { urls: Array.isArray(urls) ? urls : [urls] };
      if (entry.username) server.username = entry.username;
      if (entry.credential) server.credential = entry.credential;
      return server;
    })
    .filter((server) => server.urls.length > 0);

  return servers.length ? servers : null;
}

/** True when at least one entry can actually relay (not just STUN). */
export function hasRelay(iceServers) {
  return iceServers.some((server) =>
    [].concat(server.urls).some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'))
  );
}

/**
 * Fetches short-lived TURN credentials, or null when unconfigured/unavailable.
 * Never throws — a relay outage must not break the config endpoint.
 */
export async function mintCloudflareTurn(env, { ttlSeconds = DEFAULT_TTL, now = Date.now() } = {}) {
  const keyId = (env.TURN_KEY_ID || '').trim();
  const token = (env.TURN_API_TOKEN || '').trim();
  if (!keyId || !token) return null;

  if (cached && cached.expiresAt > now + 5 * 60 * 1000) return cached.iceServers;

  try {
    const response = await fetch(`${ENDPOINT}/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: ttlSeconds }),
    });

    if (!response.ok) {
      console.error(`[turn] credential request failed: ${response.status} ${await response.text()}`);
      return null;
    }

    const iceServers = normalizeIceServers(await response.json());
    if (!iceServers) {
      console.error('[turn] credential response had no usable ICE servers');
      return null;
    }

    cached = { iceServers, expiresAt: now + ttlSeconds * 1000 };
    return iceServers;
  } catch (err) {
    console.error('[turn] credential request threw:', err.message);
    return null;
  }
}

/** Static STUN/TURN from vars, plus Cloudflare-issued relay credentials. */
export async function buildIceServers(env, staticServers) {
  const minted = await mintCloudflareTurn(env);
  return minted ? [...staticServers, ...minted] : staticServers;
}
