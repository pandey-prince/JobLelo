import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  buildCatalog,
  mapScrapedJobForList,
  dedupeScrapedJobs,
} from "../services/job-catalog/jobMapper.service.js";
import {
  createCatalogService,
  filterCatalogByKeyword,
  normalizeKeyword,
  MAX_KEYWORD_LENGTH,
} from "../services/job-catalog/catalogCache.service.js";
import { filterItJobs } from "../utils/itJobFilter.js";
import { filterIndiaJobs } from "../utils/indiaJobFilter.js";

const silent = { warn() {}, log() {}, error() {} };
const oid = () => new mongoose.Types.ObjectId();
const sourceA = oid();
const sourceB = oid();
const hiddenSource = oid();

let seq = 0;
const raw = (overrides = {}) => {
  seq += 1;
  return {
    _id: oid(),
    title: `Software Engineer ${seq}`,
    description: "<p>Build <b>backend</b> services with Node.js and MongoDB.</p>",
    location: "Bengaluru, India",
    jobType: "Full-time",
    salary: "Not disclosed",
    requirements: ["Node.js", "MongoDB"],
    applicationUrl: `https://careers.example.com/job/${seq}`,
    companyName: "Acme",
    companyLogo: "",
    firstSeenAt: new Date(Date.now() - seq * 60_000),
    status: "active",
    source: sourceA,
    ...overrides,
  };
};

const fixtures = () => {
  seq = 0;
  return [
    raw({ title: "Software Engineer - React", companyName: "Acme", location: "Hyderabad, India" }),
    raw({ title: "Backend Developer", companyName: "Globex", location: "Pune, India", source: sourceB }),
    raw({ title: "Data Engineer", companyName: "Initech", location: "Noida, India", description: "x".repeat(900) + " kubernetes-secret-word" }),
    raw({ title: "C++ Developer", companyName: "Umbrella", location: "Chennai, India" }),
    // dropped: not IT
    raw({ title: "Sales Manager", companyName: "Acme", location: "Mumbai, India", description: "Sell things." }),
    // dropped: not India
    raw({ title: "Software Engineer", companyName: "Foreign Inc", location: "Berlin, Germany" }),
    // dropped: hidden source
    raw({ title: "Software Engineer Hidden", companyName: "Ghost", location: "Pune, India", source: hiddenSource }),
    // duplicate (same company+title) -> older one dropped by dedupe
    raw({ title: "Backend Developer", companyName: "Globex", location: "Pune, India", source: sourceB, applicationUrl: "https://careers.example.com/dup" }),
  ];
};

test("buildCatalog applies IT/India/hidden/dedupe filters and keeps searchIndex aligned", () => {
  const docs = fixtures();
  const catalog = buildCatalog(docs, [String(hiddenSource)]);

  const titles = catalog.jobs.map((j) => j.title).sort();
  assert.deepEqual(titles, ["Backend Developer", "C++ Developer", "Data Engineer", "Software Engineer - React"]);
  assert.equal(catalog.searchIndex.length, catalog.jobs.length);
  catalog.jobs.forEach((job, i) => {
    assert.ok(catalog.searchIndex[i].includes(job.title.toLowerCase()), "index aligned with job");
  });
});

test("parity: buildCatalog === the original pipeline for the unfiltered list", () => {
  const docs = fixtures();
  const hidden = new Set([String(hiddenSource)]);
  const visible = docs.filter((d) => !hidden.has(String(d.source)));
  const expected = dedupeScrapedJobs(filterIndiaJobs(filterItJobs(visible))).map(mapScrapedJobForList);
  const actual = buildCatalog(docs, [...hidden]).jobs;
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
});

test("keyword search: plain substring, case-insensitive, over title/company/location/description", () => {
  const catalog = buildCatalog(fixtures(), [String(hiddenSource)]);
  const titles = (kw) => filterCatalogByKeyword(catalog, kw).map((j) => j.title).sort();

  assert.deepEqual(titles("REACT"), ["Software Engineer - React"]);
  assert.deepEqual(titles("globex"), ["Backend Developer"]);
  assert.deepEqual(titles("noida"), ["Data Engineer"]);
  assert.equal(filterCatalogByKeyword(catalog, "").length, 4);
  assert.equal(filterCatalogByKeyword(catalog, "   ").length, 4);
});

test("keyword search reaches deep into long descriptions (beyond the 400-char list preview)", () => {
  const catalog = buildCatalog(fixtures(), []);
  const hit = filterCatalogByKeyword(catalog, "kubernetes-secret-word");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].title, "Data Engineer");
  // the preview shown to users is still truncated
  assert.ok(hit[0].description.length <= 401);
});

