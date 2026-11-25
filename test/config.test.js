const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateConfig, loadConfig, sampleServerConfig, isTruthyEnv, REGION_HOSTS } = require("../lib/config");

const account = (overrides = {}) => ({
    name: "Prod EU",
    admin_api_key: "abc:adm",
    ...overrides,
});

test("valid config normalizes accounts and server defaults", () => {
    const { config, errors, warnings } = validateConfig({
        accounts: [account({ region: "eu" }), account({ name: "Prod US", region: "US" }), account({ name: "No region" })],
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(config.accounts.map((a) => a.region), ["EU", "US", "EU"]);
    assert.deepEqual(config.server, { port: 3000, host: "127.0.0.1", auth_token: "", allowed_hosts: [] });
});

const serverFrom = (env, server) => validateConfig({ accounts: [account()], server }, env);

test("environment variables override port, host and allowed hosts", () => {
    const { config, errors } = serverFrom({
        PORT: "8080",
        DEEPL_DASHBOARD_HOST: "0.0.0.0",
        DEEPL_DASHBOARD_ALLOWED_HOSTS: " Usage.Example.com, other.example.com ,",
        DEEPL_DASHBOARD_TOKEN: "x".repeat(24),
    }, { port: 3000, allowed_hosts: ["file.example.com"] });
    assert.deepEqual(errors, []);
    assert.equal(config.server.port, 8080);
    assert.equal(config.server.host, "0.0.0.0");
    assert.deepEqual(config.server.allowed_hosts, ["file.example.com", "usage.example.com", "other.example.com"]);
});

test("a bad PORT is an error", () => {
    for (const port of ["0", "70000", "abc", "30.5"]) {
        assert.ok(serverFrom({ PORT: port }).errors.some((e) => e.includes("PORT must be")), port);
    }
});

test("non-loopback host needs a token", () => {
    const open = serverFrom({ DEEPL_DASHBOARD_HOST: "0.0.0.0" });
    assert.ok(open.errors.some((e) => e.includes("no access token is set")));

    const withToken = serverFrom({ DEEPL_DASHBOARD_HOST: "0.0.0.0", DEEPL_DASHBOARD_TOKEN: "x".repeat(24) });
    assert.deepEqual(withToken.errors, []);
});

test("sample mode uses the same server validation", () => {
    assert.deepEqual(sampleServerConfig({}).server, { port: 3000, host: "127.0.0.1", auth_token: "", allowed_hosts: [] });
    const s = sampleServerConfig({ DEEPL_DASHBOARD_HOST: "0.0.0.0", PORT: "3001" }).server;
    assert.equal(s.host, "0.0.0.0");
    assert.equal(s.port, 3001);
    assert.throws(() => sampleServerConfig({ PORT: "abc" }), /PORT must be/);
});

test("sample mode (synthetic data) may listen beyond loopback without auth; real mode may not", () => {
    const env = { DEEPL_DASHBOARD_HOST: "0.0.0.0", DEEPL_DASHBOARD_ALLOWED_HOSTS: "demo.example.com" };
    const open = sampleServerConfig(env).server;
    assert.equal(open.host, "0.0.0.0");
    assert.equal(open.auth_token, "");
    assert.deepEqual(open.allowed_hosts, ["demo.example.com"]);
    assert.ok(serverFrom(env).errors.some((e) => e.includes("no access token is set")));
});

test("isTruthyEnv", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) assert.ok(isTruthyEnv(v), v);
    for (const v of ["", "0", "false", undefined, "2"]) assert.ok(!isTruthyEnv(v), String(v));
});

test("region picks the API host; no region defaults to EU", () => {
    const { config, errors } = validateConfig({
        accounts: [account({ region: "EU" }), account({ name: "US", region: "US" }), account({ name: "JP", region: "jp" }), account({ name: "none" })],
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.accounts.map((a) => a.base_url), [
        "https://api.deepl.com",
        "https://api-us.deepl.com",
        "https://api-jp.deepl.com",
        "https://api.deepl.com",
    ]);
    assert.deepEqual(Object.keys(REGION_HOSTS), ["EU", "US", "JP"]);
});

test("base_url may override the host, but only to a known DeepL host", () => {
    const ok = validateConfig({ accounts: [account({ region: "US", base_url: "https://api.deepl.com/" })] });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.config.accounts[0].base_url, "https://api.deepl.com");
    for (const bad of ["https://evil.example.com", "http://api.deepl.com", "https://api.deepl.com.evil.com", "https://api-us.deepl.com@evil.com"]) {
        const r = validateConfig({ accounts: [account({ base_url: bad })] });
        assert.ok(r.errors.some((e) => e.includes('"base_url" must be one of')), bad);
    }
});

