/**
 * Bounded cache for /api/usage results, with request coalescing.
 *
 * - At most `maxEntries` ranges are kept (least recently used is evicted), so
 *   requesting many distinct ranges can't grow memory without limit.
 * - Concurrent requests for the same range share one upstream fetch.
 * - A forced refresh within `minRefreshMs` of the last fetch is served from
 *   the cache, so repeated refreshes can't hammer the Admin API.
 */
class UsageCache {
    constructor({ ttlMs, maxEntries = 50, minRefreshMs = 10000, now = Date.now } = {}) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.minRefreshMs = minRefreshMs;
        this.now = now;
        this.entries = new Map(); // key -> { at, body }, in LRU order
        this.inFlight = new Map(); // key -> Promise<{ body, cacheable }>
    }

    _fresh(entry, refresh) {
        if (!entry) return false;
        const age = this.now() - entry.at;
        return refresh ? age < this.minRefreshMs : age < this.ttlMs;
    }

    /**
     * Returns the cached body for `key`, or runs `load()` once for all
     * concurrent callers. `load` resolves to { body, cacheable }.
     */
    async get(key, { refresh = false } = {}, load) {
        const entry = this.entries.get(key);
        if (this._fresh(entry, refresh)) {
            this.entries.delete(key);
            this.entries.set(key, entry); // mark as recently used
            return entry.body;
        }
        if (this.inFlight.has(key)) return (await this.inFlight.get(key)).body;

        const promise = load();
        this.inFlight.set(key, promise);
        try {
            const { body, cacheable } = await promise;
            if (cacheable) this._set(key, body);
            return body;
        } finally {
            this.inFlight.delete(key);
        }
    }

    _set(key, body) {
        this.entries.delete(key);
        this.entries.set(key, { at: this.now(), body });
        // Drop expired entries, then the least recently used beyond the cap.
        for (const [k, e] of this.entries) {
            if (this.now() - e.at >= this.ttlMs) this.entries.delete(k);
        }
        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
    }

    get size() {
        return this.entries.size;
    }
}

module.exports = { UsageCache };
