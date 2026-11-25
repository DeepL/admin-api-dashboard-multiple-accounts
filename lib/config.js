const fs = require("fs");
const path = require("path");
const { isLoopbackHost, permissionWarning } = require("./security");

// An account's keys work only on the endpoint for its region, so each account
// calls the host that matches its region. Hosts are a fixed allowlist: the
// config can pick one, but can never point the server at an arbitrary URL.
// https://developers.deepl.com/docs/getting-started/regional-endpoints
const REGION_HOSTS = {
    EU: "https://api.deepl.com",
    US: "https://api-us.deepl.com",
    JP: "https://api-jp.deepl.com",
};
const REGIONS = Object.keys(REGION_HOSTS);
const DEFAULT_REGION = "EU";
const ALLOWED_BASE_URLS = Object.values(REGION_HOSTS);

const DEFAULT_SERVER = { port: 3000, host: "127.0.0.1" };

// Env var for the dashboard's own access token; takes precedence over server.auth_token.
const AUTH_TOKEN_ENV = "DEEPL_DASHBOARD_TOKEN";
const HOST_ENV = "DEEPL_DASHBOARD_HOST";
const ALLOWED_HOSTS_ENV = "DEEPL_DASHBOARD_ALLOWED_HOSTS";
const SAMPLE_ENV = "DEEPL_DASHBOARD_SAMPLE";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIN_TOKEN_LENGTH = 24;

function configPath() {
    return path.resolve(
        process.env.DEEPL_DASHBOARD_CONFIG ||
            path.join(__dirname, "..", "config.json")
    );
}

/**
 * Validates a parsed config object. Returns { config, errors, warnings };
 * `config` has normalized accounts and server settings. Keys referenced with
 * admin_api_key_env are resolved from `env`.
 */
function validateConfig(raw, env = process.env) {
    const errors = [];
    const warnings = [];
    const accounts = Array.isArray(raw && raw.accounts) ? raw.accounts : null;

    if (!accounts || accounts.length === 0) {
        errors.push('"accounts" must be a non-empty array');
    }

    const seen = new Set();
    const normalized = (accounts || []).map((account, i) => {
        const label = `accounts[${i}]`;
        const name = String((account && account.name) || "").trim();
        const keyEnv = String((account && account.admin_api_key_env) || "").trim();
        const literalKey = String((account && account.admin_api_key) || "").trim();
        let key = literalKey;
        const region = String((account && account.region) || "").trim().toUpperCase() || DEFAULT_REGION;
        const baseUrlOverride = String((account && account.base_url) || "").trim().replace(/\/+$/, "");

        if (!name) errors.push(`${label}: "name" is required`);
        if (seen.has(name)) errors.push(`${label}: duplicate name "${name}"`);
        seen.add(name);

        if (keyEnv) {
            if (literalKey) {
                errors.push(`${label} (${name}): set either "admin_api_key" or "admin_api_key_env", not both`);
            } else if (!ENV_NAME_RE.test(keyEnv)) {
                errors.push(`${label} (${name}): "admin_api_key_env" must be an environment variable name`);
            } else {
                key = String(env[keyEnv] || "").trim();
                if (!key) {
                    errors.push(`${label} (${name}): environment variable ${keyEnv} is not set`);
                } else if (!key.endsWith(":adm")) {
                    warnings.push(`${label} (${name}): key in ${keyEnv} does not end in ":adm" - Admin API keys usually do`);
                }
            }
        } else if (!key || key.startsWith("YOUR_")) {
            errors.push(`${label} (${name}): "admin_api_key" (or "admin_api_key_env") is missing`);
        } else if (!key.endsWith(":adm")) {
            warnings.push(
                `${label} (${name}): key does not end in ":adm" - Admin API keys usually do`
            );
        }

        if (!REGIONS.includes(region)) {
            errors.push(`${label} (${name}): unknown region "${region}" (expected ${REGIONS.join(", ")})`);
        }

        // Optional escape hatch for testing which host a key works on, e.g. an
        // account pinned to US whose Admin Analytics route lives on another host.
        if (baseUrlOverride && !ALLOWED_BASE_URLS.includes(baseUrlOverride)) {
            errors.push(`${label} (${name}): "base_url" must be one of ${ALLOWED_BASE_URLS.join(", ")}`);
        }

        return { name, admin_api_key: key, admin_api_key_env: keyEnv, region, base_url: baseUrlOverride || REGION_HOSTS[region] };
    });

    const server = validateServer((raw && raw.server) || {}, env, errors, warnings);
    return { config: { accounts: normalized, server }, errors, warnings };
}

