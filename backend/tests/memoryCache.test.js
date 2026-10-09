import test from "node:test";
import assert from "node:assert/strict";
import { createCache, createDerivedMemo, deepFreeze } from "../utils/memoryCache.js";

const silent = { warn() {}, log() {}, error() {} };

const makeClock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("fresh hit: loader runs once within TTL", async () => {
  const clock = makeClock();
  const cache = createCache({ ttlMs: 1000, staleMs: 5000, now: clock.now, logger: silent });
  let calls = 0;
  const loader = async () => ({ n: ++calls });

  const a = await cache.getOrLoad("k", loader);
  clock.advance(500);
  const b = await cache.getOrLoad("k", loader);

  assert.equal(calls, 1);
  assert.strictEqual(a, b);
  assert.equal(cache.getStats().hits, 1);
});

test("single-flight: 10 concurrent misses -> 1 loader call", async () => {
  const cache = createCache({ ttlMs: 1000, logger: silent });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return "value";
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => cache.getOrLoad("k", loader)));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r === "value"));
});

test("stale-while-revalidate: serves stale immediately, refreshes in background", async () => {
  const clock = makeClock();
  const cache = createCache({ ttlMs: 1000, staleMs: 10_000, now: clock.now, logger: silent });
  let calls = 0;
  const loader = async () => `v${++calls}`;

  assert.equal(await cache.getOrLoad("k", loader), "v1");
  clock.advance(2000); // past TTL, within stale window

  const stale = await cache.getOrLoadEntry("k", loader);
  assert.equal(stale.value, "v1");
  assert.equal(stale.state, "stale");

  await tick();
  await tick();
  const fresh = await cache.getOrLoadEntry("k", loader);
  assert.equal(fresh.value, "v2");
  assert.equal(fresh.state, "hit");
  assert.equal(calls, 2);
});

test("beyond max stale age: request waits for a fresh load", async () => {
  const clock = makeClock();
  const cache = createCache({ ttlMs: 1000, staleMs: 3000, now: clock.now, logger: silent });
  let calls = 0;
  const loader = async () => `v${++calls}`;
  await cache.getOrLoad("k", loader);
  clock.advance(5000);
  const entry = await cache.getOrLoadEntry("k", loader);
  assert.equal(entry.value, "v2");
  assert.equal(entry.state, "miss");
});

test("loader error with no cached value rejects and is not cached", async () => {
  const cache = createCache({ ttlMs: 1000, logger: silent });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    if (calls === 1) throw new Error("db down");
    return "ok";
  };
  await assert.rejects(() => cache.getOrLoad("k", loader), /db down/);
  assert.equal(await cache.getOrLoad("k", loader), "ok");
  assert.equal(cache.getStats().loadErrors, 1);
});

test("background refresh failure keeps serving stale data", async () => {
  const clock = makeClock();
  const cache = createCache({ ttlMs: 1000, staleMs: 60_000, now: clock.now, logger: silent });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    if (calls > 1) throw new Error("refresh failed");
    return "v1";
  };
  await cache.getOrLoad("k", loader);
  clock.advance(2000);
  assert.equal(await cache.getOrLoad("k", loader), "v1");
  await tick();
  await tick();
  assert.equal(await cache.getOrLoad("k", loader), "v1"); // still stale, not an error
  assert.equal(cache.getStats().loadErrors, 1);
});

test("too-old entry + failing load serves stale-on-error instead of throwing", async () => {
  const clock = makeClock();
  const cache = createCache({ ttlMs: 1000, staleMs: 2000, now: clock.now, logger: silent });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    if (calls > 1) throw new Error("boom");
    return "v1";
  };
  await cache.getOrLoad("k", loader);
  clock.advance(10_000);
  const entry = await cache.getOrLoadEntry("k", loader);
  assert.equal(entry.value, "v1");
  assert.equal(entry.state, "stale-on-error");
});

test("kill switch: ttl 0 bypasses the cache", async () => {
  const cache = createCache({ ttlMs: () => Number(process.env.TEST_TTL), logger: silent });
  process.env.TEST_TTL = "0";
  let calls = 0;
  const loader = async () => ++calls;
  await cache.getOrLoad("k", loader);
  await cache.getOrLoad("k", loader);
  assert.equal(calls, 2);
  assert.equal(cache.getStats().bypasses, 2);
  process.env.TEST_TTL = "1000";
  await cache.getOrLoad("k", loader);
  await cache.getOrLoad("k", loader);
  assert.equal(calls, 3);
  delete process.env.TEST_TTL;
});

test("invalidate forces the next call to reload", async () => {
  const cache = createCache({ ttlMs: 60_000, logger: silent });
  let calls = 0;
  const loader = async () => ++calls;
  await cache.getOrLoad("k", loader);
  cache.invalidate("k");
  assert.equal(await cache.getOrLoad("k", loader), 2);
});

test("a load that started before invalidate() does not overwrite newer state", async () => {
  const cache = createCache({ ttlMs: 60_000, logger: silent });
  let release;
  const slow = () => new Promise((resolve) => { release = () => resolve("OLD"); });

  const first = cache.getOrLoad("k", slow); // starts slow load
  await tick();
  cache.invalidate("k"); // data changed while loading
  const second = await cache.getOrLoad("k", async () => "NEW");
  release();
  assert.equal(await first, "OLD"); // original caller still gets its value
  assert.equal(second, "NEW");
  assert.equal(await cache.getOrLoad("k", async () => "SHOULD_NOT_RUN"), "NEW");
});

test("cacheable predicate: unwanted values are returned but not stored", async () => {
  const cache = createCache({ ttlMs: 60_000, logger: silent });
  let calls = 0;
  const loader = async () => (++calls === 1 ? null : "good");
  const opts = { cacheable: (v) => v !== null };
  assert.equal(await cache.getOrLoad("k", loader, opts), null);
  assert.equal(await cache.getOrLoad("k", loader, opts), "good");
  assert.equal(await cache.getOrLoad("k", loader, opts), "good");
  assert.equal(calls, 2);
});

test("invalidatePrefix and clear", async () => {
  const cache = createCache({ ttlMs: 60_000, logger: silent });
  await cache.getOrLoad("a:1", async () => 1);
  await cache.getOrLoad("a:2", async () => 2);
  await cache.getOrLoad("b:1", async () => 3);
  assert.equal(cache.invalidatePrefix("a:"), 2);
  assert.equal(cache.peek("a:1"), null);
  assert.ok(cache.peek("b:1"));
  cache.clear();
  assert.equal(cache.getStats().size, 0);
});

test("version increases on every stored load; derived memo follows version", async () => {
  const cache = createCache({ ttlMs: 60_000, logger: silent });
  const e1 = await cache.getOrLoadEntry("k", async () => "a");
  cache.invalidate("k");
  const e2 = await cache.getOrLoadEntry("k", async () => "b");
  assert.ok(e2.version > e1.version);

  const memo = createDerivedMemo();
  let computes = 0;
  const compute = () => ++computes;
  assert.equal(memo.get("x", 1, compute), 1);
  assert.equal(memo.get("x", 1, compute), 1);
  assert.equal(memo.get("x", 2, compute), 2); // version changed
  assert.equal(computes, 2);
});

test("deepFreeze makes accidental mutation throw", () => {
  const data = deepFreeze({ jobs: [{ title: "a", company: { name: "x" } }] });
  assert.throws(() => { data.jobs[0].title = "b"; }, TypeError);
  assert.throws(() => { data.jobs.push({}); }, TypeError);
  assert.throws(() => { data.jobs[0].company.name = "y"; }, TypeError);
});
