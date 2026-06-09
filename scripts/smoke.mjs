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
 *   3. GET  /api/auth/.well-known/jwks.json  → 200 with a keys[] EdDSA entry
 *                                          (was 500 "no such table: jwks")
 *   4. POST /api/auth/sign-up/email      → 200 {token,user} (was 500 request.clone)
 *   5. POST /api/auth/sign-in/email      → 200 (same creds round-trip)
 *   6. GET  /api/auth/get-session        → 200 (regression guard, FEN-473)
 * Steps 3-6 prove the FEN-476 auth write-path fix on the live deploy (FEN-477).
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
 *  Sends an Origin header matching BASE: Better Auth rejects state-changing POSTs
 *  with no/foreign Origin (403 MISSING_OR_NULL_ORIGIN) as CSRF protection — a real
 *  browser always sends it, so the smoke must too. BASE must be in trustedOrigins. */
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
  log("✓ 1/6 app / → 200 and renders the Bordmap page");

  // 2. Convex backend reachable via the proxy.
  const ver = await waitOk(`${BASE}/convex/version`, "convex /version");
  log(`✓ 2/6 convex /version → 200 (${ver.body.trim().slice(0, 40)})`);

  // ── Auth write path (FEN-476 fix, FEN-477 acceptance) ──────────────────────
  // 3. JWKS: 200 with a keys[] EdDSA entry (was 500 "no such table: jwks").
  const jwks = await req("GET", `${BASE}/api/auth/.well-known/jwks.json`);
  if (jwks.status !== 200) throw new Error(`jwks.json → ${jwks.status} (expected 200): ${jwks.body.slice(0, 200)}`);
  let keys;
  try {
    keys = JSON.parse(jwks.body).keys;
  } catch {
    throw new Error(`jwks.json → 200 but body is not JSON: ${jwks.body.slice(0, 200)}`);
  }
  if (!Array.isArray(keys) || keys.length === 0) throw new Error(`jwks.json → 200 but keys[] is empty: ${jwks.body.slice(0, 200)}`);
  const eddsa = keys.find((k) => k.kty === "OKP" || k.alg === "EdDSA" || k.crv === "Ed25519");
  if (!eddsa) throw new Error(`jwks.json → 200 but no EdDSA/OKP key in keys[]: ${jwks.body.slice(0, 200)}`);
  log(`✓ 3/6 jwks.json → 200 (${keys.length} key(s), EdDSA present)`);

  // 4. Sign-up: 200 with {token,user} (was 500 "request.clone is not a function").
  const email = `smoke+${Date.now()}@bordmap.test`;
  const password = "smoke-pw-12345";
  const signup = await req("POST", `${BASE}/api/auth/sign-up/email`, { email, password, name: "Smoke Test" });
  if (signup.status !== 200) throw new Error(`sign-up/email → ${signup.status} (expected 200): ${signup.body.slice(0, 300)}`);
  let signupJson;
  try {
    signupJson = JSON.parse(signup.body);
  } catch {
    throw new Error(`sign-up/email → 200 but body is not JSON: ${signup.body.slice(0, 200)}`);
  }
  if (!signupJson.user) throw new Error(`sign-up/email → 200 but no user in response: ${signup.body.slice(0, 200)}`);
  log(`✓ 4/6 sign-up/email → 200 (user ${signupJson.user.id ?? signupJson.user.email})`);

  // 5. Sign-in: same creds round-trip → 200.
  const signin = await req("POST", `${BASE}/api/auth/sign-in/email`, { email, password });
  if (signin.status !== 200) throw new Error(`sign-in/email → ${signin.status} (expected 200): ${signin.body.slice(0, 300)}`);
  log("✓ 5/6 sign-in/email → 200");

  // 6. get-session regression guard (FEN-473).
  const sess = await req("GET", `${BASE}/api/auth/get-session`);
  if (sess.status !== 200) throw new Error(`get-session → ${sess.status} (expected 200): ${sess.body.slice(0, 200)}`);
  log("✓ 6/6 get-session → 200");

  log("\n✅ SMOKE PASSED");
}

main().catch((err) => {
  console.error(`❌ smoke FAILED: ${err.message}`);
  process.exit(1);
});
