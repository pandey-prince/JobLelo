import { filterItJobs } from "../../utils/itJobFilter.js";
import { attachBadgesToJob } from "../../utils/jobBadges.js";
import { createCache, deepFreeze, envMs } from "../../utils/memoryCache.js";

const stripHtml = (value = "") =>
  value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const blockedExternalTerms = [
  "adult",
  "nsfw",
  "casino",
  "gambling",
  "dating",
  "crypto",
  "betting",
];

const isDemoFriendlyJob = (job) => {
  const text = [
    job.title,
    job.company_name,
    job.companyName,
    job.category,
    job.description,
    ...(job.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return !blockedExternalTerms.some((term) => text.includes(term));
};

const matchesExternalKeyword = (job, keyword = "") => {
  if (!keyword) return true;
  const query = keyword.toLowerCase();
  return [
    job.title,
    job.company_name,
    job.companyName,
    job.category,
    job.location,
    job.candidate_required_location,
    ...(job.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
};

export const mapRemotiveJob = (job) =>
  attachBadgesToJob(
    {
      _id: `remotive-${job.id}`,
      title: job.title,
      description: stripHtml(job.description).slice(0, 260),
      requirements: job.tags || [],
      experienceLevel: job.category || "Remote",
      salary: job.salary && job.salary !== "-" ? job.salary : "Not disclosed",
      location: job.candidate_required_location || "Remote / Worldwide",
      jobType: job.job_type?.replace("_", " ") || "Remote",
      position: 1,
      company: {
        name: job.company_name || "Remote Company",
        logo: job.company_logo || "",
      },
      createdAt: job.publication_date
        ? new Date(job.publication_date).toISOString()
        : new Date().toISOString(),
      applications: [],
      external: true,
      externalSource: "Remotive",
      applicationLink: job.url,
    },
    { sourceType: "remotive", sourceLabel: "Remotive" },
  );

export const mapArbeitnowJob = (job) =>
  attachBadgesToJob(
    {
      _id: `arbeitnow-${job.slug}`,
      title: job.title,
      description: stripHtml(job.description).slice(0, 260),
      requirements: job.tags || [],
      experienceLevel: job.job_types?.join(", ") || "Open",
      salary: "Not disclosed",
      location: job.remote ? "Remote" : job.location || "Europe",
      jobType: job.job_types?.[0] || (job.remote ? "Remote" : "On-site"),
      position: 1,
      company: {
        name: job.company_name || "Hiring Company",
        logo: "",
      },
      createdAt: job.created_at
        ? new Date(job.created_at * 1000).toISOString()
        : new Date().toISOString(),
      applications: [],
      external: true,
      externalSource: "Arbeitnow",
      applicationLink: job.url,
    },
    { sourceType: "arbeitnow", sourceLabel: "Arbeitnow" },
  );

const REMOTIVE_IT_CATEGORIES = ["software-dev", "devops-sysadmin", "data", "qa"];

const fetchRemotiveJobs = async (keyword = "") => {
  try {
    const requests = REMOTIVE_IT_CATEGORIES.map(async (category) => {
      const url = new URL("https://remotive.com/api/remote-jobs");
      url.searchParams.set("category", category);
      if (keyword) url.searchParams.set("search", keyword);

      const response = await fetch(url);
      if (!response.ok) return [];

      const data = await response.json();
      return Array.isArray(data.jobs) ? data.jobs : [];
    });

    const results = await Promise.all(requests);
    const uniqueJobs = new Map();

    results.flat().forEach((job) => {
      if (isDemoFriendlyJob(job) && matchesExternalKeyword(job, keyword)) {
        uniqueJobs.set(job.id, job);
      }
    });

    return filterItJobs([...uniqueJobs.values()])
      .slice(0, 10)
      .map(mapRemotiveJob);
  } catch {
    return [];
  }
};

const fetchArbeitnowJobs = async (keyword = "") => {
  try {
    const response = await fetch("https://arbeitnow.com/api/job-board-api");
    if (!response.ok) return [];

    const data = await response.json();
    const query = keyword.toLowerCase();
    return Array.isArray(data.data)
      ? filterItJobs(
          data.data.filter(isDemoFriendlyJob).filter((job) => matchesExternalKeyword(job, query)),
        )
          .slice(0, 8)
          .map(mapArbeitnowJob)
      : [];
  } catch {
    return [];
  }
};

export const fetchExternalJobs = async (keyword = "") => {
  const [remotiveJobs, arbeitnowJobs] = await Promise.all([
    fetchRemotiveJobs(keyword),
    fetchArbeitnowJobs(keyword),
  ]);
  return [...remotiveJobs, ...arbeitnowJobs].slice(0, 14);
};

/**
 * Remotive / Arbeitnow only offer "download the whole listing", so looking up one
 * job used to re-download everything on every call (job detail page, and once per
 * saved/dismissed external job). We now keep an id -> mapped job index per provider.
 *
 * Env:
 *   EXTERNAL_JOBS_CACHE_TTL_MS    fresh window, default 1200000 (20 min); 0 disables
 *   EXTERNAL_JOBS_CACHE_STALE_MS  serve-stale limit, default 21600000 (6 h)
 */
const externalCache = createCache({
  name: "external-jobs",
  ttlMs: () => envMs("EXTERNAL_JOBS_CACHE_TTL_MS", 20 * 60 * 1000),
  staleMs: () => envMs("EXTERNAL_JOBS_CACHE_STALE_MS", 6 * 60 * 60 * 1000),
  max: 4,
});

// If an id is missing from a listing older than this, reload once (new jobs appear between refreshes).
const MISS_REFRESH_AFTER_MS = 2 * 60 * 1000;

const freezeExternal = (index) => {
  if (process.env.NODE_ENV !== "production") deepFreeze([...index.values()]);
  return index;
};

const loadRemotiveIndex = async () => {
  const response = await fetch("https://remotive.com/api/remote-jobs");
  if (!response.ok) throw new Error(`Remotive responded with ${response.status}`);
  const data = await response.json();
  const index = new Map();
  for (const job of data.jobs || []) {
    const key = String(job.id);
    if (!index.has(key)) index.set(key, mapRemotiveJob(job)); // first match wins, like Array.find
  }
  return freezeExternal(index);
};

const loadArbeitnowIndex = async () => {
  const response = await fetch("https://arbeitnow.com/api/job-board-api");
  if (!response.ok) throw new Error(`Arbeitnow responded with ${response.status}`);
  const data = await response.json();
  const index = new Map();
  for (const job of data.data || []) {
    const key = String(job.slug);
    if (!index.has(key)) index.set(key, mapArbeitnowJob(job)); // first match wins, like Array.find
  }
  return freezeExternal(index);
};

const lookupExternalJob = async (cacheKey, loader, id) => {
  try {
    let entry = await externalCache.getOrLoadEntry(cacheKey, loader);
    let job = entry.value.get(id);

    const cachedAndOld =
      entry.state !== "miss" &&
      entry.state !== "bypass" &&
      Date.now() - entry.builtAt > MISS_REFRESH_AFTER_MS;

    if (!job && cachedAndOld) {
      externalCache.invalidate(cacheKey);
      entry = await externalCache.getOrLoadEntry(cacheKey, loader);
      job = entry.value.get(id);
    }

    // Shallow copy: callers get their own top-level object.
    return job ? { ...job } : null;
  } catch {
    return null;
  }
};

export const fetchExternalJobById = async (jobId) => {
  if (jobId.startsWith("remotive-")) {
    return lookupExternalJob("remotive", loadRemotiveIndex, jobId.replace("remotive-", ""));
  }

  if (jobId.startsWith("arbeitnow-")) {
    return lookupExternalJob("arbeitnow", loadArbeitnowIndex, jobId.replace("arbeitnow-", ""));
  }

  return null;
};

export const getExternalCacheStats = () => externalCache.getStats();
export const clearExternalCache = () => externalCache.clear();

export const isExternalJobId = (jobId = "") =>
  jobId.startsWith("remotive-") || jobId.startsWith("arbeitnow-");
