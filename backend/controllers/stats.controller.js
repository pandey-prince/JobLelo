import { JobSource } from "../models/jobSource.model.js";
import { getCatalog, memoizeOnCatalogAsync } from "../services/job-catalog/index.js";

// Stats are derived from the cached catalog; the small JobSource query is
// re-run at most once per STATS_TTL_MS.
const STATS_TTL_MS = 60 * 1000;

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const computePublicStats = async (visibleJobs, today) => {
  const totalJobs = visibleJobs.length;
  const jobsAddedToday = visibleJobs.filter(
    (job) => job.createdAt && new Date(job.createdAt) >= today,
  ).length;

  const companiesWithJobs = new Set(
    visibleJobs.map((job) => job.company?.name).filter(Boolean),
  ).size;

  const activeSources = await JobSource.find({ isActive: true }).select(
    "lastScrapeStatus lastScrapedAt",
  );
  const companiesMonitored = activeSources.length;
  const sourcesSyncedSuccessfully = activeSources.filter(
    (source) => source.lastScrapeStatus === "success",
  ).length;
  const lastSyncAt = activeSources.reduce((latest, source) => {
    if (!source.lastScrapedAt) return latest;
    if (!latest || source.lastScrapedAt > latest) return source.lastScrapedAt;
    return latest;
  }, null);

  return {
    totalJobs,
    scrapedJobs: totalJobs,
    companiesMonitored,
    companiesWithJobs,
    sourcesSyncedSuccessfully,
    lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
    jobsAddedToday,
    updatedAt: new Date().toISOString(),
  };
};

export const getPublicStats = async (req, res) => {
  try {
    const catalog = await getCatalog();
    const today = startOfToday();

    // The key includes the day so "jobs added today" rolls over at midnight.
    const stats = await memoizeOnCatalogAsync(
      `stats:public:${today.getTime()}`,
      catalog,
      () => computePublicStats(catalog.jobs, today),
      { ttlMs: STATS_TTL_MS },
    );

    return res.status(200).json({ success: true, stats });
  } catch (error) {
    console.error("[Stats] getPublicStats failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load stats",
    });
  }
};
