# DropItOver maintenance review — October 17, 2026

Implemented in the working tree. Production code and the remote D1 database have not been changed. The four pre-existing edited files (public/index.html, public/robots.txt, public/terms.html, src/index.js) were preserved and extended.

## Changes

1. Routing and crawlability: retained dedicated static guide and comparison pages; /guides now serves the hub directly with 200 alongside the canonical /guides/. Explicit static HTML and real-404 handling are configured. The sitemap contains 24 canonical URLs dated 2026-10-17. Robots explicitly allows Googlebot and Mediapartners-Google. All internal links and fragment targets resolve. Privacy disclosures cover Google/third-party advertising cookies, legacy DoubleClick DART terminology, Ads Settings, data rights, support retention, and the real encryption boundary.
2. Homepage: passive config failures retry silently; handshake failures reconnect without error toasts. Shared network errors no longer expose raw HTTP 499 text or backend exception messages. Signaling reconnects when offline state clears, rejects interrupted pending requests, and does not exclude bots or headless browsers. The initial HTML explains discovery and transfer steps.
3. Advertising: removed every empty slot and label plus unused slot CSS. Existing official head verification scripts and ads.txt remain. No ad units or mock banners are added.
4. Contact: POST /api/contact validates JSON, a 16 KiB streamed body cap, bounded fields, email, allowed category, origin, and request method. An atomic SQLite insert permits five inquiries per hashed IP per UTC day. Success follows D1 persistence and includes a random ticket reference. Failures retain the form. Tickets are private and swept after 90 days. The README explains authenticated inbox access. There is no email forwarding service or public inquiry reader.
5. Maintenance: about/terms/privacy show October review dates; article structured-data modification dates agree. Four September changelog entries are backed by commits 6fe0c32 and 127f74a, with repeated dates where appropriate. The October 17 entry describes this maintenance work. Historical August entries remain historical; no invented September/October performance work was backdated.
6. Content: rewrote all 15 guides and both comparison pages, approximately 1,200 words each, with topic-specific procedures, practical matrices, applicable flow diagrams, and reproducible performance worksheets. The guide hub is 1,357 words. Corrected false client-side encryption, zero-knowledge storage, constant-memory receive, universal speed, and offline-PWA claims. Link encryption occurs in the Worker; receive Blobs still represent whole files.

## Verification completed

- npm test: 66 passed, zero failures, zero skipped.
- npm run check:site -- http://127.0.0.1:8787: all 28 HTML files, local links, fragment targets, JSON-LD, guide lengths, sitemap coverage, and ad-slot absence passed. All 28 audited routes returned 200 for browser, Googlebot, and Mediapartners-Google user agents. Unknown ordinary and guide paths returned 404.
- Local D1 schema application succeeded. The browser form returned a stored ticket, and an authenticated local query confirmed six synthetic tickets (one UI submission and five concurrency submissions).
- Eight simultaneous API submissions from one synthetic IP produced exactly five 201 responses and three 429 responses; every success carried a unique ticket ID.
- Desktop browser inspection confirmed the saved-ticket UI, clean homepage state, and readable article layout; captured browser error/warning logs were empty for the inspected homepage session.
- Wrangler deploy dry-run built successfully. git diff --check passed. No dependency was added.
- Read-only production baseline using Mediapartners-Google: /, /privacy, /guides/, /ads.txt, /robots.txt, and /sitemap.xml returned 200; /guides returned 307 to /guides/. The changed direct /guides response is verified locally and awaits deployment.

## Release steps

Apply the additive schema before deploying: npm run db:apply. Then run npm run deploy and npm run check:site -- https://dropitover.com. The contact endpoint returns a clear 503 if its table has not been applied, instead of claiming a ticket was saved. The schema creates a new table and indexes without dropping existing shares.

The support operator must check the private D1 inbox as documented in README.md. Email forwarding is not configured. Production deployment, remote migration, and production contact submissions were not performed in this task.

## Limits and evidence

Calculated speed and memory/format tables are explicitly labeled examples or observations about implementation. No real-device speed or peak-memory measurements were available, so none were fabricated. Hardware tests on Windows, Android, iOS, Snapdrop, and LocalSend remain to be performed with the published worksheet. No actual two-device transfer, TURN capacity test, or mobile-device run was conducted.

