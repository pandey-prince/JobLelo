/**
 * End-to-end check of the catalog cache against a RUNNING backend + LOCAL database.
 *
 *   npm run seed:catalog                    # once, to have data
 *   npm start                               # in another terminal
 *   TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=... npm run test:e2e-cache
 *
 * Env: TEST_API_BASE (default http://localhost:8000), MONGO_URI (must be localhost:
 * the script inserts/removes probe jobs directly in the DB, like a scraper would).
 */
import "dotenv/config";
import mongoose from "mongoose";
import { ScrapedJob } from "../models/scrapedJob.model.js";
import { JobSource } from "../models/jobSource.model.js";
import { User } from "../models/user.model.js";

const API = `${process.env.TEST_API_BASE || "http://localhost:8000"}/api/v1`;
const MONGO_URI = process.env.MONGO_URI || "";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;

if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(MONGO_URI)) {
  console.error("Refusing to run: MONGO_URI must point at a LOCAL database (this script writes probe data).");
  process.exit(1);
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD (or ADMIN_EMAIL/ADMIN_PASSWORD).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

class Client {
  constructor() { this.cookie = ""; }
  async request(path, { method = "GET", body } = {}) {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    if (body) headers["Content-Type"] = "application/json";
    const started = performance.now();
    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const ms = performance.now() - started;
    for (const raw of res.headers.getSetCookie?.() || []) {
      const pair = raw.split(";")[0];
      const value = pair.slice(pair.indexOf("=") + 1);
      this.cookie = value ? pair : "";
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: res.status, data, ms };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROBE_PREFIX = "seed-e2e-probe-";

const run = async () => {
  await mongoose.connect(MONGO_URI);
  console.log(`\n=== Catalog cache E2E against ${API} ===\n`);

  const guest = new Client();
  const admin = new Client();

  // ---- A. server + admin ----
  const login = await admin.request("/user/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: "admin" },
  });
  check("admin login", login.status === 200 && login.data?.success, `HTTP ${login.status}`);

  const cacheAdmin = () => admin.request("/admin/cache");
  const unauth = await guest.request("/admin/cache");
  check("GET /admin/cache is blocked for guests", unauth.status === 401, `HTTP ${unauth.status}`);

  await admin.request("/admin/cache/clear", { method: "POST" });
  let stats = (await cacheAdmin()).data.cache.catalog;
  const loadsAfterClear = stats.loads;
  check("cache rebuilt by /admin/cache/clear", stats.jobCount > 0, `${stats.jobCount} jobs, version ${stats.version}`);

  // ---- B. one load serves everything ----
  const paths = [
    "/job/get?limit=12", "/job/get?limit=12&keyword=react", "/job/get?sortBy=company&limit=12",
    "/job/recommended?limit=6", "/stats/public", "/career-sources?withJobs=true&limit=20",
    "/scraped-jobs?keyword=node", "/job/get?locations=Pune", "/job/get?keyword=python",
  ];
  const responses = await Promise.all(Array.from({ length: 4 }, () => paths).flat().map((p) => guest.request(p)));
  check("36 mixed concurrent requests all succeed", responses.every((r) => r.status === 200),
    `statuses: ${[...new Set(responses.map((r) => r.status))].join(",")}`);
  stats = (await cacheAdmin()).data.cache.catalog;
  check("36 requests caused 0 additional catalog loads", stats.loads === loadsAfterClear,
    `loads ${loadsAfterClear} -> ${stats.loads}, hits=${stats.hits}`);

  // ---- C. consistency across endpoints ----
  const feed = await guest.request("/job/get?limit=12");
  const st = await guest.request("/stats/public");
  const scraped = await guest.request("/scraped-jobs");
  const total = feed.data.pagination.total;
  check("feed total == stats.totalJobs == catalog.jobCount",
    total === st.data.stats.totalJobs && total === stats.jobCount,
    `feed=${total} stats=${st.data.stats.totalJobs} catalog=${stats.jobCount}`);
  check("scraped-jobs list total matches", (scraped.data.pagination?.total ?? scraped.data.jobs?.length) === total,
    `scraped-jobs=${scraped.data.pagination?.total ?? scraped.data.jobs?.length}`);
  const comps = await guest.request("/career-sources?withJobs=true&limit=48");
  const compJobs = comps.data.sources.reduce((sum, s) => sum + s.activeJobCount, 0);
  check("companies page counts are consistent with the catalog (first page <= total)", compJobs <= total && compJobs > 0,
    `${comps.data.pagination.total} companies, ${compJobs} jobs on page 1`);

  // ---- D. keyword search ----
  const react = await guest.request("/job/get?keyword=react&limit=48");
  const reactOk = react.data.jobs.every((j) =>
    `${j.title} ${j.company?.name} ${j.location} ${j.description} ${(j.requirements || []).join(" ")}`
      .toLowerCase().includes("react"));
  check("keyword=react returns only matching jobs", react.status === 200 && reactOk, `${react.data.pagination.total} results`);
  for (const kw of ["c%2B%2B", "(a%2B)%2B%24", ".*", "%5Bbroken", "%5C", "x".repeat(2000)]) {
    const res = await guest.request(`/job/get?keyword=${kw}`);
    check(`hostile keyword "${decodeURIComponent(kw).slice(0, 12)}" is safe`, res.status === 200, `HTTP ${res.status}, ${res.ms.toFixed(0)} ms`);
  }

  // ---- E. freshness: a scraper writes straight to the DB (GitHub Actions case) ----
  const source = await JobSource.findOne({ url: /^https:\/\/seed\.example\//, lastScrapeStatus: "success" });
  await ScrapedJob.deleteMany({ externalId: new RegExp(`^${PROBE_PREFIX}`) });
  await ScrapedJob.create({
    source: source._id, externalId: `${PROBE_PREFIX}1`, title: "Zyxwprobe Software Engineer",
    description: "<p>Probe job written directly to the DB by the e2e test.</p>",
    location: "Pune, India", applicationUrl: "https://seed.example/probe/1", companyName: source.companyName,
  });
  const before = await guest.request("/job/get?keyword=zyxwprobe");
  check("new DB row is NOT visible immediately (served from cache within TTL)", before.data.pagination.total === 0,
    `results=${before.data.pagination.total}`);
  await admin.request("/admin/cache/clear", { method: "POST" });
  const after = await guest.request("/job/get?keyword=zyxwprobe");
  check("after POST /admin/cache/clear the new job appears", after.data.pagination.total === 1,
    `results=${after.data.pagination.total}`);

  // ---- F. admin source edit invalidates automatically ----
  await ScrapedJob.create({
    source: source._id, externalId: `${PROBE_PREFIX}2`, title: "Qwvbprobe Backend Developer",
    description: "<p>Second probe.</p>", location: "Noida, India",
    applicationUrl: "https://seed.example/probe/2", companyName: source.companyName,
  });
  const hidden = await guest.request("/job/get?keyword=qwvbprobe");
  check("second probe not visible yet", hidden.data.pagination.total === 0);
  const upd = await admin.request(`/scraped-jobs/sources/${source._id}`, { method: "PUT", body: { isActive: true } });
  check("PUT /scraped-jobs/sources/:id works", upd.status === 200, `HTTP ${upd.status}`);
  const shown = await guest.request("/job/get?keyword=qwvbprobe");
  check("admin source update invalidated the cache (probe now visible, no manual clear)",
    shown.data.pagination.total === 1, `results=${shown.data.pagination.total}`);

  // ---- G. per-user data never leaks through the shared cache ----
  const email = `e2e-student-${Date.now()}@test.local`;
  const student = new Client();
  const reg = await student.request("/user/register", {
    method: "POST",
    body: { fullname: "E2E Student", email, phoneNumber: "9876543210", password: "Student#12345", role: "student" },
  });
  check("student registers", reg.status === 201 || reg.status === 200, `HTTP ${reg.status}`);
  await User.updateOne({ email }, { $set: { emailVerified: true } });
  const sl = await student.request("/user/login", { method: "POST", body: { email, password: "Student#12345", role: "student" } });
  check("student logs in", sl.status === 200, `HTTP ${sl.status}`);

  const guestFeed1 = await guest.request("/job/get?limit=48");
  const victim = guestFeed1.data.jobs[0];
  const dis = await student.request("/dismissed-jobs", { method: "POST", body: { jobKey: victim._id, title: victim.title, company: victim.company, location: victim.location } });
  check("student dismisses a job", dis.status === 201, `HTTP ${dis.status}`);
  const mine = await student.request("/job/get?limit=48");
  const guestFeed2 = await guest.request("/job/get?limit=48");
  check("dismissed job hidden for that student", !mine.data.jobs.some((j) => j._id === victim._id));
  check("same job still visible to guests (cache not polluted)", guestFeed2.data.jobs.some((j) => j._id === victim._id));
  check("student total == guest total - 1", mine.data.pagination.total === guestFeed2.data.pagination.total - 1,
    `${mine.data.pagination.total} vs ${guestFeed2.data.pagination.total}`);
  const rec = await student.request("/job/recommended?limit=5");
  check("recommended works for logged-in student", rec.status === 200 && rec.data.jobs.length > 0);

  // ---- H. the response is the same object shape the frontend expects ----
  const sample = feed.data.jobs[0];
  const shape = ["_id", "title", "company", "location", "description", "badges", "createdAt"].every((k) => k in sample);
  check("job payload shape unchanged", shape, Object.keys(sample).join(","));

  // ---- cleanup ----
  await ScrapedJob.deleteMany({ externalId: new RegExp(`^${PROBE_PREFIX}`) });
  await User.deleteOne({ email });
  await admin.request("/admin/cache/clear", { method: "POST" });
  const final = (await cacheAdmin()).data.cache;
  console.log(`\nFinal cache stats: hits=${final.catalog.hits} misses=${final.catalog.misses} staleHits=${final.catalog.staleHits} loads=${final.catalog.loads} errors=${final.catalog.loadErrors}`);
  console.log(`Memory: heap ${final.memory.heapUsedMB} MB, rss ${final.memory.rssMB} MB`);

  console.log(`\n=== E2E: ${passed}/${passed + failed} checks passed ===`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
};

run().catch(async (error) => {
  console.error("E2E crashed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
