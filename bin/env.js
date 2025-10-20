#!/usr/bin/env node
/**
 * Poyesis Env CLI
 *
 * Schema (envs.json):
 * {
 *   "project": "archlist",
 *   "envs": [
 *     { "name": ".env", "secret": "..." },
 *     { "name": ".env.local", "secret": "..." }
 *   ]
 * }
 *
 * Commands:
 *   env init <project> <category> - fetch remote env list, create local .env files (optional overwrite), fill/merge envs.json
 *   env create                    - scan, merge into envs.json, POST {project, name, env} for items missing "secret", save secrets
 *   env push                      - push local file content for entries with a "secret"
 *   env pull                      - pull envs for entries with a "secret" (reads envs.json) and write local files
 *   env pull {secret}             - pull a single secret and write to .env (or --path), then upsert envs.json (overwrite if name exists)
 *
 * Flags (selected):
 *   -c, --config <path>    path to envs.json (default: ./envs.json)
 *   -u, --base-url <url>   API base URL (default: $POYESIS_ENV_BASE_URL or https://api.poyesis.fr)
 *       --list-path <tpl>  list endpoint template (default: /env/list-cli/{project})
 *       --read-path <tpl>  read endpoint template (default: /env/read-cli/{secret})
 *       --create-path <p>  create endpoint path (default: /env/create-cli)
 *       --push-path <tpl>  push endpoint template (default: /env/push-cli/{secret})
 *       --overwrite        for init: overwrite local files if they already exist (default: false)
 *   -p, --path <file>      for 'pull {secret}': output file (default: .env)
 *       --name <name>      mapping name stored in envs.json for 'pull {secret}' (default: --path)
 *
 * Examples:
 *   npx env init archlist
 *   npx env create
 *   npx env push
 *   npx env pull
 *   npx env pull c6967... --path .env.production
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { env: ENV } = process;

const argv = parseArgs(process.argv.slice(2));
let cmd = argv._[0];
const arg1 = argv._[2]; // used by: init <project> <category>, pull {secret}

const CONFIG_PATH = path.resolve(argv.config || argv.c || "envs.json");
const BASE_URL = (
  argv["base-url"] ||
  argv.u ||
  ENV.POYESIS_ENV_BASE_URL ||
  "https://api.poyesis.fr"
).replace(/\/+$/, "");
const LIST_PATH = argv["list-path"] || "/env/list-cli/{project}/{category}";
const READ_PATH = argv["read-path"] || "/env/read-cli/{secret}";
const CREATE_PATH = argv["create-path"] || "/env/create-cli";
const PUSH_PATH = argv["push-path"] || "/env/push-cli/{secret}";
const SINGLE_PULL_PATH = argv.path || argv.p || ".env";
const MAP_NAME = argv.name || null;
const OVERWRITE = !!argv.overwrite; // affects init only
const QUIET = !!(argv.quiet || argv.q);

main().catch((err) => {
  logError(err?.stack || err?.message || String(err));
  process.exit(1);
});

async function main() {
  if (!cmd || !["init", "create", "push", "pull"].includes(cmd)) {
    printHelp();
    process.exit(cmd ? 2 : 0);
  }

  // `env pull {secret}` (single pull + upsert envs.json)
  if (cmd === "pull" && typeof arg1 === "string" && arg1.trim() !== "") {
    const cfg = await safeLoadConfigObj(CONFIG_PATH);
    await doPullSingle(cfg, arg1.trim(), SINGLE_PULL_PATH, MAP_NAME);
    return;
  }

  // `env init <project> <category>`: fetch list, write local files, fill/merge envs.json
  if (cmd === "init") {
    const projectFromArg = (arg1 || "").trim();
    const categoryFromArg = (arg2 || "").trim();
    if (!projectFromArg) {
      logError(
        "init: missing <project> name. Usage: npx env init <project> <category>"
      );
      process.exit(2);
    }

    if (!categoryFromArg) {
      logError(
        "init: missing <category> name. Usage: npx env init <project> <category>"
      );
      process.exit(2);
    }

    await doInit(projectFromArg, categoryFromArg);
    return;
  }

  // envs.json-driven flows
  const cfg = await safeLoadConfigObj(CONFIG_PATH); // { project, envs: [] }
  switch (cmd) {
    case "create":
      await doCreate(cfg);
      break;
    case "push":
      await doPush(cfg);
      break;
    case "pull":
      await doPull(cfg);
      break;
  }
}

/* -------------------- commands -------------------- */

/** INIT:
 *  - fetch remote list for project
 *  - write local files (env text), if --overwrite or file not exists
 *  - upsert envs.json with { project, envs: [{ name, secret }] } (overwrite secret if name exists)
 */
