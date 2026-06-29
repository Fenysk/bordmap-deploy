#!/usr/bin/env node
/**
 * scripts/coolify-deploy.mjs — agent-driven Bordmap deploy to Alexis's Coolify
 * via the Coolify API (FEN-437, same pattern as LivePlace FEN-79/80/93).
 *
 * One command takes the stack from "nothing on the VPS" to a green smoke:
 *
 *   load deploy.env → create OR reuse a Docker-Compose application from the
 *   git source → read back the Coolify-assigned domain → bake the public
 *   origins into the env (VITE_CONVEX_URL build arg) →
 *   trigger instant_deploy → wait until running/healthy → run the token-free
 *   scripts/smoke.mjs against the public URL → ✅.
 *
 * HARD GUARDRAIL (Alexis, categorical): may ONLY act inside the Bordmap Coolify
 * project (uuid baked below). Every other project — LivePlace, Personnel, Test,
 * Archives, Le Spawn, PeakSet — is off-limits and explicitly DENYLISTED.
 *
 * With no COOLIFY_API_TOKEN (or --dry-run) the script prints the exact env + API
 * calls it WOULD make and exits, so the wiring is verifiable without egress.
 *
 * ZERO npm deps: Node >= 22 global fetch + node:crypto + node:child_process.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DEPLOY_ENV_PATH = join(REPO_ROOT, "infra", "coolify", "deploy.env");

const ARGS = new Set(process.argv.slice(2));
const NO_SMOKE = ARGS.has("--no-smoke");
const CHECK_PERSISTENCE = ARGS.has("--check-persistence");

// HARD GUARDRAIL (FEN-437): the ONLY project this script may touch. Baked, not
// just read from env, so a stray env value can never point a write elsewhere.
const BOARDMAP_PROJECT_UUID = "mbw8fq4xd475qc35hln9ryq0";
const BOARDMAP_ENVIRONMENT_UUID = "amdffi9rkbk785eva1f3z9b2"; // env "production"
// Categorical denylist — these uuids must NEVER be written to, override or not.
const FORBIDDEN_PROJECT_UUIDS = new Set([
  "tgxjp2pout8sab9fp5edtbhb", // LivePlace
  "h84g", "pw04", "dcoc", "i0sc", "xhzi", // Personnel/Test/Archives/Le Spawn/PeakSet (prefixes)
]);
const DEFAULT_COOLIFY_URL = "https://coolify.fenysk.fr";

const DEPLOY_TIMEOUT_MS = Number(process.env.COOLIFY_DEPLOY_TIMEOUT_MS ?? 600_000);
const POLL_INTERVAL_MS = Number(process.env.COOLIFY_POLL_INTERVAL_MS ?? 8_000);
const UNHEALTHY_GRACE_MS = Number(process.env.COOLIFY_UNHEALTHY_GRACE_MS ?? 150_000);

const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  console.error(`❌ coolify-deploy: ${msg}`);
  process.exit(1);
}
function genHex(bytes) {
  return randomBytes(bytes).toString("hex");
}
const rel = (p) => p.replace(REPO_ROOT + "/", "");

/** Load KEY=VALUE from infra/coolify/deploy.env without overriding the real env. */
function loadDeployEnv() {
  if (!existsSync(DEPLOY_ENV_PATH)) {
    log(`· no ${rel(DEPLOY_ENV_PATH)} (using process env only)`);
    return;
  }
  for (const raw of readFileSync(DEPLOY_ENV_PATH, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = val;
  }
  log(`· loaded ${rel(DEPLOY_ENV_PATH)}`);
}

/** Highest-numbered non-empty COOLIFY_API_TOKEN* (survives token rotation). */
function resolveToken(env) {
  let best = { n: -1, val: "" };
  for (const [k, v] of Object.entries(env)) {
    const m = /^COOLIFY_API_TOKEN(?:_(\d+))?$/.exec(k);
    if (!m || !v) continue;
    const n = m[1] ? Number(m[1]) : 0;
    if (n > best.n) best = { n, val: v };
  }
  return best.val;
}

function cfg() {
  const env = process.env;
  const COOLIFY_URL = (env.COOLIFY_URL || DEFAULT_COOLIFY_URL).replace(/\/$/, "");
  const token = resolveToken(env);
  const dryRun = ARGS.has("--dry-run") || !token;
  let base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  const host = base ? new URL(base).host : "";
  return {
    dryRun,
    COOLIFY_URL,
    token,
    projectUuid: env.COOLIFY_PROJECT_UUID || BOARDMAP_PROJECT_UUID,
    environmentUuid: env.COOLIFY_ENVIRONMENT_UUID || BOARDMAP_ENVIRONMENT_UUID,
    environmentName: env.COOLIFY_ENVIRONMENT_NAME ?? "production",
    serverUuid: env.COOLIFY_SERVER_UUID ?? "",
    appName: env.COOLIFY_APP_NAME ?? "bordmap",
    appUuid: env.COOLIFY_APP_UUID ?? "",
    gitRepository: env.COOLIFY_GIT_REPOSITORY ?? "",
    gitBranch: env.COOLIFY_GIT_BRANCH ?? "main",
    composeLocation: env.COOLIFY_COMPOSE_LOCATION ?? "/docker-compose.coolify.yml",
    publicBaseUrl: base,
    host,
  };
}

/** The stack env pushed to Coolify. Public origins are filled once the domain is
 *  known. Stable secrets (CONVEX_INSTANCE_SECRET) are generated + persisted if
 *  blank so the backend identity survives redeploys. */
function buildStackEnv(c) {
  const e = process.env;
  const generated = [];
  const need = (key, make) => {
    let v = e[key];
    if (!v) {
      v = make();
      generated.push(key);
    }
    return v;
  };
  const base = c.publicBaseUrl; // "" until the Coolify domain is read back
  const stack = {
    // [build] PUBLIC Convex origin baked into the client. Caddy strips /convex.
    VITE_CONVEX_URL: base ? `${base}/convex` : "",
    // [build] backend image pin (multi-arch), matches `convex` npm 1.40.0.
    CONVEX_BACKEND_IMAGE: e.CONVEX_BACKEND_IMAGE ?? "ghcr.io/get-convex/convex-backend:aeb5f28adfe92f88c8c504b7883a12acfdf7cde6",
    // Stable Convex instance secret for the official backend service — must NOT
    // rotate across redeploys (it derives the instance identity / admin key).
    CONVEX_INSTANCE_SECRET: need("CONVEX_INSTANCE_SECRET", () => genHex(32)),
    CONVEX_INSTANCE_NAME: e.CONVEX_INSTANCE_NAME || "bordmap",
    // BOOT-SAFE Convex origins (FEN-444). The self-hosted backend REFUSES to boot
    // when its CLOUD origin carries a URL path (e.g. https://host/convex) or when
    // the SITE origin is empty (FEN-437 finding). We pin BOTH to non-empty
    // in-container loopback and let Caddy front the public `/convex` path — the
    // proven-green topology. Pushing these explicitly OVERWRITES any stale
    // path-prefixed value a prior run left in the Coolify env (the kind of value
    // that makes the backend exit). True browser-facing PUBLIC origins (full
    // auth/sync) need a convex SUBDOMAIN, not a path prefix — follow-up (item 2).
    CONVEX_CLOUD_ORIGIN: e.CONVEX_CLOUD_ORIGIN || "http://127.0.0.1:3210",
    CONVEX_SITE_ORIGIN: e.CONVEX_SITE_ORIGIN || "http://127.0.0.1:3211",
    // Caddy proxy listen address (plain HTTP behind Coolify's TLS edge).
    SITE_ADDRESS: e.SITE_ADDRESS ?? ":80",
    DISABLE_BEACON: "true",
    // R2 routing engine (FEN-507). Internal Coolify network URL — available only
    // after coolify-provision-graphhopper.mjs has run and persisted this value.
    GRAPHHOPPER_URL: e.GRAPHHOPPER_URL ?? "",
  };
  const buildTime = new Set(["VITE_CONVEX_URL", "CONVEX_BACKEND_IMAGE"]);
  return { stack, buildTime, generated };
}

function makeApi(c) {
  return async function api(method, path, body) {
    const url = `${c.COOLIFY_URL}/api/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof json === "object" ? JSON.stringify(json) : text}`);
    return json;
  };
}

