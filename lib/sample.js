/**
 * Deterministic synthetic data for `npm run sample`. Produces Admin API
 * shaped `key_and_day` reports so the sample path exercises the same
 * aggregation code as live data.
 */
const { addDays, dailyFromReport } = require("../public/aggregate");

const SAMPLE_ACCOUNTS = [
    { name: "Production (EU)", region: "EU", scale: 1_400_000, stt: 0, keys: ["Course authoring", "Review app"] },
    { name: "Staging (EU)", region: "EU", scale: 90_000, stt: 0, keys: ["CI tests"] },
    { name: "Production (US)", region: "US", scale: 2_100_000, stt: 140, keys: ["Course authoring", "Review app", "Captions"] },
    { name: "Staging (US)", region: "US", scale: 120_000, stt: 6, keys: ["CI tests"] },
];

const EPOCH = "2025-01-01";

// Small string hash -> [0, 1) so every (account, key, day) is stable across runs.
function noise(seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 10000) / 10000;
}

function sampleReport(account, start, end) {
    const items = [];
    for (let date = start; date <= end; date = addDays(date, 1)) {
        const dayIndex = Math.round((Date.parse(date) - Date.parse(EPOCH)) / 86400000);
        const growth = 1 + Math.max(dayIndex, 0) * 0.0015;
        const dow = new Date(date + "T00:00:00Z").getUTCDay();
        const weekday = dow === 0 || dow === 6 ? 0.35 : 1;

        // Speech-to-text usage lands on one key per account.
        const sttKey = account.keys.includes("Captions") ? "Captions" : account.keys[0];
        account.keys.forEach((label, k) => {
            const share = 1 / (k + 1.5);
            const base = account.scale * growth * weekday * share * (0.75 + noise(`${account.name}|${label}|${date}`) * 0.5);
            const text = Math.round(base * 0.62);
            const doc = Math.round(base * 0.28 * noise(`${date}|${label}|doc`) * 2);
            const write = Math.round(base * 0.1);
            const stt = label === sttKey
                ? Math.round(account.stt * growth * weekday * noise(`${date}|${account.name}|stt`) * 100) / 100
                : 0;
            items.push({
                api_key: `${String(k + 1).repeat(4)}****${String(k + 1).repeat(4)}`,
                api_key_label: label,
                usage_date: `${date}T00:00:00Z`,
                usage: {
                    total_characters: text + doc + write,
                    text_translation_characters: text,
                    document_translation_characters: doc,
                    text_improvement_characters: write,
                    speech_to_text_minutes: stt,
                },
            });
        });
    }
    return { key_and_day_usages: items };
}

function sampleAccounts() {
    return SAMPLE_ACCOUNTS.map(({ name, region }) => ({ name, region }));
}

function sampleDaily(accountName, start, end) {
    const account = SAMPLE_ACCOUNTS.find((a) => a.name === accountName);
    return dailyFromReport(sampleReport(account, start, end));
}

module.exports = { sampleAccounts, sampleDaily };
