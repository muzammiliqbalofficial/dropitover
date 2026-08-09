# ShareBeam

Send files and text between devices three ways, from one page — running entirely on Cloudflare's edge. No servers to babysit, no account, no paywall, no file-count cap, up to **2 GB per file**, expiry from **1 hour to 7 days** (24 hours by default).

| Mode | Use it when | How the bytes travel |
|---|---|---|
| **1 — Nearby devices** | Both devices are behind the same router | WebRTC data channel, browser to browser. Nothing is stored. |
| **2 — Link share** | The other person is elsewhere, or offline right now | Chunked into R2, AES‑256‑GCM encrypted inside the Worker, deleted at expiry |
| **3 — Room** | Both online, different networks, swapping things back and forth | WebRTC data channel, browser to browser. Nothing is stored. |

**Stack:** Cloudflare Workers (API + routing) · Durable Objects (signaling, rooms) · R2 (encrypted chunks) · D1 (share metadata + expiry) · Workers Static Assets (frontend) · Cron Triggers (expiry sweeper). Frontend is dependency-free ES modules.

---

## Deploy it

You need Node.js installed **locally** — not to host anything, but because `wrangler`, Cloudflare's CLI, is an npm package. (Alternative: push this repo to GitHub and use **Workers → Create → Connect to Git** in the dashboard, which builds and deploys without a local toolchain.)

```bash
npm install
npx wrangler login
```

### 1. Create the storage

```bash
npm run r2:create                 # creates the R2 bucket "sharebeam-files"
npm run db:create                 # creates the D1 database "sharebeam"
```

`db:create` prints a `database_id`. Paste it into `wrangler.toml` over `REPLACE_WITH_YOUR_D1_DATABASE_ID`, then create the tables:

```bash
npm run db:apply                  # remote (production)
npm run db:apply:local            # local, for `wrangler dev`
```

### 2. Set the encryption key

```bash
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put MASTER_KEY
```

Piping it avoids a paste picking up stray characters — the key must be exactly 64 hex
characters. `GET /api/health` reports `encryptionKey: "ok" | "malformed" | "missing"`
if you ever need to check.

Losing this key makes every stored Mode 2 share permanently unreadable. Modes 1 and 3 don't use it — they store nothing.

For local development, copy `.dev.vars.example` to `.dev.vars` and put the same key there.

### 3. Ship it

```bash
npm run dev                       # http://localhost:8787
npm run deploy                    # live on <name>.<account>.workers.dev
```

### 4. Point your domain at it

Buy the domain in **Cloudflare → Domain Registration** (sold at cost) or transfer one in, then add a route in `wrangler.toml`:

```toml
routes = [
  { pattern = "share.example.com", custom_domain = true }
]
```

and `npm run deploy` again. Cloudflare provisions the certificate; DNS, TLS, HTTP/3 and DDoS protection come with it. Everything is HTTPS/WSS from that moment, which is what WebRTC and the Clipboard API want anyway.

### Costs

R2 and D1 both have free tiers that comfortably cover personal use (10 GB stored, 5 GB database). Durable Objects run on the Workers free plan with SQLite-backed classes — which is what `wrangler.toml` declares. If your account is on the free plan and a deploy complains about Durable Objects, the Workers Paid plan is $5/month and lifts every limit here.

---

## How each mode works internally

### Mode 1 — same-network discovery (no server storage)

Browsers can't scan a LAN, so discovery happens at the signaling layer:

1. The browser opens a WebSocket to `/ws/net`. The Worker reads `CF-Connecting-IP`, hashes it (SHA-256, truncated) and routes the socket to `env.NETWORK_HUB.idFromName(hash)` — so **every device behind the same public IP lands in the same Durable Object** and nobody else does. The raw IP is never stored or sent to a client.
2. That object keeps the peer list and pushes `peers` updates. Connections use the **WebSocket Hibernation API**, so an idle group costs nothing while staying connected.
3. Tapping a peer sends a `transfer:offer` (file names, count, total size). The receiver sees an accept/decline prompt before anything is negotiated.
4. On accept, both sides build an `RTCPeerConnection`; the Durable Object relays only SDP and ICE candidates.
5. Files stream over an ordered `RTCDataChannel`: a JSON `file-start` header, binary chunks sized from `sctp.maxMessageSize` (64 KB–256 KB), then `file-end`. Sending pauses above 8 MB of buffered data and resumes on `bufferedamountlow`; the receiver folds chunks into `Blob` parts every 16 MB, so a 2 GB transfer never balloons in memory.