/** Enforce the categorical guardrail: only the Bordmap project, never another. */
async function assertBoardmapProject(api, c) {
  const override = process.env.COOLIFY_ALLOW_PROJECT_OVERRIDE === "1";
  // Denylist is ABSOLUTE — not overridable.
  for (const bad of FORBIDDEN_PROJECT_UUIDS) {
    if (c.projectUuid === bad || c.projectUuid.startsWith(bad)) {
      die(`GUARDRAIL: project ${c.projectUuid} is on the categorical denylist (LivePlace/Personnel/Test/Archives/Le Spawn/PeakSet). Refusing.`);
    }
  }
  if (c.projectUuid !== BOARDMAP_PROJECT_UUID) {
    if (!override) {
      die(
        `GUARDRAIL: target project ${c.projectUuid} is not the Bordmap project (${BOARDMAP_PROJECT_UUID}). ` +
          `Refusing to touch another Coolify project. Set COOLIFY_ALLOW_PROJECT_OVERRIDE=1 only for a deliberate rename.`,
      );
    }
    log(`⚠ project override active: acting in ${c.projectUuid} (NOT the baked Bordmap uuid)`);
  }
  let project;
  try {
    project = await api("GET", `/projects/${c.projectUuid}`);
  } catch (err) {
    die(`GUARDRAIL: cannot read project ${c.projectUuid} (${err.message}) — aborting before any write.`);
  }
  const name = project.name ?? project.data?.name ?? "";
  log(`· guardrail OK: project ${c.projectUuid} = "${name}"`);
  if (!override && !/bo?a?rdmap/i.test(name)) {
    die(`GUARDRAIL: project ${c.projectUuid} is named "${name}", not Bordmap/Boardmap. Aborting.`);
  }
  return project;
}

