#!/usr/bin/env node
/**
 * scripts/smoke.mjs — token-free runtime smoke against a DEPLOYED Bordmap URL
 * (FEN-437). No secrets, no admin key — just public HTTP, so it runs from
 * anywhere with egress to the public URL (CI, the deploy script, or by hand).
 *
 *   BASE_URL=https://bordmap.example node scripts/smoke.mjs
 *
 * Checks (the dispatch's token-free smoke):
 *   1. GET ${BASE_URL}/                  → 200 AND the body mentions "bordmap"
 *   2. GET ${BASE_URL}/convex/version    → 200 (Convex backend reachable via the
 *                                          proxy; /convex/* strips to /version)
 *
 * Map-only MVP reset (FEN-902): auth is out of scope, so the former auth
 * write-path steps are removed — this smoke is now app + Convex only.
 *
 * Volume persistence (the 3rd smoke point) is validated separately — by the
 * named `convex-data` volume + scripts/coolify-deploy.mjs --check-persistence
 * (Coolify restart + re-smoke), and locally by docker/smoke.sh. It is NOT a
 * token-free HTTP check, so it is not done here.
 *
 * ZERO npm deps: Node >= 22 global fetch.
 */
const BASE = (process.env.BASE_URL || process.env.WEB_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.error("❌ smoke: set BASE_URL (the public Bordmap URL) — e.g. BASE_URL=https://bordmap.example");
  process.exit(2);
}

const log = (m) => console.log(m);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 20_000);

async function get(url) {
  return req("GET", url);
}

/** One HTTP call with a timeout. JSON body for POSTs; returns status + raw text.
 *  Sends an Origin header matching BASE (a real browser always does). */
async function req(method, url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { Origin: BASE };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: ctrl.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } finally {
    clearTimeout(t);
  }
}

/** Poll an URL until it returns 200 (or we run out of tries). Bridges the gap
 *  between "deployment healthy" and the proxy/app actually serving. */
async function waitOk(url, label, tries = 30, gapMs = 4000) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await get(url);
      if (r.status === 200) return r;
      log(`  …${label} → HTTP ${r.status} (try ${i}/${tries})`);
    } catch (err) {
      log(`  …${label} unreachable (${err.name}) (try ${i}/${tries})`);
    }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  throw new Error(`${label} never returned 200 after ${tries} tries`);
}

async function main() {
  log(`Bordmap smoke → ${BASE}`);

  // 1. App root: 200 + Bordmap page.
  const root = await waitOk(`${BASE}/`, "app /");
  if (!/bordmap/i.test(root.body)) {
    throw new Error(`app / returned 200 but the page does not mention "Bordmap" (got ${root.body.length} bytes)`);
  }
  log("✓ 1/2 app / → 200 and renders the Bordmap page");

  // 2. Convex backend reachable via the proxy.
  const ver = await waitOk(`${BASE}/convex/version`, "convex /version");
  log(`✓ 2/2 convex /version → 200 (${ver.body.trim().slice(0, 40)})`);

  log("\n✅ SMOKE PASSED");
}

main().catch((err) => {
  console.error(`❌ smoke FAILED: ${err.message}`);
  process.exit(1);
});
