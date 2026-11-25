const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { CHART_JS_URL, isLoopbackHost, hostnameFromHeader, isHostAllowed, isAuthorized, isCrossSiteRequest, AuthLimiter, SECURITY_HEADERS } = require("../lib/security");

const basic = (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const noAuth = { auth_token: "", allowed_hosts: [] };

test("loopback detection", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "127.1.2.3"]) assert.ok(isLoopbackHost(h), h);
    for (const h of ["0.0.0.0", "10.0.0.5", "usage.example.com", ""]) assert.ok(!isLoopbackHost(h), h);
});

test("hostnameFromHeader strips ports and brackets", () => {
    assert.equal(hostnameFromHeader("LocalHost:3000"), "localhost");
    assert.equal(hostnameFromHeader("[::1]:3000"), "::1");
    assert.equal(hostnameFromHeader("example.com"), "example.com");
});

test("hostnameFromHeader rejects malformed hosts", () => {
    for (const h of ["[::1].evil.com", "[::1]evil", "[::1]:3000:1", "a b", "evil.com@127.0.0.1", "localhost:abc", "[evil.com]"]) {
        assert.equal(hostnameFromHeader(h), "", h);
    }
    assert.ok(!isHostAllowed("[::1].evil.com", noAuth));
});

test("without auth, only loopback Host headers are accepted (DNS rebinding)", () => {
    assert.ok(isHostAllowed("localhost:3000", noAuth));
    assert.ok(isHostAllowed("127.0.0.1:3000", noAuth));
    assert.ok(!isHostAllowed("attacker.example:3000", noAuth));
    assert.ok(!isHostAllowed(undefined, noAuth));
});

test("allowed_hosts extends the list; auth without allowed_hosts skips the check", () => {
    const proxied = { auth_token: "", allowed_hosts: ["usage.example.com"] };
    assert.ok(isHostAllowed("usage.example.com", proxied));
    assert.ok(!isHostAllowed("other.example.com", proxied));
    assert.ok(isHostAllowed("10.0.0.5:3000", { auth_token: "t", allowed_hosts: [] }));
    assert.ok(!isHostAllowed("10.0.0.5:3000", { auth_token: "t", allowed_hosts: ["usage.example.com"] }));
});

test("basic auth checks the password against the token", () => {
    assert.ok(isAuthorized(undefined, ""));
    assert.ok(isAuthorized(basic("anyone", "s3cret-token"), "s3cret-token"));
    assert.ok(isAuthorized(basic("", "pa:ss"), "pa:ss"));
    assert.ok(!isAuthorized(basic("anyone", "wrong"), "s3cret-token"));
    assert.ok(!isAuthorized(undefined, "s3cret-token"));
    assert.ok(!isAuthorized("Bearer s3cret-token", "s3cret-token"));
    assert.ok(!isAuthorized("Basic !!!", "s3cret-token"));
});

test("security headers include a CSP that blocks framing and foreign scripts", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"];
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(csp.includes(`script-src 'self' ${CHART_JS_URL};`), "CSP allows only the Chart.js file");
    assert.equal(SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
});

test("cross-site detection uses Sec-Fetch-Site", () => {
    assert.ok(!isCrossSiteRequest({}));
    assert.ok(!isCrossSiteRequest({ "sec-fetch-site": "same-origin" }));
    assert.ok(!isCrossSiteRequest({ "sec-fetch-site": "none" }));
    assert.ok(isCrossSiteRequest({ "sec-fetch-site": "cross-site" }));
    assert.ok(isCrossSiteRequest({ "sec-fetch-site": "same-site" }));
});

test("AuthLimiter blocks after repeated failures and resets after the window", () => {
    let t = 0;
    const limiter = new AuthLimiter({ maxFailures: 3, windowMs: 60000, now: () => t });
    for (let i = 0; i < 2; i++) limiter.recordFailure("a");
    assert.equal(limiter.retryAfter("a"), 0);
    limiter.recordFailure("a");
    assert.equal(limiter.retryAfter("a"), 60);
    assert.equal(limiter.retryAfter("b"), 0); // other clients unaffected
    t = 30000;
    assert.equal(limiter.retryAfter("a"), 30);
    t = 60000;
    assert.equal(limiter.retryAfter("a"), 0);
    assert.equal(limiter.clients.size, 0);
});

test("AuthLimiter clears a client's failures on success", () => {
    const limiter = new AuthLimiter({ maxFailures: 2 });
    limiter.recordFailure("a");
    limiter.recordSuccess("a");
    limiter.recordFailure("a");
    assert.equal(limiter.retryAfter("a"), 0);
});

test("Permissions-Policy denies device features", () => {
    assert.match(SECURITY_HEADERS["Permissions-Policy"], /camera=\(\)/);
});

test("CSP Chart.js URL matches the script tag in index.html", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    assert.ok(html.includes(`src="${CHART_JS_URL}"`), "update CHART_JS_URL in lib/security.js when upgrading Chart.js");
});

