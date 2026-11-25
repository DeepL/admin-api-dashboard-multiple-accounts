const crypto = require("crypto");
const fs = require("fs");

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** True for addresses that are only reachable from this machine. */
function isLoopbackHost(host) {
    const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
    return LOOPBACK_NAMES.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * Hostname part of a Host header ("example.com:3000" -> "example.com",
 * "[::1]:3000" -> "::1"). Returns "" for anything that isn't a well-formed
 * host[:port], such as "[::1].evil.com", so it can't match the allowlist.
 */
function hostnameFromHeader(header) {
    const value = String(header || "").trim().toLowerCase();
    const match = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(value) || /^([a-z0-9.-]+)(?::\d{1,5})?$/.exec(value);
    return match ? match[1] : "";
}

/**
 * Host header check against DNS rebinding. Without auth, the dashboard only
 * answers to loopback names, so a web page that rebinds its own domain to
 * 127.0.0.1 can't read the usage data. With auth, the browser won't send the
 * credentials to a rebinding origin, so the check only applies if
 * allowed_hosts is set.
 */
function isHostAllowed(header, server) {
    const allowed = server.allowed_hosts || [];
    if (server.auth_token && allowed.length === 0) return true;
    const hostname = hostnameFromHeader(header);
    if (!hostname) return false;
    return isLoopbackHost(hostname) || allowed.includes(hostname);
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest();

/** Checks HTTP Basic credentials. Any username is accepted; the password must equal the token. */
function isAuthorized(header, token) {
    if (!token) return true;
    const match = /^Basic\s+(\S+)$/i.exec(String(header || ""));
    if (!match) return false;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep === -1) return false;
    return crypto.timingSafeEqual(sha256(decoded.slice(sep + 1)), sha256(token));
}

/**
 * True when a browser says the request came from another site. Browsers send
 * Sec-Fetch-Site on every request; "same-origin" is the dashboard's own page
 * and "none" is the user typing the URL. Clients that don't send the header
 * (curl, scripts) aren't browsers, so they can't be used for cross-site abuse.
 */
function isCrossSiteRequest(headers) {
    const site = headers["sec-fetch-site"];
    return site !== undefined && site !== "same-origin" && site !== "none";
}

/**
 * Per-client limit on failed logins. After `maxFailures` wrong tokens within
 * `windowMs`, that client gets 429 until the window ends. Behind a reverse
 * proxy every request shares the proxy's address, so failures from anyone
 * count against everyone; that's the trade-off for not trusting
 * X-Forwarded-For, which clients can forge.
 */
class AuthLimiter {
    constructor({ maxFailures = 20, windowMs = 60000, now = Date.now } = {}) {
        this.maxFailures = maxFailures;
        this.windowMs = windowMs;
        this.now = now;
        this.clients = new Map(); // address -> { count, resetAt }
    }

    _entry(address) {
        const entry = this.clients.get(address);
        if (entry && entry.resetAt <= this.now()) {
            this.clients.delete(address);
            return null;
        }
        return entry || null;
    }

    /** Seconds until the client may try again, or 0 if not blocked. */
    retryAfter(address) {
        const entry = this._entry(address);
        if (!entry || entry.count < this.maxFailures) return 0;
        return Math.ceil((entry.resetAt - this.now()) / 1000);
    }

    recordFailure(address) {
        const entry = this._entry(address) || { count: 0, resetAt: this.now() + this.windowMs };
        entry.count++;
        this.clients.set(address, entry);
        // Keep the map from growing: drop expired clients.
        for (const [a, e] of this.clients) if (e.resetAt <= this.now()) this.clients.delete(a);
    }

    recordSuccess(address) {
        this.clients.delete(address);
    }
}

// Chart.js is the only external resource. The CSP allows that one file, not the
// whole CDN; keep it in sync with the <script> tag in public/index.html (a test
// checks this). Inline style attributes are used for chart colors, so style-src
// needs 'unsafe-inline'; scripts do not.
const CHART_JS_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";

const SECURITY_HEADERS = {
    "Content-Security-Policy": [
        "default-src 'self'",
        `script-src 'self' ${CHART_JS_URL}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * Returns a warning if a config file that holds keys is readable by other
 * users. Skipped on Windows, where POSIX mode bits don't apply.
 */
function permissionWarning(file, platform = process.platform) {
    if (platform === "win32") return null;
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) === 0) return null;
    return `${file} holds Admin API keys and is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${file}"`;
}

module.exports = { CHART_JS_URL, isLoopbackHost, hostnameFromHeader, isHostAllowed, isAuthorized, isCrossSiteRequest, AuthLimiter, SECURITY_HEADERS, permissionWarning };
