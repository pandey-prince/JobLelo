import { JobSource } from "../models/jobSource.model.js";
import { ScrapedJob } from "../models/scrapedJob.model.js";
import { runScraper } from "./scrapers/index.js";
import { filterItJobs, isItJob } from "../utils/itJobFilter.js";
import { filterIndiaJobs, isIndiaJob } from "../utils/indiaJobFilter.js";
import { processWatchlistAlerts } from "./watchlistAlert.service.js";
import { hardDeleteScrapedJob, hardDeleteScrapedJobsByQuery } from "./scrapedJobCleanup.service.js";
import { checkActiveJobLinks } from "./linkCheck.service.js";
import { dedupeScrapedJobs } from "./job-catalog/index.js";
import { withCatalogInvalidation } from "./job-catalog/index.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCRAPE_DELAY_MS = Number(process.env.SCRAPE_DELAY_MS || 1500);
const PUPPETEER_DELAY_MS = Number(process.env.PUPPETEER_DELAY_MS || 3000);
const MAX_UPSERTS_PER_SOURCE = Number(
  process.env.MAX_UPSERTS_PER_SOURCE || process.env.MAX_JOBS_PER_SOURCE || 0,
);
const LINK_CHECK_AFTER_SYNC = process.env.LINK_CHECK_AFTER_SYNC !== "false";

const shouldSkipPuppeteer = () =>
  process.env.SKIP_PUPPETEER_SCRAPERS === "true" ||
  process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD === "true";

const limitUpserts = (jobs) => {
  if (!MAX_UPSERTS_PER_SOURCE || MAX_UPSERTS_PER_SOURCE <= 0) return jobs;
  return jobs.slice(0, MAX_UPSERTS_PER_SOURCE);
};

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Active job elsewhere with same company+title or same application URL. */
export const findActiveCrossSourceDuplicate = async (
  job,
  excludeSourceId,
) => {
  const company = String(job.companyName || "").trim();
  const title = String(job.title || "").trim();
  const url = String(job.applicationUrl || "").trim();
  const or = [];

  if (company && title) {
    or.push({
      companyName: new RegExp(`^${escapeRegex(company)}$`, "i"),
      title: new RegExp(`^${escapeRegex(title)}$`, "i"),
    });
  }
  if (url) {
    or.push({ applicationUrl: url });
  }
  if (!or.length) return null;

  const query = {
    status: "active",
    $or: or,
  };
  if (excludeSourceId) {
    query.source = { $ne: excludeSourceId };
  }

  return ScrapedJob.findOne(query).select(
    "_id companyName title applicationUrl source",
  );
};