const isTruthyEnv = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());

/**
 * The dashboard has no user accounts. Binding to anything other than loopback
 * exposes every account's usage to the network, so it requires a token.
 *
 * Environment variables override the file, so a container can be configured
 * without a config file: PORT, DEEPL_DASHBOARD_HOST,
 * DEEPL_DASHBOARD_ALLOWED_HOSTS (comma-separated).
 */
function validateServer(rawServer, env, errors, warnings, { allowOpenBind = false } = {}) {
    const server = { ...DEFAULT_SERVER, ...rawServer };
    const token = String(env[AUTH_TOKEN_ENV] || server.auth_token || "").trim();

    if (env[HOST_ENV] !== undefined && String(env[HOST_ENV]).trim()) server.host = String(env[HOST_ENV]).trim();
    if (env.PORT !== undefined) {
        const port = Number(env.PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            errors.push(`PORT must be an integer from 1 to 65535 (got "${env.PORT}")`);
        } else {
            server.port = port;
        }
    }

    if (server.allowed_hosts !== undefined && !Array.isArray(server.allowed_hosts)) {
        errors.push('server.allowed_hosts must be an array of hostnames');
    }
    const allowedHosts = (Array.isArray(server.allowed_hosts) ? server.allowed_hosts : [])
        .concat(String(env[ALLOWED_HOSTS_ENV] || "").split(","))
        .map((h) => String(h).trim().toLowerCase())
        .filter(Boolean);

    if (!isLoopbackHost(server.host) && !token && !allowOpenBind) {
        errors.push(
            `server.host is "${server.host}", which other machines can reach, but no access token is set. ` +
                `Set ${AUTH_TOKEN_ENV} (or server.auth_token), or use host "127.0.0.1".`
        );
    }
    if (token && token.length < MIN_TOKEN_LENGTH) {
        errors.push(
            `The dashboard access token must be at least ${MIN_TOKEN_LENGTH} characters. Generate one with: openssl rand -hex 24`
        );
    }
    if (rawServer.auth_token && !env[AUTH_TOKEN_ENV]) {
        warnings.push(`server.auth_token is stored in the config file; prefer the ${AUTH_TOKEN_ENV} environment variable`);
    }

    return { port: server.port, host: server.host, auth_token: token, allowed_hosts: allowedHosts };
}

/** Reads and validates config.json. Throws with a readable message on failure. */
function loadConfig() {
    const file = configPath();
    if (!fs.existsSync(file)) {
        throw new Error(
            `Config not found at ${file}. Run "npm run setup", or "npm run sample" to try it with sample data.`
        );
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        throw new Error(`Could not parse ${file}: ${err.message}`);
    }
    const { config, errors, warnings } = validateConfig(raw);
    if (errors.length) {
        throw new Error(`Invalid config:\n  - ${errors.join("\n  - ")}`);
    }
    const holdsSecrets = config.accounts.some((a) => !a.admin_api_key_env) || (raw.server && raw.server.auth_token);
    const permWarning = holdsSecrets && permissionWarning(file);
    if (permWarning) warnings.push(permWarning);
    return { config, warnings };
}

/**
 * Server settings for sample mode, which has no config file. Throws with a
 * readable message on failure. Sample mode serves synthetic data and holds no
 * keys, so it may listen beyond loopback without a token (e.g. an internal
 * demo); real-account mode never may.
 */
function sampleServerConfig(env = process.env) {
    const errors = [];
    const warnings = [];
    const server = validateServer({}, env, errors, warnings, { allowOpenBind: true });
    if (errors.length) throw new Error(`Invalid server settings:\n  - ${errors.join("\n  - ")}`);
    return { server, warnings };
}

module.exports = {
    REGION_HOSTS, REGIONS, DEFAULT_REGION, DEFAULT_SERVER,
    AUTH_TOKEN_ENV, HOST_ENV, ALLOWED_HOSTS_ENV, SAMPLE_ENV, MIN_TOKEN_LENGTH,
    isTruthyEnv, configPath, validateConfig, sampleServerConfig, loadConfig,
};
