const { dailyFromReport } = require("../public/aggregate");

const TIMEOUT_MS = 30000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeError(status, body, host) {
    const apiMessage = body && (body.message || body.detail || body.title);
    switch (status) {
        case 400:
            return `Bad request: ${apiMessage || "invalid parameters"}`;
        case 401:
        case 403:
            return "Access denied - check that this is an active Admin API key (ending in :adm) for this account, and that the account's region matches its API host";
        case 404:
            return `Admin Analytics API not found on ${host} - this host may not serve it for this account`;
        case 429:
            return "Rate limited by the DeepL API - try again in a minute";
        default:
            return `DeepL API returned HTTP ${status}${apiMessage ? `: ${apiMessage}` : ""}`;
    }
}

/**
 * Fetches one account's usage for [start, end] (inclusive UTC dates) and
 * returns daily rows summed across the account's API keys.
 *
 * end_date is sent as end-of-day so the last day is included whether the API
 * treats end_date as inclusive or exclusive.
 */
async function fetchAccountDaily(account, start, end) {
    const url = new URL(account.base_url + "/v2/admin/analytics");
    url.searchParams.set("start_date", start);
    url.searchParams.set("end_date", `${end}T23:59:59`);
    url.searchParams.set("group_by", "key_and_day");

    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let res;
        try {
            res = await fetch(url, {
                headers: {
                    Authorization: `DeepL-Auth-Key ${account.admin_api_key}`,
                    "User-Agent": "deepl-multi-account-usage-dashboard/0.1",
                },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (err) {
            lastError = new Error(`Network error: ${err.message}`);
            if (attempt < MAX_ATTEMPTS) await sleep(1000 * attempt);
            continue;
        }

        const text = await res.text();
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            // Non-JSON body; handled below.
        }

        if (res.ok) {
            if (!body) throw new Error("DeepL API returned an empty or non-JSON response");
            return dailyFromReport(body.usage_report || body);
        }

        const traceId = res.headers.get("x-trace-id");
        lastError = new Error(
            describeError(res.status, body, url.hostname) + (traceId ? ` (trace ID ${traceId})` : "")
        );
        lastError.status = res.status;
        if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) break;
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
    throw lastError;
}

module.exports = { fetchAccountDaily, describeError };
