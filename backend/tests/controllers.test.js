import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { raw, oid, sourceA, sourceB, hiddenSource } from "./helpers/fixtures.js";
import { stubDb, mockRes } from "./helpers/stubDb.js";
import { clearCatalogCache, getCatalogCacheStats } from "../services/job-catalog/index.js";
import { getAllJobs, getRecommendedJobs } from "../controllers/job.controller.js";
import { getPublicStats } from "../controllers/stats.controller.js";
import { listPublicSources } from "../controllers/careerSource.controller.js";
import { listScrapedJobs } from "../controllers/scrapedJob.controller.js";

const jobs = () => [
  raw({ title: "Software Engineer - React", companyName: "Acme", location: "Hyderabad, India", experienceLevel: "0" }),
  raw({ title: "Backend Developer", companyName: "Globex", location: "Pune, India", source: sourceB }),
  raw({ title: "Data Engineer", companyName: "Initech", location: "Noida, India" }),
  raw({ title: "C++ Developer", companyName: "Umbrella", location: "Chennai, India" }),
  raw({ title: "Software Engineer II", companyName: "Acme", location: "Bengaluru, India" }),
  raw({ title: "Sales Manager", companyName: "Acme", location: "Mumbai, India", description: "Sell." }),
  raw({ title: "Software Engineer", companyName: "Foreign Inc", location: "Berlin, Germany" }),
  raw({ title: "Software Engineer Hidden", companyName: "Ghost", location: "Pune, India", source: hiddenSource }),
];

const sources = () => [
  { _id: sourceA, companyName: "Acme", name: "Acme", url: "https://acme.example/careers", isPublic: true, isActive: true, lastScrapeStatus: "success", lastScrapedAt: new Date("2026-10-09T10:00:00Z") },
  { _id: sourceB, companyName: "Globex", name: "Globex", url: "https://globex.example/careers", isPublic: true, isActive: true, lastScrapeStatus: "success", lastScrapedAt: new Date("2026-10-09T12:00:00Z") },
  { _id: hiddenSource, companyName: "Ghost", name: "Ghost", url: "https://ghost.example", isPublic: true, isActive: true, lastScrapeStatus: "error", lastScrapeError: "404 not found", lastScrapedAt: new Date() },
];

let db;
beforeEach(() => {
  clearCatalogCache();
  delete process.env.CATALOG_CACHE_TTL_MS;
});
afterEach(() => {
  db?.restore();
  clearCatalogCache();
});

const call = async (handler, req) => {
  const res = mockRes();
  await handler({ query: {}, ...req }, res);
  return res;
};

test("/job/get: filters, sort and pagination work on the cached list", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });

  const all = await call(getAllJobs, { query: { limit: "2", sortBy: "newest" } });
  assert.equal(all.statusCode, 200);
  assert.equal(all.body.jobs.length, 2);
  assert.equal(all.body.pagination.total, 5); // 5 visible: IT + India + not hidden
  assert.equal(all.body.pagination.totalPages, 3);

  const pune = await call(getAllJobs, { query: { locations: "Pune" } });
  assert.deepEqual(pune.body.jobs.map((j) => j.title), ["Backend Developer"]);

  const byCompany = await call(getAllJobs, { query: { sortBy: "company", limit: "48" } });
  const companies = byCompany.body.jobs.map((j) => j.company.name);
  assert.deepEqual(companies, [...companies].sort((a, b) => a.localeCompare(b)));

  const page2 = await call(getAllJobs, { query: { limit: "2", page: "2", sortBy: "newest" } });
  assert.equal(page2.body.jobs.length, 2);
  assert.notDeepEqual(page2.body.jobs.map((j) => j._id), all.body.jobs.map((j) => j._id));
});

test("/job/get: hidden-source, non-IT and non-India jobs never appear", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });
  const res = await call(getAllJobs, { query: { limit: "48" } });
  const titles = res.body.jobs.map((j) => j.title);
  assert.ok(!titles.includes("Software Engineer Hidden"));
  assert.ok(!titles.includes("Sales Manager"));
  assert.ok(!titles.some((t) => t === "Software Engineer")); // Berlin
});

test("/job/get: keyword is plain text (c++, regex chars) and never 500s", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });
  const cpp = await call(getAllJobs, { query: { keyword: "c++" } });
  assert.equal(cpp.statusCode, 200);
  assert.deepEqual(cpp.body.jobs.map((j) => j.title), ["C++ Developer"]);

  for (const keyword of ["(a+)+$", ".*", "[oops", "\\"]) {
    const res = await call(getAllJobs, { query: { keyword } });
    assert.equal(res.statusCode, 200, `keyword ${keyword}`);
    assert.equal(res.body.jobs.length, 0);
  }

  const react = await call(getAllJobs, { query: { keyword: "REACT" } });
  assert.deepEqual(react.body.jobs.map((j) => j.title), ["Software Engineer - React"]);
});

test("/job/get: dismissed jobs are removed per user and never leak into the shared cache", async () => {
  const userId = oid();
  db = stubDb({ jobs: jobs(), sources: sources() });

  const guestBefore = await call(getAllJobs, { query: { limit: "48" } });
  const dismissedKey = guestBefore.body.jobs.find((j) => j.title === "Data Engineer")._id;
  db.restore();
  db = stubDb({ jobs: jobs(), sources: sources(), dismissed: { [String(userId)]: [dismissedKey] } });

  const mine = await call(getAllJobs, { id: userId, query: { limit: "48" } });
  assert.ok(!mine.body.jobs.some((j) => j.title === "Data Engineer"));
  assert.equal(mine.body.pagination.total, guestBefore.body.pagination.total - 1);

  const guestAfter = await call(getAllJobs, { query: { limit: "48" } });
  assert.ok(guestAfter.body.jobs.some((j) => j.title === "Data Engineer"), "guest still sees it");
  assert.equal(guestAfter.body.pagination.total, guestBefore.body.pagination.total);
});

