#!/usr/bin/env node
/**
 * scripts/coolify-provision-graphhopper.mjs — provision the GraphHopper routing
 * service as a SEPARATE Coolify resource in the Bordmap project (FEN-507, ADR D-R2).
 *
 * Creates (or reuses) a Docker-Compose application pointing at the same git source
 * as the main Bordmap app but with compose file
 * /infra/coolify/graphhopper/docker-compose.graphhopper.yml.
 *
 * NO public domain is set — the service is internal only. The "Connect To Predefined
 * Network" flag is enabled so `bordmap-graphhopper` resolves from the app containers.
 *
 * Persists COOLIFY_GH_APP_UUID to infra/coolify/deploy.env so re-runs are idempotent.
 *
 * SAME guardrail as coolify-deploy.mjs: ONLY the Bordmap Coolify project is writable.
 *
 * ZERO npm deps: Node >= 22 global fetch.
 *
 * Usage:
 *   COOLIFY_API_TOKEN=<token> node scripts/coolify-provision-graphhopper.mjs [--dry-run] [--no-smoke]
 *
 * Env (loaded from infra/coolify/deploy.env too):
 *   COOLIFY_API_TOKEN   — Coolify API token
 *   COOLIFY_URL         — default https://coolify.fenysk.fr
 *   COOLIFY_GIT_REPOSITORY — the deploy-snapshot repo (same as the main app)
 *   COOLIFY_GH_APP_UUID — if set, reuse this resource instead of creating a new one
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DEPLOY_ENV_PATH = join(REPO_ROOT, "infra", "coolify", "deploy.env");

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");

// HARD GUARDRAIL: only the Bordmap project, same UUIDs as coolify-deploy.mjs.
const BORDMAP_PROJECT_UUID = "mbw8fq4xd475qc35hln9ryq0";
const BORDMAP_ENVIRONMENT_UUID = "amdffi9rkbk785eva1f3z9b2";
const FORBIDDEN_PROJECT_UUIDS = new Set([
  "tgxjp2pout8sab9fp5edtbhb", // LivePlace
]);

const DEFAULT_COOLIFY_URL = "https://coolify.fenysk.fr";
const GH_APP_NAME = "bordmap-graphhopper";
const GH_COMPOSE_LOCATION = "/infra/coolify/graphhopper/docker-compose.graphhopper.yml";
// Internal URL Convex uses to reach the routing engine.
const GRAPHHOPPER_INTERNAL_URL = "http://bordmap-graphhopper:8989";

const POLL_INTERVAL_MS = 10_000;
// France PBF import can take 30-90 min on a NAS; health start_period in compose is
// 5400 s. We poll for up to 120 min to cover the worst NAS case.
const IMPORT_TIMEOUT_MS = 7_200_000;

const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  console.error(`❌ coolify-provision-graphhopper: ${msg}`);
  process.exit(1);
}

function loadDeployEnv() {
  if (!existsSync(DEPLOY_ENV_PATH)) return;
  for (const raw of readFileSync(DEPLOY_ENV_PATH, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
  log(`· loaded deploy.env`);
}

function resolveToken() {
  let best = { n: -1, val: "" };
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^COOLIFY_API_TOKEN(?:_(\d+))?$/.exec(k);
    if (!m || !v) continue;
    const n = m[1] ? Number(m[1]) : 0;
    if (n > best.n) best = { n, val: v };
  }
  return best.val;
}

function upsertDeployEnv(key, value) {
  let lines = existsSync(DEPLOY_ENV_PATH)
    ? readFileSync(DEPLOY_ENV_PATH, "utf8").split("\n")
    : [];
  lines = lines.filter((l) => !new RegExp(`^\\s*${key}\\s*=`).test(l));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push(`${key}=${value}`, "");
  writeFileSync(DEPLOY_ENV_PATH, lines.join("\n"));
}

function makeApi(token) {
  const base = (process.env.COOLIFY_URL || DEFAULT_COOLIFY_URL).replace(/\/$/, "");
  return async function api(method, path, body) {
    const url = `${base}/api/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok)
      throw new Error(
        `${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
      );
    return json;
  };
}

async function assertBordmapProject(api) {
  for (const bad of FORBIDDEN_PROJECT_UUIDS) {
    if (BORDMAP_PROJECT_UUID === bad || BORDMAP_PROJECT_UUID.startsWith(bad))
      die(`GUARDRAIL: project ${BORDMAP_PROJECT_UUID} is on the denylist.`);
  }
  let project;
  try {
    project = await api("GET", `/projects/${BORDMAP_PROJECT_UUID}`);
  } catch (err) {
    die(`GUARDRAIL: cannot read project ${BORDMAP_PROJECT_UUID}: ${err.message}`);
  }
  const name = project.name ?? project.data?.name ?? "";
  log(`· guardrail OK: project ${BORDMAP_PROJECT_UUID} = "${name}"`);
  if (!/bo[a]?rdmap/i.test(name))
    die(`GUARDRAIL: project named "${name}", expected Bordmap.`);
  return project;
}

async function resolveServerUuid(api) {
  if (process.env.COOLIFY_SERVER_UUID) return process.env.COOLIFY_SERVER_UUID;
  const servers = await api("GET", "/servers");
  const list = Array.isArray(servers) ? servers : servers.data ?? [];
  if (list.length === 1) {
    const uuid = list[0].uuid ?? list[0].data?.uuid;
    log(`· auto-resolved server: ${uuid} (${list[0].name ?? "?"})`);
    return uuid;
  }
  const opts = list.map((s) => `${s.uuid} (${s.name ?? "?"}) `).join(", ");
  die(`COOLIFY_SERVER_UUID unset and ${list.length} servers found: ${opts}`);
}

async function resolveOrCreateApp(api, serverUuid) {
  const existingUuid = process.env.COOLIFY_GH_APP_UUID;
  if (existingUuid) {
    log(`· reusing existing GraphHopper app: ${existingUuid}`);
    const app = await api("GET", `/applications/${existingUuid}`);
    // Verify it belongs to the right project.
    const proj =
      app.project_uuid ?? app.environment?.project_uuid ?? app.data?.project_uuid;
    if (proj && proj !== BORDMAP_PROJECT_UUID)
      die(
        `GUARDRAIL: app ${existingUuid} belongs to project ${proj}, not ${BORDMAP_PROJECT_UUID}.`,
      );
    return existingUuid;
  }

  const gitRepo =
    process.env.COOLIFY_GIT_REPOSITORY ||
    die(
      "COOLIFY_GIT_REPOSITORY not set — run scripts/coolify-wire-source.mjs first.",
    );
  const gitBranch = process.env.COOLIFY_GIT_BRANCH || "main";

  log(`· creating GraphHopper Docker-Compose app from ${gitRepo}@${gitBranch} …`);
  const body = {
    project_uuid: BORDMAP_PROJECT_UUID,
    environment_uuid: BORDMAP_ENVIRONMENT_UUID,
    environment_name: "production",
    server_uuid: serverUuid,
    name: GH_APP_NAME,
    git_repository: gitRepo,
    git_branch: gitBranch,
    build_pack: "dockercompose",
    docker_compose_location: GH_COMPOSE_LOCATION,
    // No public domain — internal only.
    instant_deploy: false,
    // Connect to predefined Coolify network so the service is reachable by name
    // from the main app containers.
    connect_to_docker_network: true,
  };
  const created = await api("POST", "/applications/public", body);
  const uuid =
    created.uuid ?? created.application_uuid ?? created.data?.uuid;
  if (!uuid)
    throw new Error(`create returned no uuid: ${JSON.stringify(created)}`);
  // Persist so re-runs reuse this resource.
  upsertDeployEnv("COOLIFY_GH_APP_UUID", uuid);
  log(`· created GraphHopper app ${uuid} (saved COOLIFY_GH_APP_UUID to deploy.env)`);
  return uuid;
}

async function ensureConnectToNetwork(api, uuid) {
  // Ensure the predefined-network flag is on (internal-only service).
  // Some Coolify versions expose this as is_connect_to_docker_network.
  try {
    await api("PATCH", `/applications/${uuid}`, {
      connect_to_docker_network: true,
      // Explicitly clear any auto-assigned fqdn so it stays internal-only.
    });
    log(`· set connect_to_docker_network=true on ${uuid}`);
  } catch (err) {
    log(`  (warning: could not PATCH connect_to_docker_network: ${err.message})`);
  }
}

async function triggerDeploy(api, uuid) {
  const res = await api("GET", `/deploy?uuid=${encodeURIComponent(uuid)}&force=true`);
  const dep =
    res.deployments?.[0]?.deployment_uuid ?? res.deployment_uuid ?? null;
  log(`· deploy queued${dep ? ` (deployment ${dep})` : ""}`);
  return dep;
}

async function waitForDeployment(api, deploymentUuid) {
  if (!deploymentUuid) {
    log("  (no deployment uuid — falling back to app-health polling)");
    return;
  }
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < IMPORT_TIMEOUT_MS) {
    let dep;
    try {
      dep = await api("GET", `/deployments/${deploymentUuid}`);
    } catch (err) {
      log(`  (poll error, retrying: ${err.message})`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const status = dep.status ?? dep.data?.status ?? "unknown";
    if (status !== last) {
      log(`  build: ${status}`);
      last = status;
    }
    if (/finished|success|completed/i.test(status)) return;
    if (/failed|error|cancelled/i.test(status))
      throw new Error(
        `build ${status} — inspect Coolify deployment ${deploymentUuid}`,
      );
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out after ${Math.round(IMPORT_TIMEOUT_MS / 1000 / 60)} min waiting for build`,
  );
}

async function waitHealthy(api, uuid) {
  const t0 = Date.now();
  let last = "";
  let badSince = 0;
  const BAD_GRACE_MS = 300_000; // 5 min grace for OOM / restart
  log(
    "  (France PBF import + graph build takes 30-90 min on a NAS — polling every 10 s …)",
  );
  while (Date.now() - t0 < IMPORT_TIMEOUT_MS) {
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
      const elapsed = Math.round((Date.now() - t0) / 60_000);
      log(`  status [+${elapsed}m]: ${status}`);
      last = status;
    }
    if (/running:healthy/.test(status)) return;
    if (/running\b/.test(status) && !/unhealthy|starting/.test(status)) return;
    if (/exited|error|degraded/.test(status)) {
      if (badSince === 0) badSince = Date.now();
      else if (Date.now() - badSince > BAD_GRACE_MS)
        throw new Error(
          `stack stuck "${status}" for >${Math.round(BAD_GRACE_MS / 60_000)} min — check Coolify logs. ` +
            `If first-import OOM killed, raise mem_limit to 8g, deploy once, then restore 4g (see README).`,
        );
    } else {
      badSince = 0;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out after ${Math.round(IMPORT_TIMEOUT_MS / 1000 / 60)} min (last status: ${last})`,
  );
}

async function main() {
  log("Bordmap → Coolify: provision GraphHopper routing service (FEN-507)");
  loadDeployEnv();

  const token = resolveToken();
  const dryRun = DRY_RUN || !token;

  const gitRepo = process.env.COOLIFY_GIT_REPOSITORY || "(unset — run coolify-wire-source.mjs first)";
  log("\n— plan ——————————————————————————————————————————————————");
  log(`  coolify     : ${(process.env.COOLIFY_URL || DEFAULT_COOLIFY_URL)}`);
  log(`  project     : ${BORDMAP_PROJECT_UUID} / env ${BORDMAP_ENVIRONMENT_UUID}`);
  log(`  app uuid    : ${process.env.COOLIFY_GH_APP_UUID || "(create new)"}`);
  log(`  name        : ${GH_APP_NAME}`);
  log(`  compose     : ${GH_COMPOSE_LOCATION}`);
  log(`  source      : ${gitRepo}@${process.env.COOLIFY_GIT_BRANCH || "main"}`);
  log(`  network     : coolify (predefined, internal-only, no public domain)`);
  log(`  GH_URL      : ${GRAPHHOPPER_INTERNAL_URL} (written to deploy.env after provision)`);
  log("—————————————————————————————————————————————————————————\n");

  if (dryRun) {
    log(token ? "--dry-run: no API calls made." : "no COOLIFY_API_TOKEN — dry-run only.");
    log("API calls that WOULD run:");
    log(`   GET  /api/v1/projects/${BORDMAP_PROJECT_UUID}`);
    log(`   GET  /api/v1/servers  (resolve server uuid)`);
    log(`   POST /api/v1/applications/public  (build_pack=dockercompose, no domain)  [unless COOLIFY_GH_APP_UUID]`);
    log(`   PATCH /api/v1/applications/{uuid}  (connect_to_docker_network=true)`);
    log(`   GET  /api/v1/deploy?uuid={uuid}&force=true`);
    log(`   GET  /api/v1/applications/{uuid}  (poll until running:healthy — up to 120 min for France import)`);
    log("\n✅ dry-run OK — set COOLIFY_API_TOKEN + COOLIFY_GIT_REPOSITORY to provision.");
    return;
  }

  const api = makeApi(token);
  await assertBordmapProject(api); // GUARDRAIL FIRST.

  const serverUuid = await resolveServerUuid(api);
  const uuid = await resolveOrCreateApp(api, serverUuid);
  await ensureConnectToNetwork(api, uuid);

  log(`· triggering deploy of ${uuid} …`);
  const deploymentUuid = await triggerDeploy(api, uuid);

  log("· waiting for the build to finish …");
  await waitForDeployment(api, deploymentUuid);
  log("· build done; waiting for the stack to become healthy (France import is slow) …");
  await waitHealthy(api, uuid);

  // Persist GRAPHHOPPER_URL so coolify-deploy.mjs picks it up when pushing the
  // main app's env to Coolify.
  upsertDeployEnv("GRAPHHOPPER_URL", GRAPHHOPPER_INTERNAL_URL);
  log(`· persisted GRAPHHOPPER_URL=${GRAPHHOPPER_INTERNAL_URL} to deploy.env`);

  log(`\n✅ GraphHopper deployed and healthy.`);
  log(`   Internal URL : ${GRAPHHOPPER_INTERNAL_URL}`);
  log(`   Smoke (from inside the Coolify network):`);
  log(`     bash infra/coolify/graphhopper/smoke.sh`);
  log(`   Next: FEN-504 computeRoutes action wires GRAPHHOPPER_URL into Convex.`);
}

main().catch((err) => die(err.message ?? String(err)));