async function doInit(projectName, category) {
  // Fetch remote list
  const listUrl = `${BASE_URL}${ensureLeadingSlash(
    LIST_PATH.replace("{project}", encodeURIComponent(projectName)).replace(
      "{category}",
      encodeURIComponent(category)
    )
  )}`;
  info(`init: GET ${listUrl}`);
  const listResp = await fetchJson(listUrl, { method: "GET" });

  // Normalize response to array of { name, secret, env? }
  const remoteItemsRaw = Array.isArray(listResp)
    ? listResp
    : Array.isArray(listResp?.envs)
    ? listResp.envs
    : [];
  const remoteItems = remoteItemsRaw
    .map((x) => ({
      name: x?.name,
      secret: x?.secret || "",
      env: typeof x?.env === "string" ? x.env : null,
    }))
    .filter((x) => !!x.name);

  // Ensure we have env text for each; if not in the list payload, fetch via read
  for (const item of remoteItems) {
    if (item.env == null && item.secret) {
      item.env = await pullToString(item.secret);
    }
  }

  // Write local files
  for (const { name, env } of remoteItems) {
    if (typeof env !== "string") continue;
    const abs = path.resolve(name);
    const exists = fs.existsSync(abs);
    if (exists && !OVERWRITE) {
      info(`init: ${name} exists (skipped). Use --overwrite to replace.`);
      continue;
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, env, "utf8");
    await fsp.chmod(abs, 0o600);
    info(`init: wrote ${abs} (${env.length} bytes)`);
  }

  // Merge into envs.json (set project; upsert secrets for names)
  const existing = await safeLoadConfigObj(CONFIG_PATH);
  let merged = {
    project: projectName,
    envs: Array.isArray(existing.envs) ? [...existing.envs] : [],
  };
  for (const { name, secret } of remoteItems) {
    merged = upsertEnvMapping(merged, name, secret); // overwrite if name exists
  }
  await saveConfigObj(CONFIG_PATH, merged);
  info(
    `init: updated ${CONFIG_PATH} with project="${projectName}" and ${
      merged.envs.length
    } env entr${merged.envs.length === 1 ? "y" : "ies"}`
  );
}

/** CREATE: scan -> merge -> POST {project, name, env} for items missing secret -> save secrets */
async function doCreate(cfg) {
  // 1) scan for .env files (include newly added)
  const discovered = await scanEnvFiles(process.cwd());

  // 2) merge into config (preserve existing secrets; add new names with empty secret)
  const merged = mergeEnvConfigObj(cfg, discovered);
  await saveConfigObj(CONFIG_PATH, merged);
  info(
    `create: wrote ${CONFIG_PATH} with project="${merged.project || ""}" and ${
      merged.envs.length
    } entr${merged.envs.length === 1 ? "y" : "ies"}`
  );

  // 3) create secrets for entries missing `secret`
  if (!merged.project)
    warn(`create: no "project" in ${CONFIG_PATH}. Run: npx env init <project>`);

  let changed = false;
  for (const item of merged.envs) {
    const { name, secret } = item || {};
    if (!name) continue;
    if (secret && String(secret).trim() !== "") {
      info(`create: ${name} already has a secret, skipping`);
      continue;
    }

    const filePath = path.resolve(name);
    if (!fs.existsSync(filePath)) {
      warn(`create: ${name} missing locally, skipping secret creation`);
      continue;
    }

    const envText = await fsp.readFile(filePath, "utf8");
    if (!envText.trim()) {
      warn(`create: ${name} is empty, skipping secret creation`);
      continue;
    }

    const url = `${BASE_URL}${ensureLeadingSlash(CREATE_PATH)}`;
    info(
      `create: POST ${url} (project="${merged.project || ""}", name="${name}")`
    );

    const payload = { name, env: envText };
    if (merged.project) payload.project = merged.project;

    const res = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res || !res.secret)
      throw new Error(`API did not return a "secret" for ${name}`);

    item.secret = String(res.secret);
    info(`create: ${name} → secret saved`);
    changed = true;
  }

  if (changed) {
    await saveConfigObj(CONFIG_PATH, merged);
    info(`create: updated ${CONFIG_PATH} with new secrets`);
  }
}

