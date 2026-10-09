import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { raw, sourceA, sourceB, hiddenSource, silent } from "./helpers/fixtures.js";
import { stubDb, mockRes } from "./helpers/stubDb.js";
import {
  clearCatalogCache,
  createCatalogService,
  buildCatalog,
} from "../services/job-catalog/index.js";
import { getAllJobs } from "../controllers/job.controller.js";
import { updateJobSource } from "../controllers/scrapedJob.controller.js";
import { syncSourceById } from "../services/scrapeSync.service.js";

const jobs = () => [
  raw({ title: "Software Engineer - React", companyName: "Acme", location: "Hyderabad, India" }),
  raw({ title: "Backend Developer", companyName: "Globex", location: "Pune, India", source: sourceB }),
];
const sources = () => [
  { _id: sourceA, companyName: "Acme", name: "Acme", isPublic: true, isActive: true, lastScrapeStatus: "success" },
  { _id: sourceB, companyName: "Globex", name: "Globex", isPublic: true, isActive: true, lastScrapeStatus: "success" },
  { _id: hiddenSource, companyName: "Ghost", name: "Ghost", isPublic: true, isActive: true, lastScrapeStatus: "success" },
];

let db;
beforeEach(() => { clearCatalogCache(); });
afterEach(() => { db?.restore(); clearCatalogCache(); });

const feed = async () => {
  const res = mockRes();
  await getAllJobs({ query: { limit: "48" } }, res);
  return res;
};

test("withCatalogInvalidation: invalidates after success and after failure, preserves result/error", async () => {
  let loads = 0;
  const service = createCatalogService({
    loader: async () => { loads += 1; return buildCatalog([raw({ title: `Software Engineer v${loads}` })], []); },
    logger: silent,
    rewarmDelayMs: -1,
  });

  await service.getScrapedJobsForList("");
  const ok = service.withCatalogInvalidation("ok", async (x) => x * 2);
  assert.equal(await ok(21), 42);
  assert.equal((await service.getScrapedJobsForList(""))[0].title, "Software Engineer v2");

  const bad = service.withCatalogInvalidation("bad", async () => { throw new Error("sync exploded"); });
  await assert.rejects(() => bad(), /sync exploded/);
  assert.equal((await service.getScrapedJobsForList(""))[0].title, "Software Engineer v3");
});

test("real syncSourceById (even when it throws) drops the cached catalog", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });

  await feed();
  await feed();
  assert.equal(db.calls.scrapedJobFind, 1, "cached");

  await assert.rejects(() => syncSourceById("507f1f77bcf86cd799439011"), /Job source not found/);

  await feed();
  assert.equal(db.calls.scrapedJobFind, 2, "reloaded after the writer finished");
});

test("admin updateJobSource drops the cached catalog so the change shows up immediately", async () => {
  db = stubDb({ jobs: jobs(), sources: sources() });
  await feed();
  assert.equal(db.calls.scrapedJobFind, 1);

  const res = mockRes();
  await updateJobSource({ params: { id: String(sourceA) }, body: { isActive: false } }, res);
  assert.equal(res.statusCode, 200);

  await feed();
  assert.equal(db.calls.scrapedJobFind, 2);
});

test("new data written between requests is visible after invalidation (and not before, within TTL)", async () => {
  const data = jobs();
  db = stubDb({ jobs: data, sources: sources() });

  const first = await feed();
  assert.equal(first.body.pagination.total, 2);

  data.push(raw({ title: "Software Engineer - New", companyName: "Hooli", location: "Pune, India" }));
  const within = await feed();
  assert.equal(within.body.pagination.total, 2, "served from cache until TTL/invalidation (GitHub Actions case)");

  const { invalidateCatalog } = await import("../services/job-catalog/index.js");
  invalidateCatalog("test");
  const after = await feed();
  assert.equal(after.body.pagination.total, 3);
});
