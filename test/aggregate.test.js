const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../public/aggregate");

const item = (label, date, total, extra = {}) => ({
    api_key_label: label,
    usage_date: `${date}T00:00:00Z`,
    usage: { total_characters: total, text_translation_characters: total, ...extra },
});

test("dailyFromReport sums across keys per day and sorts by date", () => {
    const daily = A.dailyFromReport({
        key_and_day_usages: [item("b", "2026-10-02", 5), item("a", "2026-10-01", 10), item("b", "2026-10-01", 3)],
    });
    assert.deepEqual(daily.map((d) => [d.date, d.metrics.total_characters]), [
        ["2026-10-01", 13],
        ["2026-10-02", 5],
    ]);
});

test("dailyFromReport accepts flat metrics and grouped_usage", () => {
    const daily = A.dailyFromReport({
        grouped_usage: [{ usage_date: "2026-10-01T00:00:00", total_characters: 7, speech_to_text_minutes: 1.5 }],
    });
    assert.equal(daily[0].metrics.total_characters, 7);
    assert.equal(daily[0].metrics.speech_to_text_minutes, 1.5);
    assert.equal(daily[0].metrics.document_translation_characters, 0);
});

test("dailyFromReport handles empty report", () => {
    assert.deepEqual(A.dailyFromReport({}), []);
    assert.deepEqual(A.dailyFromReport(null), []);
});

test("bucketStart uses ISO weeks (Monday) and month starts", () => {
    assert.equal(A.bucketStart("2026-10-30", "week"), "2026-10-26"); // Friday -> Monday
    assert.equal(A.bucketStart("2026-10-26", "week"), "2026-10-26"); // Monday
    assert.equal(A.bucketStart("2026-11-01", "week"), "2026-10-26"); // Sunday -> previous Monday
    assert.equal(A.bucketStart("2026-10-30", "month"), "2026-10-01");
    assert.equal(A.bucketStart("2026-10-30", "day"), "2026-10-30");
});

test("bucketRange covers the range including partial edges", () => {
    assert.deepEqual(A.bucketRange("2026-01-15", "2026-03-02", "month"), ["2026-01-01", "2026-02-01", "2026-03-01"]);
    assert.deepEqual(A.bucketRange("2026-10-28", "2026-11-03", "week"), ["2026-10-26", "2026-11-02"]);
    assert.equal(A.bucketRange("2025-11-01", "2026-10-31", "day").length, 365);
});

test("weekly and monthly buckets preserve daily totals", () => {
    const start = "2026-01-01";
    const end = "2026-06-30";
    const daily = [];
    for (let d = start, i = 1; d <= end; d = A.addDays(d, 1), i++) {
        daily.push({ date: d, metrics: { ...A.emptyMetrics(), total_characters: i, speech_to_text_minutes: 0.5 } });
    }
    const expected = A.totalOf(daily);
    for (const g of ["day", "week", "month"]) {
        const series = A.bucketDaily(daily, A.bucketRange(start, end, g), g);
        const sum = series.reduce((acc, m) => A.addMetrics(acc, m), A.emptyMetrics());
        assert.equal(sum.total_characters, expected.total_characters, g);
        assert.equal(sum.speech_to_text_minutes, expected.speech_to_text_minutes, g);
    }
});

test("gaps render as zero buckets", () => {
    const daily = [{ date: "2026-10-03", metrics: { ...A.emptyMetrics(), total_characters: 4 } }];
    const buckets = A.bucketRange("2026-10-01", "2026-10-04", "day");
    assert.deepEqual(A.bucketDaily(daily, buckets, "day").map((m) => m.total_characters), [0, 0, 4, 0]);
});

test("daysInclusive", () => {
    assert.equal(A.daysInclusive("2026-10-30", "2026-10-30"), 1);
    assert.equal(A.daysInclusive("2026-01-01", "2026-12-31"), 365);
    assert.equal(A.daysInclusive("2024-01-01", "2024-12-31"), 366); // leap year
});

test("isValidDate accepts real dates and rejects impossible ones", () => {
    const { isValidDate } = require("../public/aggregate");
    for (const d of ["2026-02-28", "2024-02-29", "2026-12-31"]) assert.ok(isValidDate(d), d);
    for (const d of ["2026-02-30", "2025-02-29", "0000-00-00", "2026-13-45", "2026-1-1", "x", "", null, undefined]) {
        assert.ok(!isValidDate(d), String(d));
    }
});
