/**
 * Aggregation helpers shared by the server (Node) and the dashboard (browser).
 *
 * Dates are always "YYYY-MM-DD" strings in UTC, matching the Admin API.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.UsageAggregate = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    const METRICS = [
        "total_characters",
        "text_translation_characters",
        "document_translation_characters",
        "text_improvement_characters",
        "speech_to_text_minutes",
    ];

    const MAX_RANGE_DAYS = 366;

    function emptyMetrics() {
        const m = {};
        METRICS.forEach((k) => (m[k] = 0));
        return m;
    }

    function addMetrics(target, source) {
        METRICS.forEach((k) => {
            target[k] += Number(source[k]) || 0;
        });
        return target;
    }

    function parseDate(date) {
        const [y, m, d] = date.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, d));
    }

    function formatDate(dt) {
        return dt.toISOString().slice(0, 10);
    }

    function addDays(date, days) {
        const dt = parseDate(date);
        dt.setUTCDate(dt.getUTCDate() + days);
        return formatDate(dt);
    }

    /** Number of calendar days from start to end, both inclusive. */
    /** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
    function isValidDate(date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
        const parsed = parseDate(date);
        return !isNaN(parsed) && parsed.getUTCFullYear() >= 1970 && parsed.toISOString().slice(0, 10) === date;
    }

    function daysInclusive(start, end) {
        return Math.round((parseDate(end) - parseDate(start)) / 86400000) + 1;
    }

    /**
     * Collapses an Admin API `key_and_day` report into one metrics object per
     * day, summed across all API keys of the account.
     * Accepts both `key_and_day_usages` and `grouped_usage`, and metrics either
     * nested under `usage` or flat on the item.
     */
    function dailyFromReport(report) {
        const items =
            (report && (report.key_and_day_usages || report.grouped_usage)) ||
            [];
        const byDay = new Map();
        items.forEach((item) => {
            const date = String(item.usage_date).slice(0, 10);
            if (!byDay.has(date)) byDay.set(date, emptyMetrics());
            addMetrics(byDay.get(date), item.usage || item);
        });
        return Array.from(byDay, ([date, metrics]) => ({ date, metrics })).sort(
            (a, b) => a.date.localeCompare(b.date)
        );
    }

    /** Start date of the bucket a day falls into (ISO weeks start Monday). */
    function bucketStart(date, granularity) {
        if (granularity === "month") return date.slice(0, 8) + "01";
        if (granularity === "week") {
            const dow = (parseDate(date).getUTCDay() + 6) % 7; // Mon=0
            return addDays(date, -dow);
        }
        return date;
    }

    /** Every bucket start between start and end, so gaps render as zero. */
    function bucketRange(start, end, granularity) {
        const buckets = [];
        let current = bucketStart(start, granularity);
        while (current <= end) {
            buckets.push(current);
            if (granularity === "month") {
                const dt = parseDate(current);
                dt.setUTCMonth(dt.getUTCMonth() + 1);
                current = formatDate(dt);
            } else {
                current = addDays(current, granularity === "week" ? 7 : 1);
            }
        }
        return buckets;
    }

    /**
     * Buckets daily rows into day/week/month series aligned to `buckets`.
     * Returns an array of metrics objects, one per bucket.
     */
    function bucketDaily(daily, buckets, granularity) {
        const index = new Map(buckets.map((b, i) => [b, i]));
        const series = buckets.map(() => emptyMetrics());
        daily.forEach(({ date, metrics }) => {
            const i = index.get(bucketStart(date, granularity));
            if (i !== undefined) addMetrics(series[i], metrics);
        });
        return series;
    }

    function totalOf(daily) {
        return daily.reduce((acc, row) => addMetrics(acc, row.metrics), emptyMetrics());
    }

    return {
        METRICS,
        MAX_RANGE_DAYS,
        emptyMetrics,
        addMetrics,
        addDays,
        daysInclusive,
        isValidDate,
        dailyFromReport,
        bucketStart,
        bucketRange,
        bucketDaily,
        totalOf,
    };
});
