import { createCache, createDerivedMemo, deepFreeze, envMs } from "../../utils/memoryCache.js";
import { loadCatalogFromDb } from "./jobMapper.service.js";

/**
 * In-memory cache for the public job catalog (everything behind /jobs, home,
 * stats and the companies page).
 *
 * - Caches the GLOBAL, user-independent list. Per-user steps (dismissed jobs,
 *   profile recommendations, filters, sort, pagination) happen after the cache.
 * - Freshness is TTL based (GitHub Actions write to Atlas from other processes,
 *   so this process cannot observe those writes). invalidateCatalog() is a
 *   best-effort bonus for writes that happen inside this process.
 * - Cached arrays/objects are READ-ONLY. In non-production they are deep-frozen
 *   so accidental mutation throws instead of corrupting other requests.
 *
 * Env:
 *   CATALOG_CACHE_TTL_MS    fresh window, default 300000 (5 min); 0 disables the cache
 *   CATALOG_CACHE_STALE_MS  max age for stale-while-revalidate, default 1800000 (30 min)
 *   CATALOG_CACHE_FREEZE    "true"/"false" to force freezing on/off (default: on unless production)
 */

export const CATALOG_KEY = "catalog";
export const MAX_KEYWORD_LENGTH = 100;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_REWARM_DELAY_MS = 1000;

const freezeEnabled = () => {
  const raw = process.env.CATALOG_CACHE_FREEZE;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return process.env.NODE_ENV !== "production";
};

/** Plain-text keyword normalisation (no regex semantics, bounded length). */
export const normalizeKeyword = (keyword) =>
  String(keyword ?? "")
    .trim()
    .toLowerCase()
    .slice(0, MAX_KEYWORD_LENGTH);

/** Filter a catalog by keyword using its parallel searchIndex. */
export const filterCatalogByKeyword = (catalog, keyword) => {
  const needle = normalizeKeyword(keyword);
  if (!needle) return catalog.jobs;

  const matches = [];
  const { jobs, searchIndex } = catalog;
  for (let i = 0; i < jobs.length; i += 1) {
    if (searchIndex[i].includes(needle)) matches.push(jobs[i]);
  }
  return matches;
};

export const createCatalogService = ({
  loader = loadCatalogFromDb,
  logger = console,
  rewarmDelayMs = DEFAULT_REWARM_DELAY_MS,
  now,
} = {}) => {
  const cache = createCache({
    name: "catalog",
    ttlMs: () => envMs("CATALOG_CACHE_TTL_MS", DEFAULT_TTL_MS),
    staleMs: () => envMs("CATALOG_CACHE_STALE_MS", DEFAULT_STALE_MS),
    max: 4,
    logger,
    ...(now ? { now } : {}),
  });

  // Data derived from the catalog (stats, company groups, guest recommendations).
  // Entries are keyed by catalog.version, so they refresh whenever the catalog does.
  const derived = createDerivedMemo({ max: 100 });

  /**
   * memoizeOnCatalog(key, catalog, compute, { ttlMs }) — result is reused while
   * the catalog version is unchanged (and within ttlMs, if given).
   * With the cache disabled (version 0) it always recomputes.
   */
  const memoizeOnCatalog = (key, catalog, compute, options) =>
    catalog.version ? derived.get(key, catalog.version, compute, options) : compute();

  const memoizeOnCatalogAsync = (key, catalog, compute, options) =>
    catalog.version ? derived.getAsync(key, catalog.version, compute, options) : compute();

  let everLoaded = false;
  let rewarmTimer = null;

  const load = async () => {
    const startedAt = performance.now();
    const catalog = await loader();
    if (!catalog || !Array.isArray(catalog.jobs) || !Array.isArray(catalog.searchIndex)) {
      throw new Error("Catalog loader returned an invalid result");
    }
    if (freezeEnabled()) deepFreeze(catalog);
    everLoaded = true;
    logger.log?.(
      `[Catalog] built ${catalog.jobs.length} jobs in ${(performance.now() - startedAt).toFixed(0)} ms`,
    );
    return catalog;
  };

  /** { jobs, searchIndex, builtAt, version, state } */
  const getCatalog = async () => {
    const entry = await cache.getOrLoadEntry(CATALOG_KEY, load);
    return {
      jobs: entry.value.jobs,
      searchIndex: entry.value.searchIndex,
      builtAt: entry.builtAt,
      version: entry.version,
      state: entry.state,
    };
  };

  /** Drop-in replacement for the old DB-backed function. Returns READ-ONLY data. */
  const getScrapedJobsForList = async (keyword = "") => {
    const catalog = await getCatalog();
    return filterCatalogByKeyword(catalog, keyword);
  };

  const warmCatalog = async () => {
    const catalog = await getCatalog();
    return { jobCount: catalog.jobs.length, builtAt: catalog.builtAt, state: catalog.state };
  };

  const scheduleRewarm = () => {
    if (rewarmDelayMs < 0 || !everLoaded) return; // never warm inside script/cron processes
    if (!(envMs("CATALOG_CACHE_TTL_MS", DEFAULT_TTL_MS) > 0)) return;
    clearTimeout(rewarmTimer);
    rewarmTimer = setTimeout(() => {
      warmCatalog().catch((error) => {
        logger.warn?.(`[Catalog] rewarm failed: ${error?.message}`);
      });
    }, rewarmDelayMs);
    rewarmTimer.unref?.();
  };

  /**
   * Call after writes made inside this process (sync, link check, cleanup,
   * source CRUD). Debounced rewarm so a burst of invalidations triggers one load.
   */
  const invalidateCatalog = (reason = "unspecified") => {
    cache.invalidate(CATALOG_KEY);
    logger.log?.(`[Catalog] invalidated (${reason})`);
    scheduleRewarm();
  };

  const getCatalogCacheStats = () => {
    const stats = cache.getStats();
    const entry = cache.peek(CATALOG_KEY);
    return {
      ...stats,
      jobCount: entry ? entry.value.jobs.length : null,
      builtAt: entry ? new Date(entry.builtAt).toISOString() : null,
      ageMs: entry ? entry.ageMs : null,
      version: entry ? entry.version : null,
      frozen: freezeEnabled(),
    };
  };

  const clearCatalogCache = () => {
    clearTimeout(rewarmTimer);
    cache.clear();
    derived.clear();
  };

  return {
    getCatalog,
    getScrapedJobsForList,
    warmCatalog,
    invalidateCatalog,
    getCatalogCacheStats,
    clearCatalogCache,
    memoizeOnCatalog,
    memoizeOnCatalogAsync,
  };
};

// Default app-wide instance.
const defaultService = createCatalogService();

export const getCatalog = defaultService.getCatalog;
export const getScrapedJobsForList = defaultService.getScrapedJobsForList;
export const warmCatalog = defaultService.warmCatalog;
export const invalidateCatalog = defaultService.invalidateCatalog;
export const getCatalogCacheStats = defaultService.getCatalogCacheStats;
export const clearCatalogCache = defaultService.clearCatalogCache;
export const memoizeOnCatalog = defaultService.memoizeOnCatalog;
export const memoizeOnCatalogAsync = defaultService.memoizeOnCatalogAsync;