test("existing tests run without picking up a real token from the environment", () => {
    assert.equal(validateConfig({ accounts: [account()] }, {}).config.server.auth_token, "");
});

test("reads keys from environment variables", () => {
    const { config, errors } = validateConfig(
        { accounts: [{ name: "Env", admin_api_key_env: "PROD_EU_ADM" }] },
        { PROD_EU_ADM: "secret:adm" }
    );
    assert.deepEqual(errors, []);
    assert.equal(config.accounts[0].admin_api_key, "secret:adm");
    assert.equal(config.accounts[0].admin_api_key_env, "PROD_EU_ADM");
});

test("rejects a missing env var, a bad env name, and both key fields", () => {
    const missing = validateConfig({ accounts: [{ name: "A", admin_api_key_env: "NOPE" }] }, {});
    assert.ok(missing.errors.some((e) => e.includes("NOPE is not set")));
    const badName = validateConfig({ accounts: [{ name: "A", admin_api_key_env: "not a name" }] }, {});
    assert.ok(badName.errors.some((e) => e.includes("environment variable name")));
    const both = validateConfig({ accounts: [account({ admin_api_key_env: "X" })] }, { X: "k:adm" });
    assert.ok(both.errors.some((e) => e.includes("not both")));
});

test("requires an access token when binding beyond loopback", () => {
    const open = validateConfig({ accounts: [account()], server: { host: "0.0.0.0" } }, {});
    assert.ok(open.errors.some((e) => e.includes("no access token")));

    const withEnv = validateConfig({ accounts: [account()], server: { host: "0.0.0.0" } }, { DEEPL_DASHBOARD_TOKEN: "a-long-random-token-value" });
    assert.deepEqual(withEnv.errors, []);
    assert.equal(withEnv.config.server.auth_token, "a-long-random-token-value");

    const short = validateConfig({ accounts: [account()], server: { host: "0.0.0.0", auth_token: "short" } }, {});
    assert.ok(short.errors.some((e) => e.includes("at least 24 characters")));

    const inFile = validateConfig({ accounts: [account()], server: { host: "0.0.0.0", auth_token: "x".repeat(24) } }, {});
    assert.deepEqual(inFile.errors, []);
    assert.equal(inFile.warnings.length, 1); // token stored in file

    const loopback = validateConfig({ accounts: [account()], server: { host: "localhost" } }, {});
    assert.deepEqual(loopback.errors, []);
});

test("normalizes allowed_hosts and rejects a non-array", () => {
    const ok = validateConfig({ accounts: [account()], server: { allowed_hosts: [" Usage.Example.com "] } }, {});
    assert.deepEqual(ok.config.server.allowed_hosts, ["usage.example.com"]);
    const bad = validateConfig({ accounts: [account()], server: { allowed_hosts: "usage.example.com" } }, {});
    assert.ok(bad.errors.some((e) => e.includes("allowed_hosts")));
});

test("loadConfig warns when a config file with keys is readable by others", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-config-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ accounts: [account()] }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const prev = process.env.DEEPL_DASHBOARD_CONFIG;
    process.env.DEEPL_DASHBOARD_CONFIG = file;
    try {
        assert.ok(loadConfig().warnings.some((w) => w.includes("chmod 600")));
        fs.chmodSync(file, 0o600);
        assert.ok(!loadConfig().warnings.some((w) => w.includes("chmod 600")));
    } finally {
        if (prev === undefined) delete process.env.DEEPL_DASHBOARD_CONFIG;
        else process.env.DEEPL_DASHBOARD_CONFIG = prev;
        fs.rmSync(dir, { recursive: true });
    }
});

test("rejects empty accounts, duplicates and missing keys", () => {
    assert.ok(validateConfig({}).errors.length);
    assert.ok(validateConfig({ accounts: [] }).errors.length);
    const { errors } = validateConfig({
        accounts: [account(), account(), account({ name: "X", admin_api_key: "YOUR_ADMIN_API_KEY:adm" })],
    });
    assert.ok(errors.some((e) => e.includes("duplicate")));
    assert.ok(errors.some((e) => e.includes("admin_api_key")));
});

test("warns on non-admin key suffix; rejects unknown region", () => {
    const { errors, warnings } = validateConfig({ accounts: [account({ admin_api_key: "abc:fx" })] });
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    const bad = validateConfig({ accounts: [account({ region: "Mars" })] });
    assert.ok(bad.errors.some((e) => e.includes('unknown region "MARS"')));
});
