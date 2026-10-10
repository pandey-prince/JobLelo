import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { raw, oid, sourceA, sourceB, hiddenSource } from "./helpers/fixtures.js";
import { stubDb } from "./helpers/stubDb.js";
import { clearCatalogCache, getCatalogCacheStats } from "../services/job-catalog/index.js";
import jobRoute from "../routes/job.route.js";
import statsRoute from "../routes/stats.route.js";
import careerSourceRoute from "../routes/careerSource.route.js";
import scrapedJobRoute from "../routes/scrapedJob.route.js";

process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret";

const jobs = () => [
  raw({ title: "Software Engineer - React", companyName: "Acme", location: "Hyderabad, India" }),
  raw({ title: "Backend Developer", companyName: "Globex", location: "Pune, India", source: sourceB }),
  raw({ title: "Data Engineer", companyName: "Initech", location: "Noida, India" }),
  raw({ title: "Sales Manager", companyName: "Acme", location: "Mumbai, India", description: "Sell." }),
  raw({ title: "Software Engineer Hidden", companyName: "Ghost", location: "Pune, India", source: hiddenSource }),
];
const sources = () => [
  { _id: sourceA, companyName: "Acme", name: "Acme", url: "https://acme.example", isPublic: true, isActive: true, lastScrapeStatus: "success" },
  { _id: sourceB, companyName: "Globex", name: "Globex", url: "https://globex.example", isPublic: true, isActive: true, lastScrapeStatus: "success" },
  { _id: hiddenSource, companyName: "Ghost", name: "Ghost", isPublic: true, isActive: true, lastScrapeStatus: "error", lastScrapeError: "404 not found", lastScrapedAt: new Date() },
];

let server;
let base;
let db;

before(async () => {
  clearCatalogCache();
  db = stubDb({ jobs: jobs(), sources: sources() });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1/job", jobRoute);
  app.use("/api/v1/stats", statsRoute);
  app.use("/api/v1/career-sources", careerSourceRoute);
  app.use("/api/v1/scraped-jobs", scrapedJobRoute);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  db.restore();
  clearCatalogCache();
  await new Promise((resolve) => server.close(resolve));
});

const get = async (path, headers = {}) => {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json() };
};

test("real HTTP: every cached endpoint serialises correctly (frozen data + ObjectIds)", async () => {
  const feed = await get("/job/get?limit=10");
  assert.equal(feed.status, 200);
  assert.equal(feed.body.success, true);
  assert.equal(feed.body.jobs.length, 3);
  assert.ok(feed.body.jobs.every((j) => typeof j.scrapedJobId === "string"), "ObjectId serialised as string");
  assert.ok(feed.body.jobs.every((j) => j.badges && typeof j.badges === "object"));

  const rec = await get("/job/recommended?limit=2");
  assert.equal(rec.status, 200);
  assert.equal(rec.body.jobs.length, 2);
  assert.equal(rec.body.personalized, false);

  const stats = await get("/stats/public");
  assert.equal(stats.status, 200);
  assert.equal(stats.body.stats.totalJobs, 3);

  const companies = await get("/career-sources?withJobs=true");
  assert.equal(companies.status, 200);
  assert.deepEqual(companies.body.sources.map((s) => s.companyName), ["Acme", "Globex", "Initech"]);

  const scraped = await get("/scraped-jobs?keyword=initech");
  assert.equal(scraped.status, 200);
  assert.deepEqual(scraped.body.jobs.map((j) => j.title), ["Data Engineer"]);
});

test("real HTTP: repeated requests across endpoints cost exactly one catalog load", async () => {
  clearCatalogCache();
  const before = db.calls.scrapedJobFind;
  const loadsBefore = getCatalogCacheStats().loads;

  await Promise.all([
    get("/job/get"), get("/job/get?keyword=react"), get("/job/recommended"),
    get("/stats/public"), get("/career-sources?withJobs=true"), get("/scraped-jobs"),
    get("/job/get?keyword=node"), get("/job/get?locations=Pune"),
  ]);
  await get("/job/get?sortBy=company");

  assert.equal(db.calls.scrapedJobFind - before, 1, "9 requests (8 concurrent) -> one DB read");
  assert.equal(getCatalogCacheStats().loads - loadsBefore, 1);
});

test("real HTTP: hostile keywords are handled safely and quickly", async () => {
  const started = performance.now();
  for (const kw of ["(a%2B)%2B%24", ".*", "%5Bbroken", "c%2B%2B", "%5C", "x".repeat(5000)]) {
    const res = await get(`/job/get?keyword=${kw}`);
    assert.equal(res.status, 200, `keyword ${kw.slice(0, 20)}`);
  }
  const arrayKw = await get("/job/get?keyword=a&keyword=b");
  assert.equal(arrayKw.status, 200);
  assert.ok(performance.now() - started < 2000);
});

test("real HTTP: logged-in user's dismissed job is hidden for them only", async () => {
  const userId = oid();
  const guest = await get("/job/get?limit=10");
  const dismissKey = guest.body.jobs.find((j) => j.title === "Data Engineer")._id;

  db.restore();
  db = stubDb({ jobs: jobs(), sources: sources(), dismissed: { [String(userId)]: [dismissKey] } });

  const token = jwt.sign({ userId: String(userId) }, process.env.SECRET_KEY);
  const mine = await get("/job/get?limit=10", { Cookie: `token=${token}` });
  assert.ok(!mine.body.jobs.some((j) => j.title === "Data Engineer"));
  const guestAgain = await get("/job/get?limit=10");
  assert.ok(guestAgain.body.jobs.some((j) => j.title === "Data Engineer"));
});
