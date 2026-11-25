const test = require("node:test");
const assert = require("node:assert/strict");
const { UsageCache } = require("../lib/usage-cache");

const loader = (calls, cacheable = true) => async () => {
    calls.n++;
    return { body: { n: calls.n }, cacheable };
};

test("serves cached results within the TTL", async () => {
    let t = 0;
    const cache = new UsageCache({ ttlMs: 1000, now: () => t });
    const calls = { n: 0 };
    await cache.get("k", {}, loader(calls));
    await cache.get("k", {}, loader(calls));
    assert.equal(calls.n, 1);
    t = 1000;
    await cache.get("k", {}, loader(calls));
    assert.equal(calls.n, 2);
});

test("caps the number of entries, evicting the least recently used", async () => {
    const cache = new UsageCache({ ttlMs: 60000, maxEntries: 3 });
    const calls = { n: 0 };
    for (const k of ["a", "b", "c"]) await cache.get(k, {}, loader(calls));
    await cache.get("a", {}, loader(calls)); // touch a
    await cache.get("d", {}, loader(calls)); // evicts b
    assert.equal(cache.size, 3);
    assert.deepEqual([...cache.entries.keys()], ["c", "a", "d"]);
});

test("coalesces concurrent requests for the same key", async () => {
    const cache = new UsageCache({ ttlMs: 60000 });
    let n = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const load = async () => {
        n++;
        await gate;
        return { body: { n }, cacheable: true };
    };
    const all = Promise.all(Array.from({ length: 10 }, () => cache.get("k", { refresh: true }, load)));
    release();
    const results = await all;
    assert.equal(n, 1);
    assert.ok(results.every((r) => r.n === 1));
});

test("throttles forced refreshes", async () => {
    let t = 0;
    const cache = new UsageCache({ ttlMs: 300000, minRefreshMs: 10000, now: () => t });
    const calls = { n: 0 };
    await cache.get("k", {}, loader(calls));
    t = 5000;
    await cache.get("k", { refresh: true }, loader(calls));
    assert.equal(calls.n, 1); // too soon, served from cache
    t = 10000;
    await cache.get("k", { refresh: true }, loader(calls));
    assert.equal(calls.n, 2);
});

test("does not cache partial results", async () => {
    const cache = new UsageCache({ ttlMs: 60000 });
    const calls = { n: 0 };
    await cache.get("k", {}, loader(calls, false));
    await cache.get("k", {}, loader(calls, false));
    assert.equal(calls.n, 2);
    assert.equal(cache.size, 0);
});