/** PUSH: PUT { env } to /env/push-cli/{secret} for each entry with secret */
async function doPush(cfg) {
  if (!cfg.envs?.length) {
    warn(
      `push: no entries in ${CONFIG_PATH} (run "npx env init <project> <category>" and/or "npx env create")`
    );
    return;
  }

  for (const item of cfg.envs) {
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

/** PULL (multi): GET -> write files for entries with secret */
async function doPull(cfg) {
  if (!cfg.envs?.length) {
    warn(
      `pull: no entries in ${CONFIG_PATH} (run "npx env init <project> <category>" and "npx env create")`
    );
    return;
  }
  for (const item of cfg.envs) {
    const { name, secret } = item || {};
    if (!name || !secret) {
      warn(`pull: skipping ${name || "(no name)"} (missing secret)`);
      continue;
    }
    await pullToFile(secret, name);
  }
}

/** PULL (single): env pull {secret} -> write to --path (default .env) + upsert mapping into envs.json (overwrite if name exists) */
async function doPullSingle(cfg, secret, filePath, mapName) {
  info(`pull: single secret → writing to ${filePath}`);
  await pullToFile(secret, filePath);

  const name = mapName || filePath;
  const merged = upsertEnvMapping(cfg, name, secret); // overwrite if exists
  await saveConfigObj(CONFIG_PATH, merged);
  info(`pull: updated ${CONFIG_PATH} with { name: "${name}" }`);
}

/* -------------------- helpers -------------------- */

async function pullToString(secret) {
  const url = `${BASE_URL}${ensureLeadingSlash(
    READ_PATH.replace("{secret}", encodeURIComponent(secret))
  )}`;
  const res = await fetchJson(url, { method: "GET" });
  return res && typeof res.env === "string" ? res.env : "";
}

async function pullToFile(secret, filePath) {
  const envText = await pullToString(secret);
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

/* ---------- config + scanning (unchanged from prior) ---------- */

function emptyConfig() {
  return { project: "", envs: [] };
}

async function safeLoadConfigObj(p) {
  try {
    if (!fs.existsSync(p)) return emptyConfig();
    const raw = await fsp.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    const envs = Array.isArray(parsed?.envs)
      ? parsed.envs
          .map((x) => ({ name: x?.name, secret: x?.secret || "" }))
          .filter((x) => !!x.name)
      : [];
    const project = typeof parsed?.project === "string" ? parsed.project : "";
    return { project, envs };
  } catch {
    return emptyConfig();
  }
}

async function saveConfigObj(p, obj) {
  const clean = {
    project: obj.project || "",
    envs: (obj.envs || []).map((x) => ({
      name: x.name,
      secret: x.secret || "",
    })),
  };
  const text = JSON.stringify(clean, null, 2) + "\n";
  await fsp.writeFile(p, text, "utf8");
}

function upsertEnvMapping(cfg, name, secret) {
  const out = {
    project: cfg.project || "",
    envs: Array.isArray(cfg.envs) ? [...cfg.envs] : [],
  };
  const idx = out.envs.findIndex((e) => e?.name === name);
  if (idx >= 0) out.envs[idx].secret = secret;
  else out.envs.push({ name, secret });
  out.envs.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function mergeEnvConfigObj(cfg, discoveredPaths) {
  const out = {
    project: cfg.project || "",
    envs: Array.isArray(cfg.envs) ? [...cfg.envs] : [],
  };
  const byName = new Map(out.envs.map((e) => [e.name, e]));
  for (const p of discoveredPaths) {
    if (!byName.has(p)) byName.set(p, { name: p, secret: "" }); // new -> empty secret
  }
  out.envs = Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  return out;
}

const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "out",
  ".vercel",
  ".cache",
]);

function looksLikeEnvFile(basename) {
  return (
    /^\.env(\..+)?$/i.test(basename) || // .env, .env.local, .env.prod
    /^\..+\.env$/i.test(basename) // .production.env, .staging.env
  );
}

async function scanEnvFiles(rootDir) {
  const results = new Set();
  await walk(rootDir, results);
  return Array.from(results).sort();
}

async function walk(dir, results) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const name = ent.name;
    const full = path.join(dir, name);

    if (ent.isDirectory()) {
      if (DEFAULT_IGNORES.has(name)) continue;
      if (name.startsWith(".") && name !== ".") continue;
      await walk(full, results);
    } else if (ent.isFile()) {
      const base = path.basename(full);
      if (looksLikeEnvFile(base)) {
        const rel = path.relative(process.cwd(), full) || base;
        results.add(rel);
      }
    }
  }
}

/* -------------------- misc utils -------------------- */

function ensureLeadingSlash(s) {
  return s.startsWith("/") ? s : "/" + s;
}

async function fetchJson(url, init) {
  // Node 18+ has global fetch
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
  npx env <command> [options]

Commands:
  init <project> <category> Fetch remote env list, create local .env files (use --overwrite to replace), and fill envs.json
  create                    Scan repo for .env files, merge into envs.json, then create secrets for entries missing "secret"
  push                      Push local file content to API for entries with "secret"
  pull                      Pull envs for entries with "secret" (reads envs.json)
  pull {secret}             Pull a single secret and write to .env (or --path), then upsert envs.json (overwrite if name exists)

Options:
  -c, --config <path>       Path to envs.json (default: ./envs.json)
  -u, --base-url <url>      API base URL (default: $POYESIS_ENV_BASE_URL or https://api.poyesis.fr)
      --list-path <tpl>     List endpoint template (default: /env/list-cli/{project})
      --read-path <tpl>     Read endpoint template (default: /env/read-cli/{secret})
      --create-path <path>  Create endpoint path (default: /env/create-cli) [POST {project?, name, env}]
      --push-path <tpl>     Push endpoint template (default: /env/push-cli/{secret}) [PUT {env}]
      --overwrite           For init: overwrite local files if they already exist (default: false)
  -p, --path <file>         File to write for 'pull {secret}' (default: .env)
      --name <name>         Mapping name stored in envs.json for 'pull {secret}' (default: --path)

envs.json example:
{
  "project": "archlist",
  "envs": [
    { "name": ".env", "secret": "" },
    { "name": ".env.local", "secret": "" },
    { "name": ".env.production", "secret": "" }
  ]
}
`);
}