export const syncSource = async (source) => {
  if (
    shouldSkipPuppeteer() &&
    (source.scraperType === "auto-puppeteer" || source.scraperType === "puppeteer")
  ) {
    return {
      sourceId: source._id,
      sourceName: source.name,
      success: true,
      skipped: true,
      reason: "Puppeteer scrapers disabled on this host",
      newJobsCount: 0,
      updatedJobsCount: 0,
      removedJobsCount: 0,
    };
  }

  if (!source.isActive || source.scraperType === "unsupported") {
    return {
      sourceId: source._id,
      sourceName: source.name,
      success: true,
      skipped: true,
      reason: "Source inactive or unsupported",
      newJobsCount: 0,
      updatedJobsCount: 0,
      removedJobsCount: 0,
    };
  }

  const now = new Date();
  let newJobsCount = 0;
  let updatedJobsCount = 0;
  let removedJobsCount = 0;
  let duplicateSkippedCount = 0;
  const newJobs = [];

  try {
    const { jobs: rawJobs, usedSelectors } = await runScraper(source);
    const rawByExternalId = new Map(rawJobs.map((job) => [job.externalId, job]));
    const allScrapedJobs = dedupeScrapedJobs(filterIndiaJobs(filterItJobs(rawJobs)));
    const seenExternalIds = new Set(allScrapedJobs.map((job) => job.externalId));
    const jobsToUpsert = limitUpserts(allScrapedJobs);

    for (const job of jobsToUpsert) {
      const existing = await ScrapedJob.findOne({
        source: source._id,
        externalId: job.externalId,
      });

      if (existing) {
        existing.title = job.title;
        existing.description = job.description;
        existing.location = job.location;
        existing.jobType = job.jobType;
        existing.salary = job.salary;
        existing.experienceLevel = job.experienceLevel || "";
        existing.requirements = job.requirements;
        existing.applicationUrl = job.applicationUrl;
        existing.companyName = job.companyName;
        existing.companyLogo = job.companyLogo;
        existing.lastSeenAt = now;
        existing.status = "active";
        await existing.save();
        updatedJobsCount += 1;
        continue;
      }

      const crossDup = await findActiveCrossSourceDuplicate(job, source._id);
      if (crossDup) {
        duplicateSkippedCount += 1;
        continue;
      }

      const created = await ScrapedJob.create({
        ...job,
        source: source._id,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "active",
      });
      newJobs.push(created);
      newJobsCount += 1;
    }

    const staleJobs = await ScrapedJob.find({
      source: source._id,
      status: "active",
      externalId: { $nin: [...seenExternalIds] },
    });

    for (const staleJob of staleJobs) {
      const rawJob = rawByExternalId.get(staleJob.externalId);
      let reason = "missing_from_board";
      if (rawJob) {
        reason = !isItJob(rawJob) ? "non_it" : "non_india";
      }
      await hardDeleteScrapedJob(staleJob, reason);
      removedJobsCount += 1;
    }

    source.lastScrapedAt = now;
    source.lastScrapeStatus = "success";
    source.lastScrapeError = "";
    source.jobsFoundCount = allScrapedJobs.length;

    // Persist winning Puppeteer selectors for the next daily run (never auto-disable).
    if (
      usedSelectors?.jobList &&
      (source.scraperType === "auto-puppeteer" || source.scraperType === "puppeteer")
    ) {
      source.selectors = {
        ...(source.selectors?.toObject?.() || source.selectors || {}),
        ...usedSelectors,
      };
    }

    await source.save();

    return {
      sourceId: source._id,
      sourceName: source.name,
      success: true,
      jobsFound: allScrapedJobs.length,
      jobsUpserted: jobsToUpsert.length,
      newJobsCount,
      updatedJobsCount,
      removedJobsCount,
      duplicateSkippedCount,
      newJobs,
    };
  } catch (error) {
    const message = error.message || "Unknown scrape error";
    // Empty/gone boards should clear listings; timeouts/5xx keep last good jobs
    const emptyBoard =
      /\b(404|410)\b/.test(message) ||
      /no jobs found|could not find job listings|couldn't find anything|document not found|board_gone/i.test(
        message,
      );

    source.lastScrapedAt = now;
    source.lastScrapeError = message;

    // Career board empty/deleted — clear ghost listings so the site matches reality
    if (emptyBoard) {
      removedJobsCount = await hardDeleteScrapedJobsByQuery(
        { source: source._id, status: "active" },
        "board_gone",
      );
      source.lastScrapeStatus = "success";
      source.jobsFoundCount = 0;
      source.lastScrapeError = `${message}; cleared ${removedJobsCount} stale jobs`;
      await source.save();

      return {
        sourceId: source._id,
        sourceName: source.name,
        success: true,
        jobsFound: 0,
        newJobsCount: 0,
        updatedJobsCount: 0,
        removedJobsCount,
        duplicateSkippedCount: 0,
        boardGone: true,
      };
    }

    source.lastScrapeStatus = "error";
    await source.save();

    return {
      sourceId: source._id,
      sourceName: source.name,
      success: false,
      error: message,
      newJobsCount,
      updatedJobsCount,
      removedJobsCount,
      duplicateSkippedCount,
    };
  }
};

const PUPPETEER_SCRAPER_TYPES = new Set(["auto-puppeteer", "puppeteer"]);

export const isPuppeteerScraperType = (scraperType) =>
  PUPPETEER_SCRAPER_TYPES.has(scraperType);

const filterSourcesByMode = (sources, mode) => {
  if (mode === "api") {
    return sources.filter((source) => !isPuppeteerScraperType(source.scraperType));
  }
  if (mode === "puppeteer") {
    return sources.filter((source) => isPuppeteerScraperType(source.scraperType));
  }
  return sources;
};

/** Stable bucket 0..bucketCount-1 from Mongo id (or string fallback). */
export const puppeteerBucketForId = (id, bucketCount = 3) => {
  const str = String(id || "");
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash % bucketCount;
};

const filterSourcesByBucket = (sources, bucketIndex, bucketCount) => {
  if (
    bucketCount === undefined ||
    bucketCount === null ||
    bucketCount <= 1 ||
    bucketIndex === undefined ||
    bucketIndex === null ||
    !Number.isInteger(bucketIndex) ||
    !Number.isInteger(bucketCount)
  ) {
    return sources;
  }

  return sources.filter(
    (source) => puppeteerBucketForId(source._id, bucketCount) === bucketIndex,
  );
};

