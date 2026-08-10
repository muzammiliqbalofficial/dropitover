import test from 'node:test';
import assert from 'node:assert/strict';

import { dayKey, evaluateQuota, msUntilReset } from '../src/lib/limits.js';

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
