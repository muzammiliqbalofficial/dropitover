# ShareBeam

Send files and text between devices three ways, from one page:

| Mode | Use it when | How the bytes travel |
|---|---|---|
| **1 — Nearby devices** | Both devices are on the same Wi‑Fi / behind the same router | WebRTC data channel, peer to peer. Never touches the server. |
| **2 — Link share** | The other person is on another network, or offline right now | Uploaded once, AES‑256‑GCM encrypted at rest, deleted at expiry |
| **3 — Room** | Both people are online but on different networks, and want to swap things back and forth | WebRTC data channel, peer to peer. Never touches the server. |

No account, no paywall, no file-count cap, up to **2 GB per file** by default, expiry from **1 hour to 7 days** (24 hours by default).

---

## Quick start

```bash
npm install
cp .env.example .env      # optional — every value has a working default
npm start                 # http://localhost:3000
npm test                  # link-expiry + room tests
```

Windows PowerShell: `Copy-Item .env.example .env`.

To try Mode 1, open the page on a second device on the same network using your machine's LAN address (e.g. `http://192.168.1.20:3000`) — the two devices appear in each other's "Nearby devices" list within a second.

> **Browser caveat for LAN testing:** browsers only expose `getUserMedia`-free WebRTC and the Clipboard API on *secure* origins. `http://localhost` counts as secure, but `http://192.168.x.x` does not — clipboard copy falls back to a legacy path, and some mobile browsers restrict WebRTC on plain HTTP. For real use, terminate TLS in front of the app (see [Deployment](#deployment)) so everything runs over HTTPS/WSS.

---

## How each mode works internally

### Mode 1 — same-network auto discovery

Browsers cannot scan a LAN, so discovery is done at the signaling layer:

1. Every socket connection is tagged with the **public IP** it arrives from (`X-Forwarded-For` when `TRUST_PROXY` is set, otherwise the socket address). The IP is hashed into a `networkId` — the raw address is never stored or sent to clients.
2. Sockets sharing a `networkId` are joined to the same Socket.IO room and receive each other's `{id, name, deviceType}` in a `peers` event. Devices behind one NAT therefore see each other; anyone else is invisible.
3. Tapping a peer sends a `transfer:offer` (file names, count, total size) through the server. The receiver gets `transfer:incoming` and shows an accept/decline prompt.
4. On accept, both sides open an `RTCPeerConnection`. The server relays only SDP and ICE candidates via `signal` messages.
5. Files stream over an ordered `RTCDataChannel`: a JSON `file-start` header, then binary chunks (sized from `sctp.maxMessageSize`, 64 KB–256 KB), then `file-end`. Sending pauses whenever `bufferedAmount` exceeds 8 MB and resumes on `bufferedamountlow`, so a 2 GB file doesn't blow up memory. The receiver folds chunks into `Blob` parts every 16 MB.

**No file bytes reach the server in this mode.** The signaling socket is capped at a 1 MB message size precisely so it can't be used as a relay.

### Mode 2 — link share

1. `POST /api/links` is a `multipart/form-data` stream parsed by busboy. Each file is piped straight through `createCipheriv('aes-256-gcm')` into `data/uploads/<linkId>/<fileId>.enc` — plaintext is never written to disk.
2. Each file gets its **own key**, derived with HKDF‑SHA256 from the master key plus a random 16-byte salt, and a random 12-byte IV. Salt, IV and the GCM auth tag live in `meta.json` next to the ciphertext; the master key lives in `MASTER_KEY` (or `data/.masterkey`). A stolen blob alone is useless, and any tampering fails the auth tag on read.
3. The response carries the share URL, a QR code (data URL), the expiry timestamp, and an `ownerToken` that lets the sender delete the share early via `DELETE /api/links/:id`.
4. `meta.json` is the source of truth; the key/value store (in-memory, or Redis when `REDIS_URL` is set) is a cache with a matching TTL. That means expiry survives a restart and works across multiple app instances.
5. A sweeper runs every `CLEANUP_INTERVAL` seconds, deletes every share whose `expiresAt` has passed, and reaps abandoned upload directories older than an hour.
6. **Delete after first download**: the share is destroyed once every file — and the note, if there is one — has been fetched at least once. With several files, the link survives until the last one is collected, so a multi-file burn share isn't lost after the first click.

Downloads stream the ciphertext back through the decipher; `Content-Length` is the plaintext size. Range requests are intentionally not supported, because a GCM stream must be verified end to end.

### Mode 3 — rooms

1. `room:create` returns an 8-character room id; the browser navigates to `/r/<id>`.
2. `room:join` adds the socket to the room and returns the peers already present. Everyone gets `room:peer-joined` / `room:peer-left` notices.
3. **The newcomer always initiates** the WebRTC handshake to each existing participant, and existing participants answer offers from unknown peers. That single rule keeps a full mesh glare-free without perfect-negotiation bookkeeping.
4. Data channels are identical to Mode 1, so files and text flow both ways for as long as anyone stays. Each participant's connection state is shown live (`connecting` / `connected` / `failed`).
5. Room records hold only ids, display names, and an expiry. `ROOM_TTL` (12 h default) is refreshed on every join, so a link survives a refresh or a temporary disconnect.

---

## Configuration

Every setting is documented in [`.env.example`](.env.example). The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `PUBLIC_URL` | derived from the request | Set this behind a proxy so links/QRs use the public origin |
| `TRUST_PROXY` | `0` | **Must** be set behind nginx/Cloudflare, or every visitor looks like one "network" in Mode 1 |
| `MAX_FILE_SIZE` | `2147483648` (2 GB) | Per file. There is no cap on file count |
| `MAX_TOTAL_SIZE` | `8589934592` (8 GB) | Per share |
| `DEFAULT_EXPIRY` | `24h` | One of `1h`, `6h`, `24h`, `3d`, `7d` |
| `STORAGE_DIR` | `data/uploads` | Mode 2 only |
| `MASTER_KEY` | generated into `data/.masterkey` | 64 hex chars. Losing it makes stored shares unreadable |
| `REDIS_URL` | *(empty)* | Optional; enables shared link metadata across instances |
| `STUN_URLS` | Google STUN | Comma separated |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | *(empty)* | See below |

---

## Adding a TURN server

STUN alone gets a direct connection through most home routers. It fails on symmetric NAT and some mobile carriers — the UI reports *"Direct connection failed. A TURN server is needed on this network."* A TURN server relays the encrypted stream when a direct path can't be found.

Install [coturn](https://github.com/coturn/coturn) on a host with a public IP:

```bash
sudo apt install coturn
sudo sed -i 's/#TURNSERVER_ENABLED/TURNSERVER_ENABLED/' /etc/default/coturn
```

`/etc/turnserver.conf`:

```conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
realm=share.example.com
user=sharebeam:CHANGE_ME_STRONG_SECRET
external-ip=203.0.113.10
no-multicast-peers
cert=/etc/letsencrypt/live/share.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/share.example.com/privkey.pem
```

Then point the app at it:

```bash
TURN_URLS=turn:share.example.com:3478,turns:share.example.com:5349
TURN_USERNAME=sharebeam
TURN_CREDENTIAL=CHANGE_ME_STRONG_SECRET
```

Restart, and the "STUN only" badge on the landing page becomes "STUN + TURN". Open UDP/TCP 3478 and 5349, plus the relay range (49152–65535 by default). For production, prefer short-lived TURN credentials minted per session over a static username/password.

---

## Deployment

- **Always terminate TLS.** WebRTC data channels are DTLS-encrypted regardless, but signaling, uploads and downloads need HTTPS/WSS. Put nginx or Caddy in front and set `PUBLIC_URL` plus `TRUST_PROXY=1`.
- nginx needs `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` for Socket.IO, `client_max_body_size 2g;` (or more) for uploads, and a generous `proxy_read_timeout` for slow ones.
- Signaling state (rooms, presence) is per process. Run a **single instance**, or add the Socket.IO Redis adapter plus sticky sessions before scaling out. Link metadata already scales via `REDIS_URL`.
- `data/` holds the master key and every encrypted share — back it up, or accept that shares die with the volume.

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/config` | ICE servers, limits, expiry options |
| `POST` | `/api/links` | Create a share (`multipart/form-data`: `files`, `text`, `expiry`, `burnAfterRead`) |
| `GET` | `/api/links/:id` | Share metadata (410 when expired or used up) |
| `GET` | `/api/links/:id/files/:fileId` | Decrypted download stream |
| `DELETE` | `/api/links/:id` | Delete early; requires the `x-owner-token` header |
| `GET` | `/api/rooms/:id` | Room existence + occupancy |
| `GET` | `/api/qr?data=…` | PNG QR code |
| `GET` | `/api/health` | Uptime and live room count |

Socket.IO events: `hello`, `identity:update`, `peers`, `peers:refresh`, `transfer:offer`, `transfer:incoming`, `transfer:response`, `signal`, `room:create`, `room:join`, `room:leave`, `room:peer-joined`, `room:peer-left`, `room:peer-updated`.

---

## Error states the UI handles

Expired or already-consumed link · room not found · room full · peer declined · peer disconnected mid-transfer · direct connection failed (needs TURN) · file over the size limit · share over the total limit · empty share · upload aborted · signaling offline.

---

## Tests

```bash
npm test
```

`tests/links.expiry.test.js` covers expiry-window resolution and defaults, the exact expiry boundary, disk cleanup on expiry, sweeping, encryption round-trips, tamper detection, burn-after-read across multiple files and notes, cache-loss recovery from `meta.json`, and that public metadata leaks no secrets. `tests/rooms.test.js` covers creation, id collisions, joining, peer lists, duplicate joins, capacity, leaving, TTL extension, and expiry/sweeping. Both use injected clocks — no sleeping.

---

## Project layout

```
server/
  index.js          Express + HTTP server wiring, TTL sweeper, shutdown
  config.js         Env parsing, master key loading, ICE server list
  signaling.js      Socket.IO: presence by public IP, transfer offers, rooms, SDP/ICE relay
  links.js          Mode 2 storage: drafts, encryption, expiry, burn-after-read, sweeping
  rooms.js          Mode 3 room registry (pure, clock-injectable)
  crypto.js         AES-256-GCM stream helpers, HKDF, id generation
  store.js          TTL key/value store (in-memory, or Redis)
  routes/api.js     HTTP API
public/
  index.html        Landing page: nearby devices, link share, room entry
  room.html         Mode 3 room
  download.html     Mode 2 recipient page
  js/peer.js        WebRTC wrapper + chunked file protocol with backpressure
  js/app.js         Landing page logic
  js/room.js        Room logic (mesh)
  js/download.js    Streaming download with progress
  js/ui.js          Transfer log, modals, drop zones
  js/util.js        Formatting, identity, toasts, blob assembly
tests/
```

## What's next (phase 2)

Production TURN with ephemeral credentials, transfer history, rate limiting and abuse reporting, optional lightweight accounts, custom theming.