const runSyncLoop = async (sources) => {
  const results = [];
  let removedFromBoard = 0;
  const total = sources.length;

  console.log(`[ScrapeSync] starting loop for ${total} source(s)`);

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const label = `${index + 1}/${total}`;
    const startedAt = Date.now();
    console.log(
      `[ScrapeSync] (${label}) start "${source.companyName}" [${source.scraperType}] ${source.url}`,
    );

    const result = await syncSource(source);
    results.push(result);
    removedFromBoard += result.removedJobsCount || 0;

    const elapsedMs = Date.now() - startedAt;
    if (result.skipped) {
      console.log(
        `[ScrapeSync] (${label}) skip "${source.companyName}" reason=${result.reason || "n/a"} (${elapsedMs}ms)`,
      );
    } else if (result.success) {
      console.log(
        `[ScrapeSync] (${label}) ok "${source.companyName}" found=${result.jobsFound ?? 0} new=${result.newJobsCount ?? 0} removed=${result.removedJobsCount ?? 0} (${elapsedMs}ms)`,
      );
    } else {
      console.warn(
        `[ScrapeSync] (${label}) fail "${source.companyName}": ${result.error || "unknown"} (${elapsedMs}ms)`,
      );
    }

    const delayMs = isPuppeteerScraperType(source.scraperType)
      ? PUPPETEER_DELAY_MS
      : SCRAPE_DELAY_MS;
    await delay(delayMs);
  }

  return { results, removedFromBoard };
};

const syncSourcesByModeImpl = async (mode = "all", options = {}) => {
  const {
    runPostSyncTasks = mode !== "puppeteer",
    bucketIndex,
    bucketCount,
    shardIndex,
    shardCount,
  } = options;
  const resolvedBucketIndex =
    bucketIndex !== undefined && bucketIndex !== null ? bucketIndex : shardIndex;
  const resolvedBucketCount =
    bucketCount !== undefined && bucketCount !== null ? bucketCount : shardCount;

  const allSources = await JobSource.find({ isActive: true });
  const modeSources = filterSourcesByMode(allSources, mode);
  const sources = filterSourcesByBucket(
    modeSources,
    resolvedBucketIndex,
    resolvedBucketCount,
  );
  const usingBucketsPreview =
    Number.isInteger(resolvedBucketCount) &&
    resolvedBucketCount > 1 &&
    Number.isInteger(resolvedBucketIndex);
  console.log(
    `[ScrapeSync] mode=${mode}${usingBucketsPreview ? ` bucket=${resolvedBucketIndex}/${resolvedBucketCount}` : ""} queued=${sources.length}/${modeSources.length} active puppeteer/api pool`,
  );
  const { results, removedFromBoard } = await runSyncLoop(sources);

  let ineligibleRemoved = 0;
  let linkCheckSummary = null;

  if (runPostSyncTasks) {
    ineligibleRemoved = await cleanupIneligibleScrapedJobs();

    if (LINK_CHECK_AFTER_SYNC) {
      try {
        linkCheckSummary = await checkActiveJobLinks({
          limit: Number(process.env.LINK_CHECK_POST_SYNC_BATCH || 30),
          onlyStaleHours: 24,
        });
      } catch (error) {
        console.error("[ScrapeSync] Post-sync link check failed:", error.message);
      }
    }
  }

  const usingBuckets =
    Number.isInteger(resolvedBucketCount) &&
    resolvedBucketCount > 1 &&
    Number.isInteger(resolvedBucketIndex);

  const summary = {
    mode,
    bucketIndex: usingBuckets ? resolvedBucketIndex : null,
    bucketCount: usingBuckets ? resolvedBucketCount : null,
    totalSources: sources.length,
    successful: results.filter((r) => r.success && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.success).length,
    newJobsCount: results.reduce((sum, r) => sum + (r.newJobsCount || 0), 0),
    removedFromBoard,
    removedNonIt: ineligibleRemoved,
    removedIneligible: ineligibleRemoved,
    removedDeadLinks: linkCheckSummary?.deleted || 0,
    linkChecksRun: linkCheckSummary?.checked || 0,
    results,
    linkCheckSummary,
  };

  console.log(
    `[ScrapeSync] ${mode} completed${usingBuckets ? ` (bucket ${resolvedBucketIndex}/${resolvedBucketCount})` : ""}: ${summary.successful}/${summary.totalSources} sources, ${summary.newJobsCount} new jobs, ${summary.removedFromBoard} removed from board`,
  );

  if (runPostSyncTasks) {
    try {
      await processWatchlistAlerts(results);
    } catch (error) {
      console.error("[ScrapeSync] Watchlist alerts failed:", error.message);
    }
  }

  return summary;
};