Signaling messages are capped at 128 KB precisely so the socket can't be abused as a file relay.

### Mode 2 — link share (the only mode that stores anything)

1. `POST /api/links` sends a **manifest** — names, sizes, MIME types, expiry, burn flag. The Worker plans each file into fixed 8 MB parts, generates one IV per part plus a per-file HKDF salt, opens an R2 multipart upload for multi-part files, and returns an `ownerToken`.
2. The browser `PUT`s each part to `/api/links/:id/files/:fileId/parts/:index`. The Worker **encrypts the part with AES-256-GCM before it reaches R2** — plaintext is never written. Each part's key comes from HKDF‑SHA256 over the master key with the file's salt; the part index is authenticated as additional data, so parts can't be reordered, duplicated or dropped without the tag failing.
3. Chunking is what makes 2 GB possible at all: a Workers request body is limited to ~100 MB, and Cloudflare's proxy caps free-plan uploads at 100 MB. 8 MB parts sit far below both, and failed chunks retry individually instead of restarting a multi-GB upload.
4. `POST /api/links/:id/finalize` completes the R2 multipart upload, flips the row to `ready` and starts the expiry clock. Only then does the link resolve.
5. Downloads stream back through ranged R2 reads — one part fetched, decrypted and enqueued at a time, so Worker memory stays flat regardless of file size. `Content-Length` is the plaintext size. Range requests are deliberately unsupported, because a GCM stream has to be verified end to end.
6. **Delete after first download** destroys the share once every file *and* the note have been collected — a multi-file burn share isn't lost after the first click. Deletion is triggered when the last byte leaves, never mid-stream.
7. A **Cron Trigger** runs every 10 minutes, deleting expired shares and reaping abandoned uploads (pending for over an hour), R2 objects and dangling multipart uploads included.

### Mode 3 — rooms (no server storage)

1. `POST /api/rooms` mints an 8-character id and initializes a **Room Durable Object**, which stores only `{createdAt, expiresAt, maxParticipants}` and sets an alarm at the expiry.
2. Joining opens a WebSocket to `/ws/room/<id>`. The object checks capacity and expiry, then hands the newcomer the list of people already inside.
3. **The newcomer always initiates** the WebRTC handshake to each existing participant, and existing participants answer offers from unknown peers. That one rule keeps a full mesh glare-free without perfect-negotiation bookkeeping.
4. Data channels are identical to Mode 1, so files and text flow both ways for as long as anyone stays; each participant's connection state is shown live.
5. Every join buys the room another full TTL (12 h by default), so a refresh or a dropped connection never kills the link. The alarm disconnects everyone and wipes the object when the room finally expires.

---

## Configuration

Plain values live in `[vars]` in `wrangler.toml`; secrets go through `wrangler secret put`.

| Setting | Default | Notes |
|---|---|---|
| `MAX_FILE_SIZE` | `2147483648` (2 GB) | Per file. There is no cap on file count |
| `MAX_TOTAL_SIZE` | `8589934592` (8 GB) | Per share |
| `MAX_TEXT_LENGTH` | `200000` | Characters in a shared note |
| `PART_SIZE` | `8388608` (8 MiB) | Upload/encryption chunk. Must be ≥ 5 MiB (R2 multipart minimum) |
| `DEFAULT_EXPIRY` | `24h` | One of `1h`, `6h`, `24h`, `3d`, `7d` |
| `ROOM_TTL_SECONDS` | `43200` (12 h) | Refreshed on every join |
| `ROOM_MAX_PARTICIPANTS` | `8` | Mesh size |
| `STUN_URLS` | Google STUN | Comma separated |
| `TURN_URLS` / `TURN_USERNAME` | *(empty)* | See below |
| `MASTER_KEY` *(secret)* | — | 64 hex chars, required |
| `TURN_CREDENTIAL` *(secret)* | — | Only with TURN |

---

## Adding a TURN server

STUN alone gets a direct connection through most home routers. It fails on symmetric NAT and some mobile carriers — the UI then says *"Direct connection failed. A TURN server is needed on this network."* TURN relays the (still end-to-end encrypted) stream when no direct path exists.

