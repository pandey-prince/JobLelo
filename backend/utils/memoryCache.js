import { LRUCache } from "lru-cache";

/**
 * Small in-process cache with:
 *  - TTL freshness
 *  - stale-while-revalidate (serve old data, refresh in the background)
 *  - single-flight loading (concurrent misses share one loader call)
 *  - generation-safe invalidation (a load that started before invalidate()
 *    can never overwrite newer state)
 *  - counters for observability
 *  - kill switch: ttlMs <= 0 turns the cache into a pass-through
 *
 * Cached values must be treated as READ-ONLY by callers.
 */

const resolveNumber = (value) => (typeof value === "function" ? Number(value()) : Number(value));

const readEnvMs = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const envMs = readEnvMs;

export const createCache = ({
  name = "cache",
  ttlMs = 5 * 60 * 1000,
  staleMs = 30 * 60 * 1000,
  max = 100,
  retryBackoffMs = 15 * 1000,
  now = () => Date.now(),
  logger = console,
} = {}) => {
  // Freshness is managed manually (so stale entries can still be served),
  // lru-cache only enforces the max entry count.
  const store = new LRUCache({ max });
  const inflight = new Map(); // key -> { promise }
  const generations = new Map(); // key -> number
  const retryAfter = new Map(); // key -> timestamp (backoff after failed refresh)
  let versionCounter = 0;

  const counters = {
    hits: 0,
    staleHits: 0,
    misses: 0,
    bypasses: 0,
    loads: 0,
    loadErrors: 0,
    invalidations: 0,
    lastLoadMs: null,
    lastLoadAt: null,
    lastError: null,
  };

  const generationOf = (key) => generations.get(key) || 0;

  const effectiveTtl = (override) => resolveNumber(override ?? ttlMs);
  const effectiveStale = (override, ttl) => {
    const stale = resolveNumber(override ?? staleMs);
    return Number.isFinite(stale) ? Math.max(stale, ttl) : ttl;
  };

  const startLoad = (key, loader, cacheable) => {
    const existing = inflight.get(key);
    if (existing) return existing.promise;

    const generationAtStart = generationOf(key);
    const startedAt = performance.now();
    counters.loads += 1;

    const holder = {};
    holder.promise = (async () => {
      try {
        const value = await loader();
        counters.lastLoadMs = performance.now() - startedAt;
        counters.lastLoadAt = now();
        counters.lastError = null;
        retryAfter.delete(key);

        const entry = { value, builtAt: now(), version: (versionCounter += 1) };
        // Only store if nothing invalidated this key while we were loading
        // and the value is allowed to be cached.
        if (generationOf(key) === generationAtStart && cacheable(value)) {
          store.set(key, entry);
        }
        return entry;
      } catch (error) {
        counters.loadErrors += 1;
        counters.lastError = { message: error?.message || String(error), at: now() };
        retryAfter.set(key, now() + resolveNumber(retryBackoffMs));
        throw error;
      } finally {
        if (inflight.get(key) === holder) inflight.delete(key);
      }
    })();

    inflight.set(key, holder);
    return holder.promise;
  };

  /**
   * Returns the cache entry { value, builtAt, version, state } for key.
   * state: "hit" | "stale" | "miss" | "bypass" | "stale-on-error"
   */
  const getOrLoadEntry = async (
    key,
    loader,
    { ttlMs: ttlOverride, staleMs: staleOverride, cacheable = () => true } = {},
  ) => {
    const ttl = effectiveTtl(ttlOverride);

    // Kill switch
    if (!(ttl > 0)) {
      counters.bypasses += 1;
      const value = await loader();
      return { value, builtAt: now(), version: 0, state: "bypass" };
    }

    const maxAge = effectiveStale(staleOverride, ttl);
    const entry = store.get(key);

    if (entry) {
      const age = now() - entry.builtAt;

      if (age < ttl) {
        counters.hits += 1;
        return { ...entry, state: "hit" };
      }

      if (age < maxAge) {
        counters.staleHits += 1;
        const backoffUntil = retryAfter.get(key) || 0;
        if (now() >= backoffUntil) {
          // Background refresh; failures are logged, stale data keeps being served.
          startLoad(key, loader, cacheable).catch((error) => {
            logger.warn?.(`[${name}] background refresh failed for "${key}": ${error?.message}`);
          });
        }
        return { ...entry, state: "stale" };
      }
    }

    counters.misses += 1;
    try {
      const fresh = await startLoad(key, loader, cacheable);
      return { ...fresh, state: "miss" };
    } catch (error) {
      // Too old to be "fresh enough" but better than failing the request.
      if (entry) {
        logger.warn?.(`[${name}] load failed for "${key}", serving stale data: ${error?.message}`);
        return { ...entry, state: "stale-on-error" };
      }
      throw error;
    }
  };

  const getOrLoad = async (key, loader, options) => {
    const entry = await getOrLoadEntry(key, loader, options);
    return entry.value;
  };

  const invalidate = (key) => {
    counters.invalidations += 1;
    generations.set(key, generationOf(key) + 1);
    inflight.delete(key); // let the next request start a fresh load
    retryAfter.delete(key);
    return store.delete(key);
  };

  const invalidatePrefix = (prefix) => {
    const keys = new Set([...store.keys(), ...inflight.keys(), ...generations.keys()]);
    let count = 0;
    for (const key of keys) {
      if (String(key).startsWith(prefix)) {
        invalidate(key);
        count += 1;
      }
    }
    return count;
  };

  const clear = () => {
    const keys = new Set([...store.keys(), ...inflight.keys()]);
    for (const key of keys) invalidate(key);
    store.clear();
  };

  const peek = (key) => {
    const entry = store.peek(key);
    return entry ? { ...entry, ageMs: now() - entry.builtAt } : null;
  };

  const getStats = () => ({
    name,
    ...counters,
    ttlMs: effectiveTtl(),
    staleMs: effectiveStale(undefined, effectiveTtl()),
    size: store.size,
    inflight: inflight.size,
    entries: [...store.keys()].map((key) => {
      const entry = store.peek(key);
      return {
        key,
        builtAt: entry ? new Date(entry.builtAt).toISOString() : null,
        ageMs: entry ? now() - entry.builtAt : null,
        version: entry?.version ?? null,
      };
    }),
  });

  return {
    getOrLoad,
    getOrLoadEntry,
    invalidate,
    invalidatePrefix,
    clear,
    peek,
    getStats,
  };
};