test("regex-special keywords are treated as plain text and do not throw", () => {
  const catalog = buildCatalog(fixtures(), []);
  assert.deepEqual(filterCatalogByKeyword(catalog, "c++").map((j) => j.title), ["C++ Developer"]);
  assert.deepEqual(filterCatalogByKeyword(catalog, ".*"), []);
  assert.deepEqual(filterCatalogByKeyword(catalog, "(a+)+$"), []);
  assert.deepEqual(filterCatalogByKeyword(catalog, "[unclosed"), []);
});

test("keyword is trimmed, lower-cased and length-capped", () => {
  assert.equal(normalizeKeyword("  ReAcT  "), "react");
  assert.equal(normalizeKeyword(undefined), "");
  assert.equal(normalizeKeyword("a".repeat(500)).length, MAX_KEYWORD_LENGTH);
});

test("service: second call within TTL does not touch the loader; keyword calls reuse the same load", async () => {
  let loads = 0;
  const service = createCatalogService({
    loader: async () => { loads += 1; return buildCatalog(fixtures(), []); },
    logger: silent,
    rewarmDelayMs: -1,
  });

  const all = await service.getScrapedJobsForList("");
  const again = await service.getScrapedJobsForList("");
  const react = await service.getScrapedJobsForList("react");
  const other = await service.getScrapedJobsForList("globex");

  assert.equal(loads, 1);
  assert.strictEqual(all, again, "same shared array instance (read-only)");
  assert.equal(react.length, 1);
  assert.equal(other.length, 1);
  assert.equal(service.getCatalogCacheStats().jobCount, all.length);
});

test("service: concurrent cold requests share one load", async () => {
  let loads = 0;
  const service = createCatalogService({
    loader: async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 15));
      return buildCatalog(fixtures(), []);
    },
    logger: silent,
    rewarmDelayMs: -1,
  });
  await Promise.all(Array.from({ length: 12 }, () => service.getScrapedJobsForList("")));
  assert.equal(loads, 1);
});

test("service: invalidateCatalog makes new data visible on the next call", async () => {
  let version = 0;
  const service = createCatalogService({
    loader: async () => {
      version += 1;
      return buildCatalog([raw({ title: `Software Engineer v${version}` })], []);
    },
    logger: silent,
    rewarmDelayMs: -1,
  });
  assert.equal((await service.getScrapedJobsForList(""))[0].title, "Software Engineer v1");
  service.invalidateCatalog("test");
  assert.equal((await service.getScrapedJobsForList(""))[0].title, "Software Engineer v2");
});

test("service: rewarm after invalidate loads in the background (only if it was loaded before)", async () => {
  let loads = 0;
  const service = createCatalogService({
    loader: async () => { loads += 1; return buildCatalog(fixtures(), []); },
    logger: silent,
    rewarmDelayMs: 5,
  });

  service.invalidateCatalog("never loaded in this process");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(loads, 0, "script/cron processes must not warm the catalog");

  await service.getScrapedJobsForList("");
  service.invalidateCatalog("after sync");
  service.invalidateCatalog("after sync again"); // debounced
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(loads, 2, "exactly one background rewarm");
  await service.getScrapedJobsForList("");
  assert.equal(loads, 2, "request after rewarm is a cache hit");
});

test("service: kill switch CATALOG_CACHE_TTL_MS=0 bypasses the cache", async () => {
  let loads = 0;
  const service = createCatalogService({
    loader: async () => { loads += 1; return buildCatalog(fixtures(), []); },
    logger: silent,
    rewarmDelayMs: -1,
  });
  process.env.CATALOG_CACHE_TTL_MS = "0";
  try {
    await service.getScrapedJobsForList("");
    await service.getScrapedJobsForList("");
    assert.equal(loads, 2);
  } finally {
    delete process.env.CATALOG_CACHE_TTL_MS;
  }
});

test("service: cached data is frozen outside production (accidental mutation throws) and ObjectIds survive", async () => {
  const service = createCatalogService({
    loader: async () => buildCatalog(fixtures(), []),
    logger: silent,
    rewarmDelayMs: -1,
  });
  const jobs = await service.getScrapedJobsForList("");
  assert.throws(() => { jobs.push({}); }, TypeError);
  assert.throws(() => { jobs[0].title = "hacked"; }, TypeError);
  assert.throws(() => { jobs[0].badges.isNew = true; }, TypeError);
  // ObjectId is a class instance: left intact and still serialises
  assert.match(JSON.stringify(jobs[0]), /scrapedJobId/);
  assert.ok(jobs[0].scrapedJobId instanceof mongoose.Types.ObjectId);
});

test("service: a loader returning an invalid shape is rejected and not cached", async () => {
  let calls = 0;
  const service = createCatalogService({
    loader: async () => (++calls === 1 ? { jobs: null } : buildCatalog(fixtures(), [])),
    logger: silent,
    rewarmDelayMs: -1,
  });
  await assert.rejects(() => service.getScrapedJobsForList(""), /invalid result/);
  assert.equal((await service.getScrapedJobsForList("")).length, buildCatalog(fixtures(), []).jobs.length);
});
