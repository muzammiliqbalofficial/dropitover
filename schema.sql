-- ShareBeam D1 schema (Mode 2 link shares).
-- Apply with: npm run db:apply        (remote)
--             npm run db:apply:local  (local dev)

CREATE TABLE IF NOT EXISTS links (
  id              TEXT PRIMARY KEY,
  owner_token     TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  expiry          TEXT NOT NULL,
  burn_after_read INTEGER NOT NULL DEFAULT 0,
  text            TEXT,
  text_read       INTEGER NOT NULL DEFAULT 0,
  -- 'pending' while parts are still uploading, 'ready' once finalized.
  status          TEXT NOT NULL DEFAULT 'pending',
  total_size      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_links_expires_at ON links (expires_at);
CREATE INDEX IF NOT EXISTS idx_links_status ON links (status, created_at);

CREATE TABLE IF NOT EXISTS files (
  link_id        TEXT NOT NULL,
  id             TEXT NOT NULL,
  name           TEXT NOT NULL,
  mime           TEXT NOT NULL DEFAULT 'application/octet-stream',
  size           INTEGER NOT NULL,
  part_size      INTEGER NOT NULL,
  part_count     INTEGER NOT NULL,
  -- AES-256-GCM parameters. `salt` feeds HKDF for this file's key; `ivs` is a
  -- JSON array with one hex IV per part. The master key never leaves the Worker.
  salt           TEXT NOT NULL,
  ivs            TEXT NOT NULL,
  r2_key         TEXT NOT NULL,
  upload_id      TEXT,
  etags          TEXT NOT NULL DEFAULT '[]',
  uploaded_parts INTEGER NOT NULL DEFAULT 0,
  downloaded     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id, id),
  FOREIGN KEY (link_id) REFERENCES links (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_link ON files (link_id);

-- Per-IP daily quota for Mode 2 uploads. The IP is hashed (never stored raw),
-- one row per address per UTC day, written once per share rather than per chunk.
-- Modes 1 and 3 are peer-to-peer and cost nothing to host, so they are not
-- metered here.
CREATE TABLE IF NOT EXISTS usage (
  ip_hash TEXT NOT NULL,
  day     TEXT NOT NULL,
  shares  INTEGER NOT NULL DEFAULT 0,
  bytes   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);

CREATE INDEX IF NOT EXISTS idx_usage_day ON usage (day);
