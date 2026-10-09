/**
 * Read-only benchmark for the job catalog (the pipeline behind /jobs, home, stats, companies).
 *
 * Usage (from backend/):
 *   node scripts/benchmark-catalog.js                       # DB/pipeline timing (needs MONGO_URI)
 *   BASE_URL=http://localhost:8000 node scripts/benchmark-catalog.js --http
 *   RUNS=10 node scripts/benchmark-catalog.js
 *
 * Works both BEFORE the cache change (baseline) and AFTER it:
 *   - "cold" runs bypass the cache (CATALOG_CACHE_TTL_MS=0 when the cache exists)
 *   - "warm" runs use the cache (first call primes, the rest are hits)
 *
 * Nothing is written to the database.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const RUNS = Math.max(1, Number(process.env.RUNS || 5));
const args = new Set(process.argv.slice(2));

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
  };
};

const fmt = (ms) => `${ms.toFixed(1)} ms`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const time = async (fn) => {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
};

const printStats = (label, values) => {
  const s = stats(values);
  console.log(
    `  ${label.padEnd(34)} min ${fmt(s.min).padStart(10)} | median ${fmt(s.median).padStart(10)} | max ${fmt(s.max).padStart(10)}`,
  );
};

const runHttpBenchmark = async () => {
  const base = (process.env.BASE_URL || "http://localhost:8000").replace(/\/$/, "");
  const endpoints = [
    "/api/v1/job/get?limit=30",
    "/api/v1/job/get?limit=30&keyword=react",
    "/api/v1/job/recommended?limit=12",
    "/api/v1/stats/public",
    "/api/v1/career-sources?withJobs=true&limit=20",
  ];

  console.log(`\nHTTP benchmark against ${base} (${RUNS} runs each; first call may be cold)\n`);
  for (const path of endpoints) {
    const timings = [];
    let bytes = 0;
    let status = 0;
    for (let i = 0; i < RUNS; i += 1) {
      const { ms, value } = await time(async () => {
        const res = await fetch(`${base}${path}`);
        const body = await res.text();
        status = res.status;
        bytes = Buffer.byteLength(body);
        return body;
      });
      void value;
      timings.push(ms);
    }
    console.log(`${path}  [status ${status}, ${(bytes / 1024).toFixed(1)} KB]`);
    console.log(`  first call: ${fmt(timings[0])}`);
    printStats("all runs", timings);
    if (timings.length > 1) printStats("excluding first (warm)", timings.slice(1));
  }
};

const runDbBenchmark = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is required (set it in backend/.env or the shell).");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB (read-only benchmark)\n");

  const { ScrapedJob } = await import("../models/scrapedJob.model.js");
  const { JobSource } = await import("../models/jobSource.model.js");
  const catalog = await import("../services/job-catalog/index.js");

  const [activeJobs, totalJobs, sources, activeSources] = await Promise.all([
    ScrapedJob.countDocuments({ status: "active" }),
    ScrapedJob.countDocuments({}),
    JobSource.countDocuments({}),
    JobSource.countDocuments({ isActive: true }),
  ]);
  console.log("Collection sizes");
  console.log(`  ScrapedJob active/total : ${activeJobs}/${totalJobs}`);
  console.log(`  JobSource active/total  : ${activeSources}/${sources}`);

  // Raw DB read cost (same select as the catalog loader)
  const rawTimes = [];
  for (let i = 0; i < RUNS; i += 1) {
    const { ms } = await time(() =>
      ScrapedJob.find({ status: "active" })
        .select(
          "title description location jobType salary requirements applicationUrl companyName companyLogo firstSeenAt status source",
        )
        .sort({ firstSeenAt: -1 })
        .limit(5000)
        .lean(),
    );
    rawTimes.push(ms);
  }
  console.log("\nRaw DB read (single query, up to 5000 docs)");
  printStats("find().limit(5000)", rawTimes);

  // Cold: bypass the cache if it exists (no-op before the cache change)
  const previousTtl = process.env.CATALOG_CACHE_TTL_MS;
  process.env.CATALOG_CACHE_TTL_MS = "0";
  const coldTimes = [];
  let jobs = [];
  const memBefore = process.memoryUsage();
  for (let i = 0; i < RUNS; i += 1) {
    const { ms, value } = await time(() => catalog.getScrapedJobsForList(""));
    coldTimes.push(ms);
    jobs = value;
  }
  console.log("\nFull catalog pipeline, COLD (DB load + filters + dedupe + map)");
  printStats("getScrapedJobsForList('')", coldTimes);
  console.log(`  visible jobs after filters: ${jobs.length}`);

  const sample = jobs.slice(0, 30);
  const fullBytes = Buffer.byteLength(JSON.stringify(jobs));
  const pageBytes = Buffer.byteLength(JSON.stringify(sample));
  console.log(`  serialised full list: ${(fullBytes / 1024).toFixed(0)} KB | one 30-job page: ${(pageBytes / 1024).toFixed(0)} KB`);

  // Warm: use the cache if it exists (before the change this equals cold)
  if (previousTtl === undefined) delete process.env.CATALOG_CACHE_TTL_MS;
  else process.env.CATALOG_CACHE_TTL_MS = previousTtl;
  const warmTimes = [];
  for (let i = 0; i < RUNS + 1; i += 1) {
    const { ms } = await time(() => catalog.getScrapedJobsForList(""));
    warmTimes.push(ms);
  }
  console.log("\nCatalog read, WARM (cache enabled; equals cold before the cache change)");
  console.log(`  first call (primes cache): ${fmt(warmTimes[0])}`);
  printStats("subsequent calls", warmTimes.slice(1));

  const kwTimes = [];
  for (let i = 0; i < RUNS; i += 1) {
    const { ms } = await time(() => catalog.getScrapedJobsForList("react"));
    kwTimes.push(ms);
  }
  console.log("\nKeyword search ('react')");
  printStats("getScrapedJobsForList('react')", kwTimes);

  const memAfter = process.memoryUsage();
  console.log("\nMemory");
  console.log(`  heapUsed before/after: ${mb(memBefore.heapUsed)} -> ${mb(memAfter.heapUsed)}`);
  console.log(`  rss now: ${mb(memAfter.rss)}`);

  await mongoose.disconnect();
};

const main = async () => {
  console.log("=== JobLeLo catalog benchmark ===");
  console.log(`runs per measurement: ${RUNS}`);
  if (args.has("--http")) {
    await runHttpBenchmark();
  } else {
    await runDbBenchmark();
  }
};

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
