// Per-IP daily quota for Mode 2 uploads.
//
// The site is public and anonymous by design, so the only thing standing
// between it and someone filling the R2 bucket is this. Quotas are counted per
// hashed IP per UTC day and charged once per share (using the manifest's
// declared sizes, which the part-upload handler already enforces byte for byte)
// rather than per chunk — one row write per share, not 256.
//
// Modes 1 and 3 never touch storage, so they are deliberately not metered.

/** UTC day bucket, e.g. "2026-08-10". */
export function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Milliseconds until the quota resets (next UTC midnight). */
export function msUntilReset(now) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

/**
 * Pure quota decision.
 * @param {{shares: number, bytes: number}} used     already spent today
 * @param {{shares: number, bytes: number}} incoming this request
 * @param {{shares: number, bytes: number}} limits   daily caps (0 = unlimited)
 * @returns {{ok: true} | {ok: false, error: string, message: string}}
 */
export function evaluateQuota(used, incoming, limits) {
  if (limits.shares > 0 && used.shares + incoming.shares > limits.shares) {
    return {
      ok: false,
      error: 'daily_share_limit',
      message: `You've created ${used.shares} shares today; the limit is ${limits.shares} per day. Try again after midnight UTC.`,
    };
  }

  if (limits.bytes > 0 && used.bytes + incoming.bytes > limits.bytes) {
    return {
      ok: false,
      error: 'daily_size_limit',
      message:
        `That would put you over the ${formatGb(limits.bytes)} you can upload per day ` +
        `(${formatGb(used.bytes)} used). Try again after midnight UTC, or send it device-to-device instead — ` +
        'nearby transfers and rooms have no limit at all.',
    };
  }

  return { ok: true };
}

function formatGb(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb % 1 === 0 ? gb : gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

export class UsageTracker {
  /** @param {{shares: number, bytes: number}} limits */
  constructor(db, limits) {
    this.db = db;
    this.limits = limits;
  }

  /**
   * Checks the quota and, if there's room, charges it.
   *
   * Two statements rather than one atomic upsert: a burst of simultaneous
   * requests from one IP can slip slightly over the cap, which is fine for
   * abuse control and avoids serialising every upload behind a lock.
   */
  async reserve(ipHash, incoming, now = Date.now()) {
    const day = dayKey(now);
    const row = await this.db
      .prepare('SELECT shares, bytes FROM usage WHERE ip_hash = ? AND day = ?')
      .bind(ipHash, day)
      .first();

    const used = { shares: row?.shares || 0, bytes: row?.bytes || 0 };
    const verdict = evaluateQuota(used, incoming, this.limits);
    if (!verdict.ok) return { ...verdict, retryAfterMs: msUntilReset(now) };

    await this.db
      .prepare(
        `INSERT INTO usage (ip_hash, day, shares, bytes) VALUES (?, ?, ?, ?)
         ON CONFLICT (ip_hash, day) DO UPDATE SET shares = shares + ?, bytes = bytes + ?`
      )
      .bind(ipHash, day, incoming.shares, incoming.bytes, incoming.shares, incoming.bytes)
      .run();

    return { ok: true, used: { shares: used.shares + incoming.shares, bytes: used.bytes + incoming.bytes } };
  }

  /** Drops counters older than yesterday; called from the cron sweep. */
  async sweep(now = Date.now()) {
    const cutoff = dayKey(now - 2 * 24 * 60 * 60 * 1000);
    const result = await this.db.prepare('DELETE FROM usage WHERE day < ?').bind(cutoff).run();
    return result.meta?.changes || 0;
  }
}
