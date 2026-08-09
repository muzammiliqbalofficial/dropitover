'use strict';

/**
 * Tiny key/value abstraction with TTL support.
 *
 * Only Mode 2 link metadata and Mode 3 room records live here. File bytes never
 * do. The in-memory implementation is the default; pointing REDIS_URL at a Redis
 * instance swaps in the Redis-backed one so several app instances can share
 * link metadata.
 */

class MemoryStore {
  constructor({ sweepIntervalMs = 60_000 } = {}) {
    this.map = new Map();
    this.timer = setInterval(() => this.sweep(), sweepIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.map) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.map.delete(key);
    }
  }

  async get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    // Return a copy so callers can't mutate stored state by accident.
    return JSON.parse(JSON.stringify(entry.value));
  }

  async set(key, value, ttlSeconds) {
    this.map.set(key, {
      value: JSON.parse(JSON.stringify(value)),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(key) {
    this.map.delete(key);
  }

  async close() {
    clearInterval(this.timer);
    this.map.clear();
  }
}

class RedisStore {
  constructor(redis) {
    this.redis = redis;
  }

  async get(key) {
    const raw = await this.redis.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  async set(key, value, ttlSeconds) {
    const raw = JSON.stringify(value);
    if (ttlSeconds) await this.redis.set(key, raw, 'EX', Math.max(1, Math.ceil(ttlSeconds)));
    else await this.redis.set(key, raw);
  }

  async del(key) {
    await this.redis.del(key);
  }

  async close() {
    await this.redis.quit();
  }
}

function createStore(redisUrl) {
  if (!redisUrl) return new MemoryStore();
  try {
    const Redis = require('ioredis');
    const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
    redis.on('error', (err) => console.error('[store] redis error:', err.message));
    console.log('[store] using Redis at', redisUrl.replace(/\/\/.*@/, '//***@'));
    return new RedisStore(redis);
  } catch (err) {
    console.warn(`[store] REDIS_URL set but ioredis is unavailable (${err.message}); using in-memory store.`);
    return new MemoryStore();
  }
}

module.exports = { createStore, MemoryStore, RedisStore };