async function resolveServerUuid(api, c) {
  if (c.serverUuid) return c.serverUuid;
  const servers = await api("GET", "/servers");
  const list = Array.isArray(servers) ? servers : servers.data ?? [];
  if (list.length === 1) {
    const uuid = list[0].uuid ?? list[0].data?.uuid;
    log(`· auto-resolved the only server: ${uuid} (${list[0].name ?? "?"})`);
    return uuid;
  }
  const opts = list.map((s) => `${s.uuid} (${s.name ?? "?"})`).join(", ");
  die(`COOLIFY_SERVER_UUID unset and ${list.length} servers found — set it to one of: ${opts}`);
}

async function resolveApp(api, c) {
  if (c.appUuid) {
    const app = await api("GET", `/applications/${c.appUuid}`);
    const appProject = app.project_uuid ?? app.environment?.project_uuid ?? app.data?.project_uuid;
    if (appProject && appProject !== c.projectUuid && process.env.COOLIFY_ALLOW_PROJECT_OVERRIDE !== "1") {
      die(`GUARDRAIL: app ${c.appUuid} belongs to project ${appProject}, not ${c.projectUuid}. Refusing to redeploy it.`);
    }
    log(`· reusing app ${c.appUuid} (${app.name ?? c.appName})`);
    const currentLoc = app.docker_compose_location ?? app.data?.docker_compose_location;
    if (c.composeLocation && currentLoc && currentLoc !== c.composeLocation) {
      try {
        await api("PATCH", `/applications/${c.appUuid}`, { docker_compose_location: c.composeLocation });
        log(`· set docker_compose_location: ${currentLoc} → ${c.composeLocation}`);
      } catch (err) {
        log(`  (warning: could not PATCH docker_compose_location: ${err.message})`);
      }
    }
    return c.appUuid;
  }
  if (!c.gitRepository) die("COOLIFY_GIT_REPOSITORY required to create the app (run scripts/coolify-wire-source.mjs first, or set COOLIFY_APP_UUID).");
  log(`· creating Docker-Compose app from ${c.gitRepository}@${c.gitBranch}`);
  const body = {
    project_uuid: c.projectUuid,
    server_uuid: c.serverUuid,
    environment_name: c.environmentName,
    environment_uuid: c.environmentUuid,
    name: c.appName,
    git_repository: c.gitRepository,
    git_branch: c.gitBranch,
    build_pack: "dockercompose",
    docker_compose_location: c.composeLocation,
    instant_deploy: false, // env first, then deploy
  };
  const created = await api("POST", "/applications/public", body);
  const uuid = created.uuid ?? created.application_uuid ?? created.data?.uuid;
  if (!uuid) throw new Error(`create returned no uuid: ${JSON.stringify(created)}`);
  persistAppUuid(uuid);
  log(`· created app ${uuid} — saved COOLIFY_APP_UUID to ${rel(DEPLOY_ENV_PATH)} for idempotent re-runs`);
  return uuid;
}