HTTP availability does not establish Google indexing. Search Console and the AdSense account were not inspected, and neither indexing nor approval can be guaranteed by these edits. Existing production /privacy already returned 200 in the baseline, so code does not establish that it was blocked. Account-level Cloudflare WAF/bot settings were not inspected. Advertising consent infrastructure was not added; the privacy disclosure does not claim that it implements consent.

The official references used for disclosure and route behavior include [Google required content](https://support.google.com/adsense/answer/1348695?hl=en) and [Cloudflare HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/). Protocol references are linked within the relevant articles.

## Every changed or added file (45)

- [ADSENSE-REVIEW.md](ADSENSE-REVIEW.md)
- [README.md](README.md)
- [package.json](package.json)
- [public/404.html](public/404.html)
- [public/about.html](public/about.html)
- [public/contact.html](public/contact.html)
- [public/css/styles.css](public/css/styles.css)
- [public/download.html](public/download.html)
- [public/guides/aes-256-gcm-encryption-file-sharing.html](public/guides/aes-256-gcm-encryption-file-sharing.html)
- [public/guides/airdrop-for-windows.html](public/guides/airdrop-for-windows.html)
- [public/guides/cross-platform-file-transfer-mac-linux-windows.html](public/guides/cross-platform-file-transfer-mac-linux-windows.html)
- [public/guides/ephemeral-expiring-links-privacy.html](public/guides/ephemeral-expiring-links-privacy.html)
- [public/guides/file-transfer-without-app-installation-pwa.html](public/guides/file-transfer-without-app-installation-pwa.html)
- [public/guides/how-to-send-sensitive-documents-safely.html](public/guides/how-to-send-sensitive-documents-safely.html)
- [public/guides/how-webrtc-peer-to-peer-file-transfer-works.html](public/guides/how-webrtc-peer-to-peer-file-transfer-works.html)
- [public/guides/index.html](public/guides/index.html)
- [public/guides/iphone-to-windows-file-transfer-without-itunes.html](public/guides/iphone-to-windows-file-transfer-without-itunes.html)
- [public/guides/p2p-vs-cloud-storage.html](public/guides/p2p-vs-cloud-storage.html)
- [public/guides/send-large-files-without-email.html](public/guides/send-large-files-without-email.html)
- [public/guides/share-files-over-local-wifi-network.html](public/guides/share-files-over-local-wifi-network.html)
- [public/guides/snapdrop-alternatives-local-sharing.html](public/guides/snapdrop-alternatives-local-sharing.html)
- [public/guides/webrtc-stun-turn-signaling-servers-explained.html](public/guides/webrtc-stun-turn-signaling-servers-explained.html)
- [public/guides/wifi-file-transfer-android-to-pc.html](public/guides/wifi-file-transfer-android-to-pc.html)
- [public/guides/wireless-file-sharing-classrooms-office-meetings.html](public/guides/wireless-file-sharing-classrooms-office-meetings.html)
- [public/index.html](public/index.html)
- [public/js/app.js](public/js/app.js)
- [public/js/contact.js](public/js/contact.js)
- [public/js/util.js](public/js/util.js)
- [public/js/ws.js](public/js/ws.js)
- [public/privacy.html](public/privacy.html)
- [public/robots.txt](public/robots.txt)
- [public/room.html](public/room.html)
- [public/sitemap.xml](public/sitemap.xml)
- [public/terms.html](public/terms.html)
- [public/updates.html](public/updates.html)
- [public/vs/airdrop.html](public/vs/airdrop.html)
- [public/vs/snapdrop.html](public/vs/snapdrop.html)
- [schema.sql](schema.sql)
- [scripts/check-site.mjs](scripts/check-site.mjs)
- [src/index.js](src/index.js)
- [src/routes/api.js](src/routes/api.js)
- [src/routes/contact.js](src/routes/contact.js)
- [tests/contact.test.js](tests/contact.test.js)
- [tests/frontend-network.test.js](tests/frontend-network.test.js)
- [wrangler.toml](wrangler.toml)
