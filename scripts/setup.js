#!/usr/bin/env node

/**
 * Interactive setup: collects a name, region, and Admin API key for each
 * DeepL account, checks each key against the Admin API, and writes config.json.
 */
const fs = require("fs");
const readline = require("readline/promises");
const { configPath, validateConfig, REGIONS, REGION_HOSTS, DEFAULT_REGION, DEFAULT_SERVER } = require("../lib/config");
const { fetchAccountDaily } = require("../lib/deepl");
const { addDays } = require("../public/aggregate");

async function askAccount(rl, index) {
    console.log(`\nAccount ${index + 1}`);
    let name = "";
    while (!name) name = (await rl.question("  Display name (e.g. Production EU): ")).trim();

    // An account's keys work only on its own region's endpoint, so the region
    // decides which API host is called.
    let region;
    while (!region) {
        const answer = (await rl.question(`  Account region [${REGIONS.join("/")}, default ${DEFAULT_REGION}]: `)).trim().toUpperCase();
        if (!answer) region = DEFAULT_REGION;
        else if (REGIONS.includes(answer)) region = answer;
    }

    let key = "";
    while (!key) key = (await rl.question("  Admin API key (ends in :adm): ")).trim();

    return { name, region, admin_api_key: key };
}

async function checkAccount(account) {
    const today = new Date().toISOString().slice(0, 10);
    process.stdout.write(`  Checking ${account.name} [${account.region}]... `);
    try {
        await fetchAccountDaily(account, addDays(today, -1), today);
        console.log("OK");
        return true;
    } catch (err) {
        console.log(`FAILED\n    ${err.message}`);
        return false;
    }
}

async function main() {
    const file = configPath();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log("DeepL multi-account usage dashboard - setup");
    console.log("You'll need one Admin API key (ending in :adm) per DeepL account.");
    console.log("Create one in each account under API Keys & Limits > Admin API Keys: https://www.deepl.com/your-account/keys?keyType=admin");

    let accounts = [];
    let server;
    if (fs.existsSync(file)) {
        const existing = JSON.parse(fs.readFileSync(file, "utf8"));
        const count = (existing.accounts || []).length;
        const answer = (await rl.question(`\n${file} already has ${count} account(s). Keep them and add more? [Y/n]: `)).trim().toLowerCase();
        if (answer !== "n") accounts = existing.accounts || [];
        server = existing.server;
    }

    do {
        accounts.push(await askAccount(rl, accounts.length));
    } while ((await rl.question("\nAdd another account? [y/N]: ")).trim().toLowerCase() === "y");

    // Only the accounts are validated here; the server block is written back as-is.
    const { config, errors, warnings } = validateConfig({ accounts });
    warnings.forEach((w) => console.warn(`WARNING: ${w}`));
    if (errors.length) {
        console.error(`\nNot saved - fix these and run setup again:\n  - ${errors.join("\n  - ")}`);
        rl.close();
        process.exit(1);
    }

    console.log("\nChecking keys against the Admin API:");
    const results = [];
    for (const account of config.accounts) results.push(await checkAccount(account));

    if (results.includes(false)) {
        const answer = (await rl.question("\nSome keys failed. Save anyway? [y/N]: ")).trim().toLowerCase();
        if (answer !== "y") {
            rl.close();
            process.exit(1);
        }
    }
    rl.close();

    // Keep env var references as references, and write the server block as the
    // user wrote it, so secrets resolved from the environment never land in the file.
    const output = {
        accounts: config.accounts.map(({ name, region, base_url, admin_api_key, admin_api_key_env }) => ({
            name,
            region,
            ...(base_url !== REGION_HOSTS[region] ? { base_url } : {}),
            ...(admin_api_key_env ? { admin_api_key_env } : { admin_api_key }),
        })),
        server: server || { port: DEFAULT_SERVER.port, host: DEFAULT_SERVER.host },
    };
    fs.writeFileSync(file, JSON.stringify(output, null, 4) + "\n", { mode: 0o600 });
    // The mode option only applies when the file is created; tighten an existing one too.
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    console.log(`\nSaved ${output.accounts.length} account(s) to ${file}. Run "npm start" to open the dashboard.`);
}

main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
});