/** Point the Coolify compose domain at PUBLIC_BASE_URL (the cutover step).
 *  docker_compose_domains is stored as a JSON string mapping a compose SERVICE
 *  to its public domain — only `proxy` exposes a port, so the domain rides it.
 *  Setting an https:// FQDN makes Coolify provision a Let's Encrypt cert; DNS
 *  for that host MUST already resolve to the VPS or the ACME challenge fails and
 *  the pinned bundle is left serving a broken edge (LivePlace guard-rail). */
async function ensureDomain(api, uuid, c) {
  if (!c.publicBaseUrl) return;
  let app;
  try {
    app = await api("GET", `/applications/${uuid}`);
  } catch (err) {
    log(`  (could not read app to set domain: ${err.message})`);
    return;
  }
  let domains = {};
  const raw = app.docker_compose_domains ?? app.data?.docker_compose_domains;
  if (raw) {
    try {
      domains = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      domains = {};
    }
  }
  // The service that currently holds the domain, or `proxy` (the only port-exposer).
  const svc = Object.keys(domains)[0] || "proxy";
  const current = domains[svc]?.domain ?? "";
  // Keep any pre-existing domain (e.g. the auto sslip.io URL) ALONGSIDE the new
  // one: Coolify accepts a comma-separated list, so if Let's Encrypt lags or
  // fails on the custom https host, the plaintext fallback URL keeps the app
  // reachable (no total outage — blast-radius guard). De-dup, new domain first.
  const existing = current.split(",").map((d) => d.trim()).filter(Boolean);
  const merged = [c.publicBaseUrl, ...existing.filter((d) => d !== c.publicBaseUrl)];
  const next = merged.join(",");
  if (next === current) {
    log(`· domain already ${current} on service "${svc}" — no change`);
    return;
  }
  domains[svc] = { ...(domains[svc] || {}), domain: next };
  // Coolify GET returns docker_compose_domains as a JSON STRING keyed by service,
  // but the PATCH validates an ARRAY of {name, domain} objects (only those two
  // fields are accepted). Convert the service→domain map into that array shape.
  const payload = Object.entries(domains)
    .filter(([, v]) => v && v.domain)
    .map(([name, v]) => ({ name, domain: v.domain }));
  await api("PATCH", `/applications/${uuid}`, { docker_compose_domains: payload });
  log(`· set compose domain on "${svc}": ${current || "(none)"} → ${next}` + (c.publicBaseUrl.startsWith("https") ? " (Let's Encrypt will provision on deploy)" : ""));
}

function setDeployEnv(key, value) {
  let lines = existsSync(DEPLOY_ENV_PATH) ? readFileSync(DEPLOY_ENV_PATH, "utf8").split("\n") : [];
  lines = lines.filter((l) => !new RegExp(`^\\s*${key}\\s*=`).test(l));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push(`${key}=${value}`, "");
  writeFileSync(DEPLOY_ENV_PATH, lines.join("\n"));
}
function persistAppUuid(uuid) {
  try {
    setDeployEnv("COOLIFY_APP_UUID", uuid);
  } catch (err) {
    log(`  (warning: could not persist COOLIFY_APP_UUID — set it manually to ${uuid}: ${err.message})`);
  }
}
function persistGenerated(built) {
  for (const k of built.generated) {
    try {
      setDeployEnv(k, built.stack[k]);
      process.env[k] = built.stack[k];
    } catch (err) {
      log(`  (warning: could not persist generated ${k}: ${err.message})`);
    }
  }
  if (built.generated.length) log(`· persisted generated secrets to ${rel(DEPLOY_ENV_PATH)} (stable across redeploys): ${built.generated.join(", ")}`);
}