export const syncAllSources = async () => syncSourcesByMode("all");

const syncSourceByIdImpl = async (sourceId) => {
  const source = await JobSource.findById(sourceId);
  if (!source) {
    throw new Error("Job source not found");
  }
  const result = await syncSource(source);
  try {
    await processWatchlistAlerts([result]);
  } catch (error) {
    console.error("[ScrapeSync] Watchlist alerts failed:", error.message);
  }
  return result;
};

const syncPriorityPuppeteerSourcesImpl = async (options = {}) => {
  const { runPostSyncTasks = true } = options;
  const maxSources = Math.max(
    1,
    Number(options.maxSources ?? process.env.PUPPETEER_PRIORITY_MAX ?? 8),
  );

  const sources = await JobSource.find({
    isActive: true,
    priorityPuppeteerSync: true,
    scraperType: { $in: [...PUPPETEER_SCRAPER_TYPES] },
  })
    .sort({ updatedAt: 1 })
    .limit(maxSources);

  const queuedTotal = await JobSource.countDocuments({
    isActive: true,
    priorityPuppeteerSync: true,
    scraperType: { $in: [...PUPPETEER_SCRAPER_TYPES] },
  });

  if (queuedTotal > sources.length) {
    console.log(
      `[ScrapeSync] puppeteer-priority: processing ${sources.length}/${queuedTotal} queued (cap ${maxSources})`,
    );
  }

  const results = [];

  for (const source of sources) {
    const result = await syncSource(source);
    results.push(result);

    // Always dequeue after an attempt so failures cannot monopolize every GHA run.
    source.priorityPuppeteerSync = false;
    await source.save();

    await delay(PUPPETEER_DELAY_MS);
  }

  const summary = {
    mode: "puppeteer-priority",
    totalSources: sources.length,
    queuedTotal,
    maxSources,
    successful: results.filter((r) => r.success && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.success).length,
    newJobsCount: results.reduce((sum, r) => sum + (r.newJobsCount || 0), 0),
    results,
  };

  console.log(
    `[ScrapeSync] puppeteer-priority completed: ${summary.successful}/${summary.totalSources} sources, ${summary.newJobsCount} new jobs`,
  );

  if (runPostSyncTasks && results.length > 0) {
    try {
      await processWatchlistAlerts(results);
    } catch (error) {
      console.error("[ScrapeSync] Watchlist alerts failed:", error.message);
    }
  }

  return summary;
};

const normalizeDedupeKey = (value = "") =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\/$/, "");

const cleanupIneligibleScrapedJobs = async () => {
  const activeJobs = await ScrapedJob.find({ status: "active" }).sort({
    firstSeenAt: -1,
  });
  let removedCount = 0;

  for (const job of activeJobs) {
    if (!isItJob(job)) {
      await hardDeleteScrapedJob(job, "non_it");
      removedCount += 1;
      continue;
    }

    if (!isIndiaJob(job)) {
      await hardDeleteScrapedJob(job, "non_india");
      removedCount += 1;
    }
  }

  const remaining = await ScrapedJob.find({ status: "active" }).sort({
    firstSeenAt: -1,
  });
  const seenCompanyTitle = new Set();
  const seenUrls = new Set();

  for (const job of remaining) {
    const companyTitleKey = `${normalizeDedupeKey(job.companyName)}::${normalizeDedupeKey(job.title)}`;
    const urlKey = normalizeDedupeKey(job.applicationUrl);
    if (
      seenCompanyTitle.has(companyTitleKey) ||
      (urlKey && seenUrls.has(urlKey))
    ) {
      await hardDeleteScrapedJob(job, "duplicate");
      removedCount += 1;
      continue;
    }
    seenCompanyTitle.add(companyTitleKey);
    if (urlKey) seenUrls.add(urlKey);
  }

  return removedCount;
};

// In-process writers drop the cached job catalog when they finish. Writers that run
// in other processes (GitHub Actions) can't call this, so the catalog also has a TTL.
export const syncSourcesByMode = withCatalogInvalidation("scrape-sync", syncSourcesByModeImpl);
export const syncSourceById = withCatalogInvalidation("scrape-sync:source", syncSourceByIdImpl);
export const syncPriorityPuppeteerSources = withCatalogInvalidation(
  "scrape-sync:priority-puppeteer",
  syncPriorityPuppeteerSourcesImpl,
);
