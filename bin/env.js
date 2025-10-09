#!/usr/bin/env node
/**
 * Poyesis Env CLI
 *
 * Commands:
 *   env create              - create secrets for entries with empty "secret" in envs.json (reads local files)
 *   env push              - push local file content for entries with a "secret"
 *   env pull                - pull envs for entries with a "secret" in envs.json and write local files
 *   env pull {secret}       - pull a single secret and write to .env (or --path), then upsert envs.json
 *
 * Examples:
 *   npx env create
 *   npx env push
 *   npx env pull
 *   npx env pull c6967... --path .production.env
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { env: ENV } = process;

const argv = parseArgs(process.argv.slice(2));
const cmd = argv._[0];
const maybeSecretArg = argv._[1]; // supports: env pull {secret}

// Config + defaults
const CONFIG_PATH = path.resolve(argv.config || argv.c || "envs.json");
const BASE_URL = (
  argv["base-url"] ||
  argv.u ||
  ENV.POYESIS_ENV_BASE_URL ||
  "https://api.poyesis.fr"
).replace(/\/+$/, "");
const READ_PATH = argv["read-path"] || "/env/read-cli/{secret}";
const CREATE_PATH = argv["create-path"] || "/env/create-cli";
const PUSH_PATH = argv["push-path"] || "/env/push-cli/{secret}";
const SINGLE_PULL_PATH = argv.path || argv.p || ".env";
const MAP_NAME = argv.name || null;
const QUIET = !!(argv.quiet || argv.q);

main().catch((err) => {
  logError(err?.stack || err?.message || String(err));
  process.exit(1);
});

async function main() {
  if (!cmd || !["create", "push", "pull"].includes(cmd)) {
    printHelp();
    process.exit(cmd ? 2 : 0);
  }

  // Special case: `env pull {secret}` (single pull + upsert envs.json)
  if (
    cmd === "pull" &&
    typeof maybeSecretArg === "string" &&
    maybeSecretArg.trim() !== ""
  ) {
    await doPullSingle(maybeSecretArg.trim(), SINGLE_PULL_PATH, MAP_NAME);
    return;
  }

  // envs.json driven flows
  const items = await loadConfig(CONFIG_PATH);
  if (!Array.isArray(items)) {
    throw new Error(
      `Invalid ${CONFIG_PATH}: expected an array of { name, secret }`
    );
  }

  switch (cmd) {
    case "create":
      await doCreate(items);
      break;
    case "push":
      await doPush(items);
      break;
    case "pull":
      await doPull(items);
      break;
  }
}

/** CREATE: For entries with empty secret, read local file, POST to create, store returned secret to envs.json */
async function doCreate(items) {
  let changed = false;

  for (const item of items) {
    const { name, secret } = item || {};
    if (!name) {
      warn(`create: skipping entry without "name"`);
      continue;
    }
    if (secret && String(secret).trim() !== "") {
      info(`create: ${name} already has a secret, skipping`);
      continue;
    }

    const filePath = path.resolve(name);
    if (!fs.existsSync(filePath)) {
      warn(`create: ${name} missing locally, skipping (no file to upload)`);
      continue;
    }

    const envText = await fsp.readFile(filePath, "utf8");
    if (!envText.trim()) {
      warn(`create: ${name} is empty, skipping`);
      continue;
    }

    const url = `${BASE_URL}${ensureLeadingSlash(CREATE_PATH)}`;
    info(`create: POST ${url} (name="${name}")`);

    const res = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, env: envText }),
    });

    if (!res || !res.secret)
      throw new Error(`API did not return a "secret" for ${name}`);

    item.secret = String(res.secret);
    info(`create: ${name} → secret saved`);
    changed = true;
  }

  if (changed) {
    await saveConfig(CONFIG_PATH, items);
    info(`create: updated ${CONFIG_PATH}`);
  }
}

