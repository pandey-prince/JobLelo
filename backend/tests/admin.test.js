import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { raw, sourceA, sourceB } from "./helpers/fixtures.js";
import { stubDb, mockRes } from "./helpers/stubDb.js";
import { clearCatalogCache } from "../services/job-catalog/index.js";
import { getAllJobs } from "../controllers/job.controller.js";
import { getCacheStatus, clearCaches } from "../controllers/admin.controller.js";

let db;
afterEach(() => { db?.restore(); clearCatalogCache(); });

const jobs = () => [
  raw({ title: "Software Engineer - React", companyName: "Acme", location: "Hyderabad, India" }),
  raw({ title: "Backend Developer", companyName: "Globex", location: "Pune, India", source: sourceB }),
];
const sources = () => [
  { _id: sourceA, companyName: "Acme", name: "Acme", isPublic: true, isActive: true, lastScrapeStatus: "success" },
];

test("GET /admin/cache reports hits, misses, age, job count and memory", async () => {
  clearCatalogCache();
  db = stubDb({ jobs: jobs(), sources: sources() });
  await getAllJobs({ query: {} }, mockRes());
  await getAllJobs({ query: {} }, mockRes());

  const res = mockRes();
  await getCacheStatus({}, res);
  assert.equal(res.statusCode, 200);
  const { catalog, externalJobs, config, memory } = res.body.cache;
  assert.equal(catalog.jobCount, 2);
  assert.ok(catalog.hits >= 1 && catalog.misses >= 1);
  assert.ok(catalog.version > 0);
  assert.ok(catalog.ageMs >= 0);
  assert.equal(catalog.ttlMs, 300000);
  assert.equal(typeof externalJobs.size, "number");
  assert.ok(memory.heapUsedMB > 0);
  assert.ok("CATALOG_CACHE_TTL_MS" in config);
});

test("POST /admin/cache/clear rebuilds the catalog and the next request is a hit", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });
  await getAllJobs({ query: {} }, mockRes());
  const before = db.calls.scrapedJobFind;

  const res = mockRes();
  await clearCaches({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.catalog.jobCount, 2);
  assert.equal(db.calls.scrapedJobFind, before + 1, "rebuilt once");

  await getAllJobs({ query: {} }, mockRes());
  assert.equal(db.calls.scrapedJobFind, before + 1, "served from the rebuilt cache");
});
