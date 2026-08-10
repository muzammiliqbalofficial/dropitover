import test from 'node:test';
import assert from 'node:assert/strict';

import { UsageTracker, dayKey, evaluateQuota, msUntilReset } from '../src/lib/limits.js';

/** Stand-in for the D1 binding, covering just the calls UsageTracker makes. */
function stubDb() {
  const rows = new Map();
  const statement = (sql) => ({
    bind(...args) {
      return {
        async first() {
          if (!sql.startsWith('SELECT')) return null;
          return rows.get(`${args[0]}|${args[1]}`) || null;
        },
        async run() {
          if (sql.startsWith('INSERT')) {
            const [ipHash, day, shares, bytes] = args;
            const key = `${ipHash}|${day}`;
            const current = rows.get(key) || { shares: 0, bytes: 0 };
            rows.set(key, { shares: current.shares + shares, bytes: current.bytes + bytes });
          } else if (sql.startsWith('DELETE')) {
            let removed = 0;
            for (const key of [...rows.keys()]) {
              if (key.split('|')[1] < args[0]) {
                rows.delete(key);
                removed += 1;
              }
            }
            return { meta: { changes: removed } };
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  });
  return { rows, prepare: statement };
}

const GB = 1024 * 1024 * 1024;
const LIMITS = { shares: 10, bytes: 5 * GB };
const none = { shares: 0, bytes: 0 };

test('day buckets follow UTC, not local time', () => {
  assert.equal(dayKey(Date.UTC(2026, 7, 10, 0, 0, 0)), '2026-08-10');
  assert.equal(dayKey(Date.UTC(2026, 7, 10, 23, 59, 59)), '2026-08-10');
  assert.equal(dayKey(Date.UTC(2026, 7, 11, 0, 0, 0)), '2026-08-11');
});

test('reset time counts down to the next UTC midnight', () => {
  assert.equal(msUntilReset(Date.UTC(2026, 7, 10, 23, 0, 0)), 60 * 60 * 1000);
  assert.equal(msUntilReset(Date.UTC(2026, 7, 10, 0, 0, 0)), 24 * 60 * 60 * 1000);
});

test('a first upload inside both caps is allowed', () => {
  assert.deepEqual(evaluateQuota(none, { shares: 1, bytes: GB }, LIMITS), { ok: true });
});

test('the last allowed share passes and the next one does not', () => {
  const used = { shares: 9, bytes: GB };
  assert.equal(evaluateQuota(used, { shares: 1, bytes: 1 }, LIMITS).ok, true);

  const full = evaluateQuota({ shares: 10, bytes: GB }, { shares: 1, bytes: 1 }, LIMITS);
  assert.equal(full.ok, false);
  assert.equal(full.error, 'daily_share_limit');
  assert.match(full.message, /10 per day/);
});

test('the byte cap is enforced on the total, not per share', () => {
  const used = { shares: 2, bytes: 4.5 * GB };

  assert.equal(evaluateQuota(used, { shares: 1, bytes: 0.4 * GB }, LIMITS).ok, true);

  const over = evaluateQuota(used, { shares: 1, bytes: GB }, LIMITS);
  assert.equal(over.ok, false);
  assert.equal(over.error, 'daily_size_limit');
});

test('landing exactly on a cap is allowed; one byte past is not', () => {
  assert.equal(evaluateQuota({ shares: 0, bytes: 0 }, { shares: 1, bytes: 5 * GB }, LIMITS).ok, true);
  assert.equal(evaluateQuota({ shares: 0, bytes: 0 }, { shares: 1, bytes: 5 * GB + 1 }, LIMITS).ok, false);
});

test('the size message points people at the unlimited peer-to-peer modes', () => {
  const over = evaluateQuota({ shares: 1, bytes: 5 * GB }, { shares: 1, bytes: 1 }, LIMITS);
  assert.match(over.message, /5 GB/);
  assert.match(over.message, /device-to-device|rooms/);
});

test('a zero limit means unlimited', () => {
  const unlimited = { shares: 0, bytes: 0 };
  const huge = { shares: 9999, bytes: 900 * GB };
  assert.deepEqual(evaluateQuota(huge, { shares: 1, bytes: 100 * GB }, unlimited), { ok: true });

  const sharesOnly = { shares: 3, bytes: 0 };
  assert.equal(evaluateQuota({ shares: 3, bytes: 999 * GB }, { shares: 1, bytes: GB }, sharesOnly).ok, false);
  assert.equal(evaluateQuota({ shares: 1, bytes: 999 * GB }, { shares: 1, bytes: GB }, sharesOnly).ok, true);
});

test('a single share larger than the whole daily budget is refused', () => {
  const over = evaluateQuota(none, { shares: 1, bytes: 6 * GB }, LIMITS);
  assert.equal(over.ok, false);
  assert.equal(over.error, 'daily_size_limit');
});

test('the tracker charges each share and blocks the one past the cap', async () => {
  const db = stubDb();
  const tracker = new UsageTracker(db, { shares: 3, bytes: 0 });
  const now = Date.UTC(2026, 7, 10, 12, 0, 0);

  for (let i = 0; i < 3; i += 1) {
    const result = await tracker.reserve('ip-hash', { shares: 1, bytes: GB }, now);
    assert.equal(result.ok, true, `share ${i + 1} should be allowed`);
  }

  const blocked = await tracker.reserve('ip-hash', { shares: 1, bytes: GB }, now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'daily_share_limit');
  assert.equal(blocked.retryAfterMs, 12 * 60 * 60 * 1000, 'retry after points at UTC midnight');
});

test('quotas are per IP and reset the next day', async () => {
  const db = stubDb();
  const tracker = new UsageTracker(db, { shares: 1, bytes: 0 });
  const monday = Date.UTC(2026, 7, 10, 9, 0, 0);

  assert.equal((await tracker.reserve('ip-a', { shares: 1, bytes: 0 }, monday)).ok, true);
  assert.equal((await tracker.reserve('ip-a', { shares: 1, bytes: 0 }, monday)).ok, false);

  assert.equal((await tracker.reserve('ip-b', { shares: 1, bytes: 0 }, monday)).ok, true, 'other IP unaffected');

  const tuesday = monday + 24 * 60 * 60 * 1000;
  assert.equal((await tracker.reserve('ip-a', { shares: 1, bytes: 0 }, tuesday)).ok, true, 'new day, fresh quota');
});

test('a broken or missing usage table fails open instead of blocking uploads', async () => {
  const brokenDb = {
    prepare() {
      throw new Error('D1_ERROR: no such table: usage');
    },
  };
  const tracker = new UsageTracker(brokenDb, LIMITS);

  const result = await tracker.reserve('ip-hash', { shares: 1, bytes: GB });
  assert.equal(result.ok, true, 'sharing must survive a quota backend failure');
  assert.equal(result.degraded, true, 'and say that protection was skipped');

  assert.equal(await tracker.sweep(), 0, 'sweep swallows the same failure');
});

test('sweep drops counters older than two days and keeps recent ones', async () => {
  const db = stubDb();
  const tracker = new UsageTracker(db, LIMITS);
  const now = Date.UTC(2026, 7, 10, 12, 0, 0);

  await tracker.reserve('old', { shares: 1, bytes: 0 }, now - 5 * 24 * 60 * 60 * 1000);
  await tracker.reserve('recent', { shares: 1, bytes: 0 }, now);

  assert.equal(await tracker.sweep(now), 1);
  assert.equal(db.rows.size, 1);
  assert.ok([...db.rows.keys()][0].startsWith('recent'));
});
