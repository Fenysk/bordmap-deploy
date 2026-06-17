#!/usr/bin/env node
/**
 * scripts/validate-auth-parcours.mjs — FEN-451 end-to-end auth parcours
 * (compte → référencer → visualiser).
 *
 * Steps:
 *   1. Sign up a test user via Better Auth
 *   2. Sign in and capture session cookies
 *   3. GET /api/auth/token (with session cookies) → JWT for Convex
 *   4. POST /convex/api/mutation routes:create with JWT → authenticated route creation
 *   5. GET /convex/api/query routes:listInBounds → verify created route + seeded routes visible
 *
 *   BASE_URL=https://bordmap.fenysk.fr node scripts/validate-auth-parcours.mjs
 *
 * ZERO npm deps: Node >= 22 global fetch.
 */

const BASE = (process.env.BASE_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.error("❌ set BASE_URL — e.g. BASE_URL=https://bordmap.fenysk.fr");
  process.exit(2);
}

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 20_000);
const log = (m) => console.log(m);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/** Make an HTTP request and return { status, body, headers, cookies }. */
async function req(method, url, { body, headers: extraHeaders = {}, cookieJar = [] } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = {
      Origin: BASE,
      ...extraHeaders,
    };
    if (body) headers["Content-Type"] = "application/json";
    if (cookieJar.length) headers["Cookie"] = cookieJar.join("; ");

    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: ctrl.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();

    // Collect Set-Cookie headers (Node fetch returns them as comma-joined in some versions)
    const setCookie = res.headers.getSetCookie?.() ?? [];

    return { status: res.status, body: text, headers: res.headers, setCookies: setCookie };
  } finally {
    clearTimeout(t);
  }
}

/** Extract cookie key=value pairs from Set-Cookie headers. */
function extractCookies(setCookies) {
  return setCookies.map((h) => h.split(";")[0].trim()).filter(Boolean);
}