/**
 * Memoise derived data on top of a versioned source (e.g. the catalog).
 * A value is reused while `version` is unchanged (and, optionally, within ttlMs).
 */
export const createDerivedMemo = ({ max = 200, now = () => Date.now() } = {}) => {
  const store = new LRUCache({ max });

  const get = (key, version, compute, { ttlMs } = {}) => {
    const entry = store.get(key);
    if (
      entry &&
      entry.version === version &&
      (!ttlMs || now() - entry.at < ttlMs)
    ) {
      return entry.value;
    }
    const value = compute();
    store.set(key, { version, value, at: now() });
    return value;
  };

  const getAsync = async (key, version, compute, { ttlMs } = {}) => {
    const entry = store.get(key);
    if (
      entry &&
      entry.version === version &&
      (!ttlMs || now() - entry.at < ttlMs)
    ) {
      return entry.value;
    }
    const value = await compute();
    store.set(key, { version, value, at: now() });
    return value;
  };

  return {
    get,
    getAsync,
    clear: () => store.clear(),
    size: () => store.size,
  };
};

const isPlainObject = (value) => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Recursively freeze plain objects/arrays so accidental mutation of cached
 * values throws (ESM is strict). Class instances (ObjectId, Date, ...) are left
 * alone: freezing e.g. a Buffer-backed ObjectId would throw.
 */
export const deepFreeze = (value) => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
};
