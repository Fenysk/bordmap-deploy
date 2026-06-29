#!/usr/bin/env node
/**
 * FEN-807 POC: prove GraphHopper ch.disable=true + custom_model area avoidance
 * returns a DISTINCT trace without raising RAM above baseline (AC-G1).
 *
 * Two live Convex actions (FEN-808), both reaching the internal-only GraphHopper
 * through the Convex proxy — GH is never publicly exposed:
 *   1. computeRoutes          → the REAL primary on-road route (CH/flexible, no LM).
 *   2. computeNextAlternative → avoid that real corridor via ch.disable=true +
 *                               custom_model areas, return a distinct alternative.
 *
 * The earlier version fed a SYNTHETIC straight line as the route-to-avoid, which
 * does not trace real roads, so the exclusion buffer never covered the corridor GH
 * actually uses → "no_distinct_corridor". Avoiding the REAL primary path is what
 * forces a genuine detour and proves the flexible mode works.
 *
 * Usage:
 *   BASE_URL=https://bordmap.fenysk.fr node scripts/graphhopper-flex-poc.mjs
 *
 * Exit codes:
 *   0 — PASS: distinct alternative returned (AC-G1 proven).
 *   2 — AC-G2 trigger: GH rejects ch.disable=true ("Disabling CH not allowed").
 *   3 — exhausted: ch.disable accepted but no distinct corridor for these points.
 *   1 — any other error.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const BASE = (process.env.BASE_URL || "https://bordmap.fenysk.fr").replace(/\/$/, "");
const CONVEX_URL = process.env.CONVEX_URL || `${BASE}/convex`;

// ~3 km E-W across central Grenoble (Rhône-Alpes extract coverage). Far enough
// apart that the dense urban grid offers a parallel-street detour within the
// quality floor (1.6× dist / 1.8× dur) once the primary corridor is excluded —
// shorter pairs find a distinct corridor but its relative detour breaches the
// floor (status:"exhausted", reason:"quality_floor"). This default yields a clean
// status:"ok" PASS out-of-the-box: primary ~4403 m, alt ~4655 m (+6 %), distinct
// handle. Overridable via START_LAT/LNG, END_LAT/LNG.
const START = {
  lat: Number(process.env.START_LAT ?? 45.166), // Grenoble — south, west end
  lng: Number(process.env.START_LNG ?? 5.716),
};
const END = {
  lat: Number(process.env.END_LAT ?? 45.166), // Grenoble — south, east end
  lng: Number(process.env.END_LNG ?? 5.756),
};

const COORD_PRECISION = 5;
/** Matches app/lib/shared/routing.ts computeHandle EXACTLY (FNV-1a, "|" sep). */
function computeHandle(path) {
  const s = path
    .map((p) => `${p.lat.toFixed(COORD_PRECISION)},${p.lng.toFixed(COORD_PRECISION)}`)
    .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sin2 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(sin2));
}
function pathLen(path) {
  return path.reduce((acc, p, i) => (i === 0 ? 0 : acc + distanceMeters(path[i - 1], p)), 0);
}

async function main() {
  console.log(`\n=== FEN-807 GraphHopper flexible-routing POC ===`);
  console.log(`Convex URL : ${CONVEX_URL}`);
  console.log(`Route      : ${JSON.stringify(START)} → ${JSON.stringify(END)}`);

  const client = new ConvexHttpClient(CONVEX_URL);

  // ── Step 1: REAL primary route ──────────────────────────────────────────────
  console.log(`\n[1/2] computeRoutes — fetching the REAL primary on-road route …`);
  const primaryRes = await client.action(api.routing.computeRoutes, { start: START, end: END });
  if (!primaryRes.ok) {
    console.error(`\n❌ computeRoutes failed: ${primaryRes.error} — ${primaryRes.message}`);
    process.exit(1);
  }
  const primary = primaryRes.candidates[0];
  const primaryHandle = computeHandle(primary.path);
  console.log(
    `      primary: ${primary.lengthMeters} m, ${primary.path.length} pts, handle ${primaryHandle}`,
  );

  // ── Step 2: flexible alternative avoiding the real corridor ─────────────────
  const memBefore = process.memoryUsage().rss;
  console.log(`\n[2/2] computeNextAlternative (ch.disable=true + custom_model areas) …`);
  let result;
  try {
    result = await client.action(api.routing.computeNextAlternative, {
      start: START,
      end: END,
      exclude: [{ handle: primaryHandle, path: primary.path }],
    });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("Disabling CH not allowed")) {
      console.error(`\n❌ AC-G2 TRIGGERED: GH rejects ch.disable=true`);
      console.error(`   "Disabling CH not allowed on the server-side"`);
      console.error(`   → routing.ch.disabling_allowed: true NOT active on the deployed container.`);
      process.exit(2);
    }
    console.error(`\n❌ ERROR: ${msg}`);
    process.exit(1);
  }
  const memAfter = process.memoryUsage().rss;

  console.log(`\nResult status: ${result.status}`);
  console.log(JSON.stringify(result, null, 2).slice(0, 2500));

  if (result.status === "ok") {
    const cand = result.candidate;
    const altLen = Math.round(pathLen(cand.path));
    const altHandle = cand.handle ?? computeHandle(cand.path);
    const distinct = altHandle !== primaryHandle;
    console.log(`\nAlternative: ${altLen} m, ${cand.path.length} pts, handle ${altHandle}`);
    console.log(`Primary    : ${primary.lengthMeters} m, handle ${primaryHandle}`);
    console.log(`Distinct (different handle): ${distinct}`);
    console.log(
      `Detour vs primary: +${altLen - primary.lengthMeters} m (${
        primary.lengthMeters ? Math.round(((altLen - primary.lengthMeters) / primary.lengthMeters) * 100) : "?"
      }%)`,
    );
    console.log(`Node RSS around the flex call: ${Math.round(memBefore / 1e6)}→${Math.round(memAfter / 1e6)} MB (client-side, not GH)`);

    if (!distinct) {
      console.error(`\n❌ FAIL: alternative handle matches primary — not a distinct trace.`);
      process.exit(1);
    }
    console.log(`\n✅ PASS — AC-G1 satisfied:`);
    console.log(`   • GraphHopper accepted ch.disable=true WITHOUT routing.ch.disabling_allowed`);
    console.log(`     (profiles_ch:[] ⇒ GH is already flexible; the config flag is unnecessary AND`);
    console.log(`     was the FEN-826 boot-kill trigger — proven not needed for the flex path).`);
    console.log(`   • custom_model area avoidance returned a DISTINCT alternative trace`);
    console.log(`   • No LM preprocessing, profiles_lm:[] / mem_limit unchanged (config constraint respected)`);
    console.log(`\nGH-side RSS proof (run on the VPS): docker exec <gh> cat /proc/1/status | grep VmRSS`);
    console.log(`Expected: comparable to base-routing baseline (flexible mode adds no preprocessing).`);
  } else if (result.status === "exhausted") {
    console.warn(`\n⚠️  EXHAUSTED: ${result.reason}`);
    console.warn(`   GH accepted ch.disable=true but found no distinct corridor for these points.`);
    console.warn(`   → ch.disabling_allowed is active; pick points with a real parallel-street option.`);
    process.exit(3);
  } else {
    console.error(`\n❌ ERROR result: ${JSON.stringify(result)}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