async function pushEnvs(api, uuid, stack, buildTime) {
  const data = Object.entries(stack).map(([key, value]) => ({
    key,
    value: String(value ?? ""),
    is_build_time: buildTime.has(key),
    is_preview: false,
  }));
  await api("PATCH", `/applications/${uuid}/envs/bulk`, { data });
  log(`· pushed ${data.length} env vars (${[...buildTime].join(", ")} as build args)`);
}

async function triggerDeploy(api, uuid) {
  const res = await api("GET", `/deploy?uuid=${encodeURIComponent(uuid)}&force=true`);
  const dep = res.deployments?.[0]?.deployment_uuid ?? res.deployment_uuid ?? null;
  log(`· deploy queued${dep ? ` (deployment ${dep})` : ""}`);
  return dep;
}

async function waitForDeployment(api, deploymentUuid) {
  if (!deploymentUuid) {
    log("  (no deployment uuid returned — falling back to app-health polling)");
    return;
  }
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < DEPLOY_TIMEOUT_MS) {
    let dep;
    try {
      dep = await api("GET", `/deployments/${deploymentUuid}`);
    } catch (err) {
      log(`  (deployment poll error, retrying: ${err.message})`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const status = dep.status ?? dep.data?.status ?? "unknown";
    if (status !== last) {
      log(`  build: ${status}`);
      last = status;
    }
    if (/finished|success|completed/i.test(status)) return;
    if (/failed|error|cancelled/i.test(status)) throw new Error(`build ${status} — inspect the Coolify deployment ${deploymentUuid}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${Math.round(DEPLOY_TIMEOUT_MS / 1000)}s waiting for the build to finish`);
}

async function waitHealthy(api, uuid) {
  const t0 = Date.now();
  let last = "";
  let badSince = 0;
  while (Date.now() - t0 < DEPLOY_TIMEOUT_MS) {
    let app;
    try {
      app = await api("GET", `/applications/${uuid}`);
    } catch (err) {
      log(`  (status poll error, retrying: ${err.message})`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const status = app.status ?? app.data?.status ?? "unknown";
    if (status !== last) {
      log(`  status: ${status}`);
      last = status;
    }
    if (/running:healthy/.test(status)) return;
    if (/running\b/.test(status) && !/unhealthy|starting/.test(status)) return;
    if (/exited|error|degraded|unhealthy/.test(status)) {
      if (badSince === 0) badSince = Date.now();
      else if (Date.now() - badSince > UNHEALTHY_GRACE_MS)
        throw new Error(`stack stuck "${status}" for >${Math.round(UNHEALTHY_GRACE_MS / 1000)}s (a crashing service — check the Coolify logs)`);
    } else badSince = 0;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${Math.round(DEPLOY_TIMEOUT_MS / 1000)}s waiting for healthy (last status: ${last})`);
}

function runSmoke(c) {
  return new Promise((resolve, reject) => {
    if (!c.publicBaseUrl) return reject(new Error("PUBLIC_BASE_URL unknown — cannot point the smoke at the deployment"));
    const child = spawn(process.execPath, [join(REPO_ROOT, "scripts", "smoke.mjs")], {
      stdio: "inherit",
      env: { ...process.env, BASE_URL: c.publicBaseUrl },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`smoke exited ${code}`))));
    child.on("error", reject);
  });
}

async function restartAndResmoke(api, uuid, c) {
  log("· --check-persistence: restarting the app to verify the convex-data volume persists…");
  await api("GET", `/applications/${uuid}/restart`).catch(async () => {
    // some Coolify versions use POST /restart
    await api("POST", `/applications/${uuid}/restart`, {});
  });
  await sleep(POLL_INTERVAL_MS);
  await waitHealthy(api, uuid);
  await runSmoke(c);
  log("✓ persistence OK — app healthy + smoke green after restart (volume survived)");
}

async function main() {
  log("Bordmap → Coolify deploy");
  loadDeployEnv();
  const c = cfg();
  const { stack, buildTime, generated } = buildStackEnv(c);

  const SECRET = /SECRET|TOKEN|ADMIN_KEY/;
  log("\n— plan —————————————————————————————————————————————");
  log(`  coolify     : ${c.COOLIFY_URL}`);
  log(`  project/env : ${c.projectUuid} / ${c.environmentUuid} [${c.environmentName}]`);
  log(`  app         : ${c.appUuid ? `reuse ${c.appUuid}` : `create "${c.appName}"`}`);
  log(`  source      : ${c.gitRepository || "(unset — run coolify-wire-source.mjs)"}@${c.gitBranch} compose=${c.composeLocation}`);
  log(`  public url  : ${c.publicBaseUrl || "(autogenerate via Coolify)"}`);
  log("  stack env   :");
  for (const [k, v] of Object.entries(stack)) {
    const shown = SECRET.test(k) ? (v ? "<set>" : "<empty>") : v === "" ? "(empty→filled after domain read)" : v;
    log(`     ${buildTime.has(k) ? "[build]" : "       "} ${k}=${shown}`);
  }
  if (generated.length) log(`  generated   : ${generated.join(", ")}  ← persisted (stable across redeploys)`);
  log("—————————————————————————————————————————————————————\n");

  if (c.dryRun) {
    log(c.token ? "--dry-run: no API calls made." : "no COOLIFY_API_TOKEN → dry-run only.");
    log("API calls that WOULD run:");
    log(`   GET    /api/v1/projects/${c.projectUuid}        (guardrail: confirm Bordmap)`);
    log(`   POST   /api/v1/applications/public              (build_pack=dockercompose) [unless COOLIFY_APP_UUID set]`);
    if (c.publicBaseUrl) log(`   PATCH  /api/v1/applications/{uuid}               (docker_compose_domains → ${c.publicBaseUrl})`);
    log(`   PATCH  /api/v1/applications/{uuid}/envs/bulk     (${Object.keys(stack).length} vars)`);
    log(`   GET    /api/v1/deploy?uuid={uuid}&force=true`);
    log(`   GET    /api/v1/applications/{uuid}               (poll until running:healthy)`);
    if (!NO_SMOKE) log(`   then   node scripts/smoke.mjs  (BASE_URL=${c.publicBaseUrl || "<assigned domain>"})`);
    log("\n✅ dry-run OK — supply COOLIFY_API_TOKEN + COOLIFY_GIT_REPOSITORY to deploy.");
    return;
  }

  const api = makeApi(c);
  await assertBoardmapProject(api, c); // GUARDRAIL FIRST — before any write.
  c.serverUuid = await resolveServerUuid(api, c);
  const uuid = await resolveApp(api, c);

  // Read the Coolify-assigned domain so the VITE_* build arg is real.
  if (!c.publicBaseUrl) {
    try {
      const app = await api("GET", `/applications/${uuid}`);
      const fqdn = String(app.fqdn ?? app.data?.fqdn ?? "").split(",")[0].trim();
      if (fqdn) {
        c.publicBaseUrl = fqdn.replace(/\/$/, "");
        c.host = new URL(c.publicBaseUrl).host;
        log(`· using Coolify-assigned domain: ${c.publicBaseUrl}`);
        setDeployEnv("PUBLIC_BASE_URL", c.publicBaseUrl);
      } else {
        log("  (Coolify returned no fqdn yet — VITE_* build args would be EMPTY; set PUBLIC_BASE_URL in deploy.env and re-run)");
      }
    } catch (err) {
      log(`  (could not read assigned domain: ${err.message})`);
    }
  }

  // Point the Coolify edge at PUBLIC_BASE_URL before baking/deploying so the
  // FQDN + (for https) the Let's Encrypt cert come up with this build.
  await ensureDomain(api, uuid, c);

  const built = buildStackEnv(c);
  persistGenerated(built);
  await pushEnvs(api, uuid, built.stack, built.buildTime);
  const deploymentUuid = await triggerDeploy(api, uuid);
  log("· waiting for the build to finish…");
  await waitForDeployment(api, deploymentUuid);
  log("· build finished; waiting for the stack to become healthy…");
  await waitHealthy(api, uuid);
  log("· deployment healthy.");

  if (NO_SMOKE) {
    log("--no-smoke: skipping the runtime smoke. Deploy complete.");
    return;
  }
  log("· running the token-free smoke against the deployment…");
  await runSmoke(c);
  if (CHECK_PERSISTENCE) await restartAndResmoke(api, uuid, c);
  log(`\n✅ DEPLOY + SMOKE complete → ${c.publicBaseUrl}`);
}

main().catch((err) => die(err.message));