/** Parse JSON body or throw with context. */
function parseJson(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label}: expected JSON but got: ${body.slice(0, 300)}`);
  }
}

// ── Main validation ───────────────────────────────────────────────────────────

async function main() {
  log(`\n🔍 FEN-451 — Bordmap auth parcours validation`);
  log(`   Target: ${BASE}\n`);

  const ts = Date.now();
  const email = `fen451+${ts}@bordmap.test`;
  const password = `parcours-pw-${ts}`;
  let cookieJar = [];

  // ── Step 1: Sign up ────────────────────────────────────────────────────────
  log("── Step 1: Sign up (compte)");
  const signupRes = await req("POST", `${BASE}/api/auth/sign-up/email`, {
    body: { email, password, name: "FEN-451 Test User" },
  });
  if (signupRes.status !== 200) {
    throw new Error(`sign-up → ${signupRes.status}: ${signupRes.body.slice(0, 300)}`);
  }
  const signupJson = parseJson(signupRes.body, "sign-up");
  if (!signupJson.user) throw new Error(`sign-up → 200 but no user: ${signupRes.body.slice(0, 200)}`);
  // Capture any session cookies from sign-up
  cookieJar = extractCookies(signupRes.setCookies);
  log(`   ✅ sign-up → user ${signupJson.user.email} (id: ${signupJson.user.id})`);
  if (signupJson.token) {
    log(`   ℹ sign-up returned inline token (Better Auth email flow)`);
  }

  // ── Step 2: Sign in (get full session cookies) ─────────────────────────────
  log("── Step 2: Sign in");
  const signinRes = await req("POST", `${BASE}/api/auth/sign-in/email`, {
    body: { email, password },
    cookieJar,
  });
  if (signinRes.status !== 200) {
    throw new Error(`sign-in → ${signinRes.status}: ${signinRes.body.slice(0, 300)}`);
  }
  const signinJson = parseJson(signinRes.body, "sign-in");
  // Merge new cookies from sign-in
  const newCookies = extractCookies(signinRes.setCookies);
  if (newCookies.length) {
    // Merge: prefer new cookies over old ones
    const cookieMap = new Map();
    [...cookieJar, ...newCookies].forEach((c) => {
      const key = c.split("=")[0];
      cookieMap.set(key, c);
    });
    cookieJar = [...cookieMap.values()];
  }
  log(`   ✅ sign-in → 200, session cookies: [${cookieJar.map((c) => c.split("=")[0]).join(", ")}]`);

  // ── Step 3: Fetch JWT for Convex ───────────────────────────────────────────
  log("── Step 3: Get JWT from /api/auth/token");
  const tokenRes = await req("GET", `${BASE}/api/auth/token`, { cookieJar });
  if (tokenRes.status !== 200) {
    throw new Error(`/api/auth/token → ${tokenRes.status}: ${tokenRes.body.slice(0, 300)}`);
  }
  const tokenJson = parseJson(tokenRes.body, "/api/auth/token");
  const jwt = tokenJson.token;
  if (!jwt) throw new Error(`/api/auth/token → 200 but no token field: ${tokenRes.body.slice(0, 200)}`);
  // Decode payload (no verify — we trust the server)
  const [, payloadB64] = jwt.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  log(`   ✅ JWT obtained — iss: ${payload.iss}, sub: ${payload.sub?.slice(0, 20)}…, exp: ${new Date(payload.exp * 1000).toISOString()}`);

  // ── Step 4: Create route via authenticated Convex mutation ─────────────────
  log("── Step 4: routes:create (authenticated Convex mutation)");
  const testRoute = {
    name: `FEN-451 Validation Route ${ts}`,
    difficulty: "intermediaire",
    start: { lat: 45.8333, lng: 6.8667 }, // Chamonix area
    end: { lat: 45.8300, lng: 6.8650 },
    description: "Automated validation route for FEN-451 parcours check",
    terrainType: "montagne",
  };

  const mutationRes = await req("POST", `${BASE}/convex/api/mutation`, {
    body: { path: "routes:create", args: testRoute },
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (mutationRes.status !== 200) {
    throw new Error(`routes:create → ${mutationRes.status}: ${mutationRes.body.slice(0, 400)}`);
  }
  const mutationJson = parseJson(mutationRes.body, "routes:create");
  // Convex HTTP API returns { status: "success", value: <id> } or { status: "error", ... }
  if (mutationJson.status === "error") {
    throw new Error(`routes:create → Convex error: ${JSON.stringify(mutationJson).slice(0, 300)}`);
  }
  const newRouteId = mutationJson.value ?? mutationJson;
  log(`   ✅ routes:create → new route ID: ${JSON.stringify(newRouteId)}`);

  // ── Step 5: List routes in bounds — see seed routes + new route ────────────
  log("── Step 5: routes:listInBounds (public query — visualiser)");
  // Wide bounding box covering France + Alps
  const queryArgs = {
    minLat: 40.0,
    minLng: -5.0,
    maxLat: 51.0,
    maxLng: 10.0,
  };
  const queryRes = await req("POST", `${BASE}/convex/api/query`, {
    body: { path: "routes:listInBounds", args: queryArgs },
  });
  if (queryRes.status !== 200) {
    throw new Error(`routes:listInBounds → ${queryRes.status}: ${queryRes.body.slice(0, 400)}`);
  }
  const queryJson = parseJson(queryRes.body, "routes:listInBounds");
  if (queryJson.status === "error") {
    throw new Error(`routes:listInBounds → Convex error: ${JSON.stringify(queryJson).slice(0, 300)}`);
  }
  const routes = queryJson.value ?? queryJson;
  if (!Array.isArray(routes)) {
    throw new Error(`routes:listInBounds → expected array, got: ${JSON.stringify(routes).slice(0, 200)}`);
  }
  log(`   ✅ routes:listInBounds → ${routes.length} route(s) in bounds`);

  // Verify seeded routes exist (expect ≥27)
  if (routes.length < 27) {
    throw new Error(`routes:listInBounds → expected ≥27 seeded routes, got ${routes.length}`);
  }
  log(`   ✅ ≥27 seeded routes visible (${routes.length} total)`);

  // Verify our newly created route is in the list
  const found = routes.find(
    (r) => r.name === testRoute.name || (newRouteId && r._id === newRouteId),
  );
  if (!found) {
    // The newly created route might not be in the France bounding box if its start is elsewhere.
    // Try a targeted narrow box around Chamonix.
    const narrowArgs = { minLat: 45.82, minLng: 6.86, maxLat: 45.85, maxLng: 6.88 };
    const narrowRes = await req("POST", `${BASE}/convex/api/query`, {
      body: { path: "routes:listInBounds", args: narrowArgs },
    });
    const narrowJson = parseJson(narrowRes.body, "routes:listInBounds (narrow)");
    const narrowRoutes = narrowJson.value ?? narrowJson;
    const foundNarrow = Array.isArray(narrowRoutes) && narrowRoutes.find(
      (r) => r.name === testRoute.name || (newRouteId && r._id === newRouteId),
    );
    if (!foundNarrow) {
      throw new Error(
        `routes:listInBounds → created route "${testRoute.name}" not found in bounds.\n` +
          `  Wide query (${routes.length} routes): IDs sample: ${routes.slice(0, 3).map((r) => r._id).join(", ")}\n` +
          `  Narrow query (${Array.isArray(narrowRoutes) ? narrowRoutes.length : "?"} routes)`
      );
    }
    log(`   ✅ Newly created route found in narrow Chamonix bounding box`);
  } else {
    log(`   ✅ Newly created route found in wide bounding box`);
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  log(`
╔══════════════════════════════════════════════════════════════════╗
║  ✅ FEN-451 PARCOURS VALIDATION — PASSED                        ║
╠══════════════════════════════════════════════════════════════════╣
║  1. Compte     sign-up + sign-in → OK                           ║
║  2. JWT        /api/auth/token → JWT issued (EdDSA)             ║
║  3. Référencer routes:create (auth-gated) → route created       ║
║  4. Visualiser routes:listInBounds → ≥27 seeded + new route     ║
╚══════════════════════════════════════════════════════════════════╝`);
}

main().catch((err) => {
  console.error(`\n❌ FEN-451 validation FAILED: ${err.message}`);
  process.exit(1);
});
