// ============================================================
// ExecDaat TTL Cache — Memoization for expensive operations
// ============================================================
// Cache: token metadata, balances, prices, contract metadata,
// RPC health, explorer metadata. TTL-configurable. Safe invalidation.
// ============================================================
;(function() {
  'use strict';
  var D = window.ExecDaat = window.ExecDaat || {};

  var stores = {};  // { namespace: { key: { value, expiresAt } } }
  var DEFAULT_TTL = 30000; // 30 seconds

  function now() { return Date.now(); }

  // ─── Public API ────────────────────────────────────────────────────────

  D.cache = {
    /** Set a value with optional TTL (ms) */
    set: function(namespace, key, value, ttlMs) {
      if (!stores[namespace]) stores[namespace] = {};
      stores[namespace][key] = {
        value: value,
        expiresAt: now() + (ttlMs || DEFAULT_TTL),
      };
    },

    /** Get a value. Returns null if expired or not found. */
    get: function(namespace, key) {
      var ns = stores[namespace];
      if (!ns) return null;
      var entry = ns[key];
      if (!entry) return null;
      if (now() > entry.expiresAt) {
        delete ns[key];
        return null;
      }
      return entry.value;
    },

    /** Get value with remaining TTL info. Returns { value, stale, ttlRemainingMs } or null. */
    getWithTTL: function(namespace, key) {
      var ns = stores[namespace];
      if (!ns) return null;
      var entry = ns[key];
      if (!entry) return null;
      var remaining = entry.expiresAt - now();
      return {
        value: entry.value,
        stale: remaining <= 0,
        ttlRemainingMs: Math.max(0, remaining),
      };
    },

    /** Check if a key exists and is not expired */
    has: function(namespace, key) {
      return D.cache.get(namespace, key) !== null;
    },

    /** Delete a specific key */
    del: function(namespace, key) {
      var ns = stores[namespace];
      if (ns) delete ns[key];
    },

    /** Clear entire namespace */
    clear: function(namespace) {
      delete stores[namespace];
    },

    /** Clear all namespaces */
    clearAll: function() {
      stores = {};
    },

    /** Get all keys in a namespace */
    keys: function(namespace) {
      var ns = stores[namespace];
      if (!ns) return [];
      return Object.keys(ns).filter(function(k) {
        return now() <= ns[k].expiresAt;
      });
    },

    /** Get namespace stats */
    stats: function(namespace) {
      var ns = stores[namespace];
      if (!ns) return { total: 0, expired: 0, valid: 0 };
      var total = 0, expired = 0;
      var n = now();
      Object.keys(ns).forEach(function(k) {
        total++;
        if (n > ns[k].expiresAt) expired++;
      });
      return { total: total, expired: expired, valid: total - expired };
    },

    /** Fetch with cache: returns cached value or calls fetcher, caches, and returns result */
    fetch: function(namespace, key, fetcher, ttlMs) {
      var cached = D.cache.get(namespace, key);
      if (cached !== null) return Promise.resolve(cached);
      return Promise.resolve(fetcher()).then(function(value) {
        D.cache.set(namespace, key, value, ttlMs);
        return value;
      });
    },

    /** Periodic cleanup of expired entries */
    cleanup: function() {
      var n = now();
      Object.keys(stores).forEach(function(ns) {
        Object.keys(stores[ns]).forEach(function(key) {
          if (n > stores[ns][key].expiresAt) delete stores[ns][key];
        });
        if (Object.keys(stores[ns]).length === 0) delete stores[ns];
      });
    },
  };

  // Auto-cleanup every 60 seconds
  setInterval(function() { D.cache.cleanup(); }, 60000);
})();