/** PUSH: For entries with secret, read local file and PUT to push endpoint */
async function doPush(items) {
  for (const item of items) {
    const { name, secret } = item || {};
    if (!name || !secret) {
      warn(`push: skipping ${name || "(no name)"} (missing secret)`);
      continue;
    }

    const filePath = path.resolve(name);
    if (!fs.existsSync(filePath)) {
      warn(`push: ${name} missing locally, skipping`);
      continue;
    }

    const envText = await fsp.readFile(filePath, "utf8");
    const url = `${BASE_URL}${ensureLeadingSlash(
      PUSH_PATH.replace("{secret}", encodeURIComponent(secret))
    )}`;

    info(`push: PUT ${url} (name="${name}")`);

    await fetchJson(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: envText }),
    });

    info(`push: ${name} pushed`);
  }
}

/** PULL (multi): For entries with secret, GET remote and write/overwrite local file */
async function doPull(items) {
  for (const item of items) {
    const { name, secret } = item || {};
    if (!name || !secret) {
      warn(`pull: skipping ${name || "(no name)"} (missing secret)`);
      continue;
    }
    await pullToFile(secret, name);
  }
}

/** PULL (single): env pull {secret} -> write to specified path (default: .env) and upsert envs.json */
async function doPullSingle(secret, filePath, mapName) {
  info(`pull: single secret → writing to ${filePath}`);
  await pullToFile(secret, filePath);

  // Upsert envs.json with { name, secret }
  const name = mapName || filePath; // default mapping name = output file path
  await upsertConfigEntry(CONFIG_PATH, name, secret);
  info(`pull: updated ${CONFIG_PATH} with { name: "${name}" }`);
}

/** Core pull helper */
async function pullToFile(secret, filePath) {
  const url = `${BASE_URL}${ensureLeadingSlash(
    READ_PATH.replace("{secret}", encodeURIComponent(secret))
  )}`;
  info(`pull: GET ${url}`);

  const res = await fetchJson(url, { method: "GET" });
  const envText = res && typeof res.env === "string" ? res.env : "";
  if (!envText) {
    warn(`pull: secret returned empty env`);
    return;
  }

  const abs = path.resolve(filePath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, envText, "utf8");
  await fsp.chmod(abs, 0o600);
  info(`pull: wrote ${abs} (${envText.length} bytes)`);
}

/* -------------------- config helpers -------------------- */

async function loadConfig(p) {
  if (!fs.existsSync(p)) {
    throw new Error(
      `Config file not found: ${p}\nCreate one like: [{"name":".env","secret":""},{"name":".production.env","secret":""}]`
    );
  }
  const raw = await fsp.readFile(p, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${p}`);
  }
}

async function saveConfig(p, obj) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  await fsp.writeFile(p, text, "utf8");
}

async function upsertConfigEntry(configPath, name, secret) {
  let items = [];
  try {
    items = await loadConfig(configPath);
  } catch {
    items = [];
  }
  const idx = items.findIndex((x) => x && x.name === name);
  if (idx >= 0) items[idx].secret = secret;
  else items.push({ name, secret });
  await saveConfig(configPath, items);
}

/* -------------------- misc utils -------------------- */

function ensureLeadingSlash(s) {
  return s.startsWith("/") ? s : "/" + s;
}

async function fetchJson(url, init) {
  // Node 18+ has global fetch; if you target older Node, add node-fetch
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${body}`);
  }
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [k, v] = a.split("=");
      if (v !== undefined) out[k.slice(2)] = v;
      else if (i + 1 < args.length && !args[i + 1].startsWith("-"))
        out[a.slice(2)] = args[++i];
      else out[a.slice(2)] = true;
    } else if (a.startsWith("-")) {
      const k = a.slice(1);
      if (i + 1 < args.length && !args[i + 1].startsWith("-"))
        out[k] = args[++i];
      else out[k] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function info(msg) {
  if (!QUIET) console.log(msg);
}
function warn(msg) {
  console.warn(msg);
}
function logError(msg) {
  console.error(msg);
}

function printHelp() {
  console.log(`
Poyesis Env CLI
Usage:
  npx env <command>

Commands:
  create                    Create secrets for entries with empty "secret" (reads envs.json)
  push                      Push local file content to API for entries with "secret"
  pull                      Pull envs for entries with "secret" (reads envs.json)
  pull {secret}             Pull a single secret and write to .env (or --path), then upsert envs.json

envs.json example:
[
  { "name": ".env", "secret": "" },
  { "name": ".production.env", "secret": "" }
]
`);
}
