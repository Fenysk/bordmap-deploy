#!/usr/bin/env node
/**
 * scripts/coolify-fix-graphhopper-oom.mjs — hot-patch the GraphHopper resource to
 * stop the OOM crash loop without rebuilding the image (FEN-519).
 *
 * Root cause: JVM heap (-Xmx2g) + JVM overhead (~0.5g) left only ~1.5g for the
 * France graph MMAP kernel page cache in a 4g container. The kernel OOM-killed
 * the JVM after 15-45 min of serving.
 *
 * Fix:
 *   1. Push GH_JAVA_OPTS=-Xmx1g -Xms256m into the GraphHopper Coolify resource env
 *      (env var substitution in docker-compose.graphhopper.yml picks it up).
 *   2. Trigger a redeploy — graph cache persists on the volume, so restarts are
 *      fast (no re-import). The new container starts with 1g heap, giving ~2.5-3g
 *      for MMAP page cache under the 5g mem_limit.
 *   3. Wait for running:healthy.
 *
 * ZERO npm deps.
 * Usage: COOLIFY_API_TOKEN=<token> node scripts/coolify-fix-graphhopper-oom.mjs [--dry-run]
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DEPLOY_ENV_PATH = join(REPO_ROOT, "infra", "coolify", "deploy.env");

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const DEFAULT_COOLIFY_URL = "https://coolify.fenysk.fr";

// The GraphHopper Coolify resource UUID (persisted by coolify-provision-graphhopper.mjs).
const GH_APP_UUID_KEY = "COOLIFY_GH_APP_UUID";

// Hard guardrail: only the Bordmap project.
const BORDMAP_PROJECT_UUID = "mbw8fq4xd475qc35hln9ryq0";
const FORBIDDEN_PROJECT_UUIDS = new Set(["tgxjp2pout8sab9fp5edtbhb"]);

const POLL_MS = 10_000;
const TIMEOUT_MS = 600_000; // 10 min — no import, just restart

const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  console.error(`❌ coolify-fix-graphhopper-oom: ${msg}`);
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
  log("· loaded deploy.env");
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
      throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
    return json;
  };
}

async function assertBordmapProject(api, uuid) {
  for (const bad of FORBIDDEN_PROJECT_UUIDS) {
    if (uuid === bad || uuid.startsWith(bad))
      die(`GUARDRAIL: app ${uuid} is on the denylist.`);
  }
  const app = await api("GET", `/applications/${uuid}`);
  const proj =
    app.project_uuid ?? app.environment?.project_uuid ?? app.data?.project_uuid;
  if (proj && proj !== BORDMAP_PROJECT_UUID && process.env.COOLIFY_ALLOW_PROJECT_OVERRIDE !== "1")
    die(`GUARDRAIL: app ${uuid} belongs to project ${proj}, not Bordmap (${BORDMAP_PROJECT_UUID}). Refusing.`);
  log(`· guardrail OK: app ${uuid} = "${app.name ?? "?"}"`);
  return app;
}

async function waitHealthy(api, uuid) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < TIMEOUT_MS) {
    const app = await api("GET", `/applications/${uuid}`).catch((err) => {
      log(`  (poll error, retrying: ${err.message})`);
      return null;
    });
    if (!app) {
      await sleep(POLL_MS);
      continue;
    }
    const status = app.status ?? app.data?.status ?? "unknown";
    if (status !== last) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      log(`  status [+${elapsed}s]: ${status}`);
      last = status;
    }
    if (/running:healthy/.test(status)) return;
    if (/running\b/.test(status) && !/unhealthy|starting/.test(status)) return;
    await sleep(POLL_MS);
  }
  throw new Error(`timed out after ${Math.round(TIMEOUT_MS / 60_000)} min (last status: ${last})`);
}

async function main() {
  log("Bordmap GraphHopper OOM fix (FEN-519)");
  loadDeployEnv();

  const token = resolveToken();
  const ghUuid = process.env[GH_APP_UUID_KEY];

  if (!ghUuid) die(`${GH_APP_UUID_KEY} not set — cannot identify the GraphHopper resource. Run coolify-provision-graphhopper.mjs or set it manually.`);

  log(`\n— plan ——————————————————————————————————————————————`);
  log(`  GH resource : ${ghUuid}`);
  log(`  fix         : GH_JAVA_OPTS=-Xmx1g -Xms256m  (was -Xmx2g -Xms2g)`);
  log(`  rationale   : heap 2g + JVM overhead left <1.5g for MMAP in 4g container → OOM`);
  log(`  no rebuild  : graph cache on volume, restart only (fast)`);
  log(`—————————————————————————————————————————————————————\n`);

  if (DRY_RUN || !token) {
    log(token ? "--dry-run: no API calls." : "No COOLIFY_API_TOKEN — dry-run only.");
    log("API calls that WOULD run:");
    log(`   GET    /api/v1/applications/${ghUuid}                (guardrail)`);
    log(`   PATCH  /api/v1/applications/${ghUuid}/envs/bulk       (set GH_JAVA_OPTS)`);
    log(`   GET    /api/v1/deploy?uuid=${ghUuid}&force=true        (trigger redeploy)`);
    log(`   GET    /api/v1/applications/${ghUuid}                  (poll until healthy)`);
    log("\n✅ dry-run OK — set COOLIFY_API_TOKEN to apply.");
    return;
  }

  const api = makeApi(token);
  await assertBordmapProject(api, ghUuid);

  // Push the new heap setting as a Coolify env var. The docker-compose substitution
  // ${GH_JAVA_OPTS:--Xmx1g -Xms256m} will pick it up on the next container start.
  log("· pushing GH_JAVA_OPTS=-Xmx1g -Xms256m …");
  await api("PATCH", `/applications/${ghUuid}/envs/bulk`, {
    data: [
      {
        key: "GH_JAVA_OPTS",
        value: "-Xmx1g -Xms256m",
        is_build_time: false,
        is_preview: false,
      },
    ],
  });
  log("  ✓ env var updated");

  // Trigger a redeploy. The image is unchanged (no Dockerfile edit), but the
  // compose will be re-evaluated with the new env var. Graph cache on the volume
  // survives the redeploy — no re-import, just a fast restart.
  log("· triggering redeploy (no re-import — graph cache persists on volume) …");
  const res = await api("GET", `/deploy?uuid=${encodeURIComponent(ghUuid)}&force=true`);
  const dep = res.deployments?.[0]?.deployment_uuid ?? res.deployment_uuid ?? null;
  log(`  deploy queued${dep ? ` (deployment ${dep})` : ""}`);

  log("· waiting for running:healthy …");
  await waitHealthy(api, ghUuid);

  log(`\n✅ GraphHopper restarted with 1g heap — OOM fix applied.`);
  log(`   Heap: -Xmx1g -Xms256m  (was -Xmx2g -Xms2g)`);
  log(`   MMAP headroom: ~2.5-3g available under 5g mem_limit`);
  log(`   Smoke: curl "http://bordmap-graphhopper:8989/route?point=45.188,5.724&point=45.196,5.735&profile=bordmap_road&elevation=true&points_encoded=false&instructions=false"`);
}

main().catch((err) => die(err.message ?? String(err)));
