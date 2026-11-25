#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadConfig, sampleServerConfig, isTruthyEnv, SAMPLE_ENV } = require("./lib/config");
const { fetchAccountDaily } = require("./lib/deepl");
const { sampleAccounts, sampleDaily } = require("./lib/sample");
const { isLoopbackHost, isHostAllowed, isAuthorized, isCrossSiteRequest, AuthLimiter, SECURITY_HEADERS } = require("./lib/security");
const { UsageCache } = require("./lib/usage-cache");
const { daysInclusive, isValidDate, MAX_RANGE_DAYS } = require("./public/aggregate");

const USE_SAMPLE = process.argv.includes("--sample") || isTruthyEnv(process.env[SAMPLE_ENV]);
const CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLIC_DIR = path.resolve(__dirname, "public");

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

// Server settings (port, host, allowed hosts) come from the
// config file and environment variables in real mode, and from the environment
// alone in sample mode; both go through the same validation.
function init() {
    try {
        if (USE_SAMPLE) {
            const { server, warnings } = sampleServerConfig();
            warnings.forEach((w) => console.warn(`WARNING: ${w}`));
            return { accounts: sampleAccounts(), server };
        }
        const { config, warnings } = loadConfig();
        warnings.forEach((w) => console.warn(`WARNING: ${w}`));
        return config;
    } catch (err) {
        console.error(`ERROR: ${err.message}`);
        process.exit(1);
    }
}

const config = init();
const cache = new UsageCache({ ttlMs: CACHE_TTL_MS });
const authLimiter = new AuthLimiter();

function sendText(res, status, text, headers = {}) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
    res.end(text);
}

function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}

function validateRange(start, end) {
    if (!isValidDate(start) || !isValidDate(end)) {
        return "start and end must be valid dates in YYYY-MM-DD form";
    }
    if (start > end) return "start must be on or before end";
    if (daysInclusive(start, end) > MAX_RANGE_DAYS) {
        return `Range cannot exceed ${MAX_RANGE_DAYS} days (Admin API limit)`;
    }
    return null;
}

async function loadAccount(account, start, end) {
    const base = { name: account.name, region: account.region };
    try {
        const daily = USE_SAMPLE
            ? sampleDaily(account.name, start, end)
            : await fetchAccountDaily(account, start, end);
        return { ...base, ok: true, daily };
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ${account.name}: ${err.message}`);
        return { ...base, ok: false, error: err.message, daily: [] };
    }
}

async function handleUsage(res, params) {
    const start = params.get("start");
    const end = params.get("end");
    const invalid = validateRange(start, end);
    if (invalid) return sendJson(res, 400, { error: invalid });

    const body = await cache.get(`${start}|${end}`, { refresh: params.get("refresh") === "1" }, async () => {
        const accounts = await Promise.all(config.accounts.map((a) => loadAccount(a, start, end)));
        return {
            body: { start, end, sample: USE_SAMPLE, fetched_at: new Date().toISOString(), accounts },
            // Only cache complete results so a transient failure isn't pinned for 5 minutes.
            cacheable: accounts.every((a) => a.ok),
        };
    });
    sendJson(res, 200, body);
}

function serveStatic(res, pathname) {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(PUBLIC_DIR, relative);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, "Forbidden");
    fs.readFile(filePath, (err, data) => {
        if (err) return sendText(res, 404, "Not found");
        res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    // Liveness/readiness probe. Answered before the Host and auth checks (probes
    // use the pod address as Host and carry no credentials), and reports only that
    // this process is up: no data, no upstream calls.
    if (req.method === "GET" && req.url === "/healthz") return sendText(res, 200, "ok", { "Cache-Control": "no-store" });

    if (!isHostAllowed(req.headers.host, config.server)) {
        return sendText(res, 403, "Host not allowed. Add it to server.allowed_hosts if this is intended.");
    }
    if (config.server.auth_token) {
        const client = req.socket.remoteAddress;
        const wait = authLimiter.retryAfter(client);
        if (wait > 0) return sendText(res, 429, "Too many failed logins - try again later", { "Retry-After": String(wait) });
        if (!isAuthorized(req.headers.authorization, config.server.auth_token)) {
            // A browser's first request carries no credentials; only count wrong ones.
            if (req.headers.authorization) authLimiter.recordFailure(client);
            return sendText(res, 401, "Authentication required", {
                "WWW-Authenticate": 'Basic realm="DeepL usage dashboard", charset="UTF-8"',
            });
        }
        authLimiter.recordSuccess(client);
    }

    const { pathname, searchParams } = new URL(req.url, "http://localhost");
    if (req.method !== "GET") return sendText(res, 405, "Method not allowed", { Allow: "GET" });
    // Other websites can make the operator's browser send GETs here. They can't
    // read the response, but they could trigger Admin API calls.
    if (pathname.startsWith("/api/") && isCrossSiteRequest(req.headers)) {
        return sendText(res, 403, "Cross-site requests are not allowed");
    }
    if (pathname === "/api/usage") {
        return handleUsage(res, searchParams).catch((err) => {
            console.error(`[${new Date().toISOString()}] /api/usage: ${err.message}`);
            sendJson(res, 500, { error: "Internal server error" });
        });
    }
    if (pathname === "/api/accounts") {
        return sendJson(res, 200, {
            sample: USE_SAMPLE,
            accounts: config.accounts.map((a) => ({ name: a.name, region: a.region })),
        });
    }
    serveStatic(res, pathname);
});

const { port, host } = config.server;
server.listen(port, host, () => {
    console.log(`DeepL multi-account usage dashboard${USE_SAMPLE ? " (sample data)" : ""}`);
    console.log(`  ${config.accounts.length} account(s): ${config.accounts.map((a) => (a.region ? `${a.name} [${a.region}]` : a.name)).join(", ")}`);
    console.log(`  Open http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    if (config.server.auth_token) console.log("  Access token required (HTTP Basic, any username, token as password)");
    const openSample = USE_SAMPLE && !config.server.auth_token && !isLoopbackHost(host);
    if (openSample) console.log("  No authentication: sample data only, no Admin API keys are loaded");
    if (!isLoopbackHost(host) && !openSample) {
        console.warn(
            "  NOTE: this server speaks plain HTTP. Put it behind a TLS reverse proxy before others use it, " +
                "or the access token and usage data cross the network unencrypted."
        );
    }
});

process.on("SIGTERM", () => server.close());