Cloudflare sells a managed option — **Cloudflare Calls / Realtime TURN** — which is the least-effort fit here: create a TURN key in the dashboard and put the credentials in `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`. Note that TURN relays *do* carry the ciphertext, so it stops being strictly peer-to-peer on those connections (the data is still DTLS-encrypted end to end; the relay can't read it).

Self-hosting [coturn](https://github.com/coturn/coturn) works too:

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

```bash
npx wrangler secret put TURN_CREDENTIAL
# and set TURN_URLS / TURN_USERNAME in wrangler.toml
```

Open UDP/TCP 3478 and 5349 plus the relay range (49152–65535). Prefer short-lived credentials minted per session over a static password in production.

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/config` | ICE servers, limits, expiry options, part size |
| `POST` | `/api/links` | Reserve a share from a JSON manifest → `{id, ownerToken, partSize, files[]}` |
| `PUT` | `/api/links/:id/files/:fileId/parts/:n` | Upload one chunk (raw body, `x-owner-token`) |
| `POST` | `/api/links/:id/finalize` | Seal the share → metadata, URL, QR URL |
| `GET` | `/api/links/:id` | Share metadata (410 when expired or used up) |
| `GET` | `/api/links/:id/files/:fileId` | Decrypted download stream |
| `DELETE` | `/api/links/:id` | Revoke early (`x-owner-token`) |
| `POST` | `/api/rooms` | Create a room |
| `GET` | `/api/rooms/:id` | Room existence + occupancy |
| `GET` | `/api/qr?data=…` | SVG QR code |
| `GET` | `/api/health` | Liveness |

WebSocket endpoints: `/ws/net` (Mode 1) and `/ws/room/<id>` (Mode 3). Envelope: `{"t": type, "d": payload, "ack": id}` in, `{"t": type, "d": payload}` or `{"t":"ack","id":…,"d":…}` out. Types: `hello`, `identity`, `peers`, `peers:refresh`, `transfer:offer`, `transfer:incoming`, `transfer:response`, `signal`, `peer:gone`, `room:peer-joined`, `room:peer-left`, `room:peer-updated`, `error`.

---

## Error states the UI handles

Expired or already-consumed link · room not found · room full · room expired mid-session · peer declined · peer disconnected mid-transfer · direct connection failed (needs TURN) · file over the size limit · share over the total limit · empty share · chunk upload failure (retried, then reported) · signaling offline (auto-reconnect with backoff).

---

## Tests

```bash
npm test
```

- `tests/expiry.test.js` — expiry windows and fallbacks, the exact expiry boundary, burn-after-read across multiple files and notes, part planning (including 0-byte and 2 GB files), and the ciphertext range maths that ranged downloads depend on.
- `tests/rooms.test.js` — creation, joining, peer lists, duplicate joins, capacity, expiry, leaving, TTL extension, and the Durable Object storage round-trip.
- `tests/crypto.test.js` — AES-256-GCM round-trips, tamper detection, part-reorder detection, per-file key isolation, wrong-master-key rejection, and IP hashing.

Everything under test is pure logic with injected clocks — no sleeping, no bindings, no network.

---

## Project layout

```
wrangler.toml          Bindings: assets, R2, D1, two Durable Objects, cron
schema.sql             D1 tables for Mode 2 metadata
src/
  index.js             Router: pages, API, WebSocket upgrades, cron handler
  do/network-hub.js    Mode 1 presence + signaling (one instance per hashed IP)
  do/room.js           Mode 3 room: membership, TTL alarm, signaling
  routes/api.js        HTTP API
  lib/links.js         Mode 2: manifest, chunked encryption, R2, expiry, burn
  lib/crypto.js        WebCrypto: HKDF, AES-256-GCM parts, ids, IP hashing
  lib/expiry.js        Pure expiry + chunk-planning maths (unit tested)
  lib/rooms.js         Pure room state machine (unit tested)
  lib/config.js        Vars/secrets parsing, ICE server list
  lib/protocol.js      WebSocket envelope helpers
  lib/qr.js            SVG QR rendering
public/
  index.html           Landing: nearby devices, link share, room entry
  room.html            Mode 3 room
  download.html        Mode 2 recipient page
  js/peer.js           WebRTC wrapper + chunked file protocol with backpressure
  js/ws.js             Signaling client (ack semantics, auto-reconnect)
  js/upload.js         Chunked Mode 2 uploader with retries
  js/app.js            Landing page logic
  js/room.js           Room logic (mesh)
  js/download.js       Streaming download with progress
  js/ui.js             Transfer log, modals, drop zones
  js/util.js           Formatting, identity, toasts, blob assembly
tests/
```

The original Node/Express implementation of the same three modes is preserved in git history (commit `3af9924`) if you ever want to self-host instead.

## What's next (phase 2)

Managed TURN with ephemeral credentials, transfer history, rate limiting and abuse reporting, optional lightweight accounts, custom theming.