test("/job/recommended: guest result is memoised; personalised results use the profile", async () => {
  const userId = oid();
  db = stubDb({ jobs: jobs(), sources: sources(), profiles: { [String(userId)]: { skills: ["react"], preferredJobRoles: [] } } });

  const g1 = await call(getRecommendedJobs, { query: { limit: "3" } });
  const g2 = await call(getRecommendedJobs, { query: { limit: "3" } });
  assert.equal(g1.body.personalized, false);
  assert.equal(g1.body.jobs.length, 3);
  assert.strictEqual(g1.body.jobs, g2.body.jobs, "memoised guest list");

  const mine = await call(getRecommendedJobs, { id: userId, query: { limit: "3" } });
  assert.equal(mine.body.personalized, true);
  assert.equal(mine.body.jobs[0].title, "Software Engineer - React");

  const g3 = await call(getRecommendedJobs, { query: { limit: "3" } });
  assert.strictEqual(g3.body.jobs, g1.body.jobs, "personalised call did not disturb guest cache");
});

test("/stats/public: correct numbers and the JobSource query is not repeated within the TTL", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });

  const first = await call(getPublicStats, {});
  assert.equal(first.statusCode, 200);
  const { stats } = first.body;
  assert.equal(stats.totalJobs, 5);
  assert.equal(stats.companiesWithJobs, 4); // Acme, Globex, Initech, Umbrella
  assert.equal(stats.companiesMonitored, 3);
  assert.equal(stats.sourcesSyncedSuccessfully, 2);
  assert.ok(stats.lastSyncAt, "lastSyncAt is the newest lastScrapedAt");

  const activeQueriesBefore = db.calls.jobSourceFind.filter((q) => q.isActive === true && q.isPublic === undefined).length;
  const second = await call(getPublicStats, {});
  const activeQueriesAfter = db.calls.jobSourceFind.filter((q) => q.isActive === true && q.isPublic === undefined).length;
  assert.equal(activeQueriesAfter, activeQueriesBefore, "no extra JobSource query on a memo hit");
  assert.deepEqual(second.body.stats, stats);
});

test("/career-sources?withJobs=true: grouped by company, careers URL attached, search + pagination", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });

  const res = await call(listPublicSources, { query: { withJobs: "true", limit: "2" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pagination.total, 4);
  assert.deepEqual(res.body.sources.map((s) => s.companyName), ["Acme", "Globex"]);
  const acme = res.body.sources[0];
  assert.equal(acme.activeJobCount, 2);
  assert.equal(acme.url, "https://acme.example/careers");
  assert.equal(acme.jobs.length, 2);

  const page2 = await call(listPublicSources, { query: { withJobs: "true", limit: "2", page: "2" } });
  assert.deepEqual(page2.body.sources.map((s) => s.companyName), ["Initech", "Umbrella"]);
  assert.equal(page2.body.sources[0].url, ""); // no JobSource for Initech

  const search = await call(listPublicSources, { query: { withJobs: "true", search: "glob" } });
  assert.deepEqual(search.body.sources.map((s) => s.companyName), ["Globex"]);

  const special = await call(listPublicSources, { query: { withJobs: "true", search: "c++" } });
  assert.equal(special.statusCode, 200);
});

test("/scraped-jobs: keyword search is served from the cache", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });
  const res = await call(listScrapedJobs, { query: { keyword: "initech" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.jobs.map((j) => j.title), ["Data Engineer"]);
});

test("one DB load serves every endpoint (the whole point)", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });
  const statsBefore = getCatalogCacheStats(); // counters are cumulative across tests

  await call(getAllJobs, { query: {} });
  await call(getRecommendedJobs, { query: {} });
  await call(getPublicStats, {});
  await call(listPublicSources, { query: { withJobs: "true" } });
  await call(listScrapedJobs, { query: { keyword: "react" } });
  await call(getAllJobs, { query: { keyword: "node" } });
  await call(getAllJobs, { query: { keyword: "python" } });

  assert.equal(db.calls.scrapedJobFind, 1, "ScrapedJob read exactly once for 7 requests");
  const stats = getCatalogCacheStats();
  assert.equal(stats.loads - statsBefore.loads, 1);
  assert.ok(stats.hits - statsBefore.hits >= 6);
});

test("kill switch (CATALOG_CACHE_TTL_MS=0): every request reloads and results stay correct", async () => {
  process.env.CATALOG_CACHE_TTL_MS = "0";
  db = stubDb({ jobs: jobs(), sources: sources() });

  const a = await call(getAllJobs, { query: { limit: "48" } });
  const s1 = await call(getPublicStats, {});
  const s2 = await call(getPublicStats, {});
  assert.equal(a.body.pagination.total, 5);
  assert.equal(s1.body.stats.totalJobs, 5);
  assert.equal(s2.body.stats.totalJobs, 5);
  assert.ok(db.calls.scrapedJobFind >= 3, "no caching when disabled");
});
