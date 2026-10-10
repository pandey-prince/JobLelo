import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchExternalJobById, clearExternalCache, getExternalCacheStats } from "../services/job-catalog/index.js";

const realFetch = globalThis.fetch;
let fetchCalls;
let remotiveJobs;
let arbeitnowJobs;
let failNext;

const remotive = (id, title = `Job ${id}`) => ({
  id, title, company_name: "RemoteCo", url: `https://remotive.com/job/${id}`,
  candidate_required_location: "Worldwide", job_type: "full_time", salary: "",
  publication_date: new Date().toISOString(), description: "<p>Great job</p>", tags: ["node"], category: "Software Development",
});
const arbeit = (slug) => ({
  slug, title: `Arbeit ${slug}`, company_name: "DE GmbH", url: `https://arbeitnow.com/${slug}`,
  location: "Berlin", remote: true, created_at: Math.floor(Date.now() / 1000), description: "<p>Hallo</p>", tags: [], job_types: [],
});

beforeEach(() => {
  clearExternalCache();
  fetchCalls = [];
  remotiveJobs = [remotive(1), remotive(2), remotive(2, "duplicate id - ignored")];
  arbeitnowJobs = [arbeit("a-1")];
  failNext = false;
  delete process.env.EXTERNAL_JOBS_CACHE_TTL_MS;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (failNext) return { ok: false, status: 503, json: async () => ({}) };
    if (String(url).includes("remotive")) return { ok: true, status: 200, json: async () => ({ jobs: remotiveJobs }) };
    return { ok: true, status: 200, json: async () => ({ data: arbeitnowJobs }) };
  };
});
afterEach(() => { globalThis.fetch = realFetch; clearExternalCache(); });

test("many lookups -> one download per provider", async () => {
  const a = await fetchExternalJobById("remotive-1");
  const b = await fetchExternalJobById("remotive-2");
  const c = await fetchExternalJobById("remotive-1");
  const d = await fetchExternalJobById("arbeitnow-a-1");
  const e = await fetchExternalJobById("arbeitnow-a-1");
  assert.equal(a._id, "remotive-1");
  assert.equal(b.title, "Job 2", "first duplicate wins (same as Array.find)");
  assert.equal(c.title, a.title);
  assert.equal(d._id, "arbeitnow-a-1");
  assert.equal(e.title, d.title);
  assert.equal(fetchCalls.filter((u) => u.includes("remotive")).length, 1);
  assert.equal(fetchCalls.filter((u) => u.includes("arbeitnow")).length, 1);
});

test("returns an independent top-level object per call", async () => {
  const a = await fetchExternalJobById("remotive-1");
  const b = await fetchExternalJobById("remotive-1");
  assert.notStrictEqual(a, b);
  a.title = "mutated by caller"; // allowed on the copy
  assert.equal((await fetchExternalJobById("remotive-1")).title, "Job 1");
});

test("unknown ids and unknown prefixes return null", async () => {
  assert.equal(await fetchExternalJobById("remotive-999"), null);
  assert.equal(await fetchExternalJobById("other-1"), null);
});

test("provider failure returns null (as before) and is not cached", async () => {
  failNext = true;
  assert.equal(await fetchExternalJobById("remotive-1"), null);
  failNext = false;
  assert.equal((await fetchExternalJobById("remotive-1"))._id, "remotive-1");
});

test("stale data is served when the provider goes down later", async () => {
  await fetchExternalJobById("remotive-1");
  process.env.EXTERNAL_JOBS_CACHE_TTL_MS = "1"; // expire immediately, stale window still large
  await new Promise((r) => setTimeout(r, 5));
  failNext = true;
  const job = await fetchExternalJobById("remotive-1");
  await new Promise((r) => setTimeout(r, 20)); // background refresh fails quietly
  assert.equal(job._id, "remotive-1");
  assert.equal((await fetchExternalJobById("remotive-1"))._id, "remotive-1");
});

test("kill switch EXTERNAL_JOBS_CACHE_TTL_MS=0 downloads every time", async () => {
  process.env.EXTERNAL_JOBS_CACHE_TTL_MS = "0";
  await fetchExternalJobById("remotive-1");
  await fetchExternalJobById("remotive-1");
  assert.equal(fetchCalls.length, 2);
});

test("a brand-new job missing from an old cached listing triggers exactly one refresh", async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    await fetchExternalJobById("remotive-1"); // primes cache
    assert.equal(fetchCalls.length, 1);

    remotiveJobs.push(remotive(3, "Brand new"));
    // too fresh to refresh: still a miss, no download
    assert.equal(await fetchExternalJobById("remotive-3"), null);
    assert.equal(fetchCalls.length, 1);

    offset = 3 * 60 * 1000; // listing is now >2 min old (but within the 20 min TTL)
    const found = await fetchExternalJobById("remotive-3");
    assert.equal(found.title, "Brand new");
    assert.equal(fetchCalls.length, 2);

    // a random non-existent id refreshes at most once per window, not on every request
    offset = 6 * 60 * 1000;
    assert.equal(await fetchExternalJobById("remotive-12345"), null);
    assert.equal(await fetchExternalJobById("remotive-12346"), null);
    assert.equal(fetchCalls.length, 3);
  } finally {
    Date.now = realNow;
  }
  assert.ok(getExternalCacheStats().loads >= 3);
});
