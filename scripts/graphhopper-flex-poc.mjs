#!/usr/bin/env node
// GraphHopper flexible-routing POC (FEN-807 / FEN-800 R-1, AC-G1).
//
// Proves — against the LIVE GraphHopper instance — that a flexible request
// (`ch.disable=true` + a request-time `custom_model` area-avoidance) returns a
// DISTINCT trace WITHOUT any LM and WITHOUT raising RAM. It is the executable
// half of the R-1 feasibility proof; the RAM-baseline half (mem_limit / RSS
// before-after) is captured with the shell snippet in
// docs/poc/fen807-graphhopper-flex.md, run on the VPS host around this script.
//
// HOW TO REACH THE ENGINE (it has NO public domain — internal-only on the
// coolify network, see docker-compose.graphhopper.yml):
//   On the VPS host:        GH_URL=http://<bordmap-graphhopper-container-ip>:8989 node scripts/graphhopper-flex-poc.mjs
//   Or via an SSH tunnel:   ssh -L 8989:<container-ip>:8989 vps  &&  GH_URL=http://127.0.0.1:8989 node scripts/graphhopper-flex-poc.mjs
//   Or inside the container: docker exec bordmap-graphhopper sh -c '...'  (node may be absent → prefer tunnel/host)
//
// Node 18+ (built-in fetch). No deps.
//
// Exit 0 = POC PASS (distinct trace produced flexibly). Exit 1 = FAIL/no-distinct.

const GH_URL = (process.env.GH_URL || 'http://127.0.0.1:8989').replace(/\/$/, '');
const PROFILE = process.env.GH_PROFILE || 'bordmap_road';
// Default test segment: Grenoble area (Rhône-Alpes extract — the live region,
// FEN-599), long enough that the road network offers a parallel corridor.
const START = (process.env.GH_START || '45.166,5.715').split(',').map(Number); // [lat,lng]
const END = (process.env.GH_END || '45.191,5.730').split(',').map(Number);

const baseQS = (extra = '') =>
  `point=${START[0]},${START[1]}&point=${END[0]},${END[1]}` +
  `&profile=${PROFILE}&points_encoded=false&elevation=false&instructions=false&details=distance${extra}`;

function haversine(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// path = GeoJSON coordinates [[lng,lat],...]  → return [lat,lng] points.
const toLatLng = (coords) => coords.map(([lng, lat]) => [lat, lng]);

// Fraction of B's points that lie within `tol` metres of ANY A point (overlap 0..1).
function overlap(a, b, tol = 40) {
  if (!b.length) return 1;
  let near = 0;
  for (const p of b) {
    let min = Infinity;
    for (const q of a) { const d = haversine(p, q); if (d < min) min = d; if (d < tol) break; }
    if (min < tol) near++;
  }
  return near / b.length;
}

function pointInPoly(pt, ring) {
  // ring: [[lng,lat],...]; pt: [lat,lng]
  const x = pt[1], y = pt[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function ghGet(extra) {
  const url = `${GH_URL}/route?${baseQS(extra)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(`GET ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}
async function ghPost(body) {
  const r = await fetch(`${GH_URL}/route`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`POST ${r.status}: ${JSON.stringify(j).slice(0, 600)}`);
  return j;
}

(async () => {
  console.log(`# GraphHopper flexible POC → ${GH_URL}  profile=${PROFILE}`);
  console.log(`# segment  start=${START.join(',')}  end=${END.join(',')}\n`);

  // ── 1. PRIMARY route (no custom model). profiles_ch:[] → already flexible. ──
  const primary = await ghGet('');
  const pPath = toLatLng(primary.paths[0].points.coordinates);
  const pDist = primary.paths[0].distance;
  console.log(`PRIMARY:   distance=${pDist.toFixed(0)} m   points=${pPath.length}`);

  // ── 2. Build an avoidance polygon (~250 m box) around the primary midpoint ──
  const mid = pPath[Math.floor(pPath.length / 2)]; // [lat,lng]
  const dLat = 0.0025, dLng = 0.0035; // ~250–300 m box
  const ring = [
    [mid[1] - dLng, mid[0] - dLat],
    [mid[1] + dLng, mid[0] - dLat],
    [mid[1] + dLng, mid[0] + dLat],
    [mid[1] - dLng, mid[0] + dLat],
    [mid[1] - dLng, mid[0] - dLat],
  ];
  const avoidArea = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 'avoid_0', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }],
  };

  // ── 3. FLEXIBLE request: ch.disable=true + request-time custom_model area-avoidance ──
  const flexBody = {
    profile: PROFILE,
    points: [[START[1], START[0]], [END[1], END[0]]], // GH wants [lng,lat]
    'ch.disable': true,
    custom_model: { priority: [{ if: 'in_avoid_0', multiply_by: 0.05 }], areas: avoidArea },
    points_encoded: false, elevation: false, instructions: false, details: ['distance'],
  };
  console.log('\n# ── FLEXIBLE REQUEST BODY ──');
  console.log(JSON.stringify(flexBody));

  const flex = await ghPost(flexBody);
  const fPath = toLatLng(flex.paths[0].points.coordinates);
  const fDist = flex.paths[0].distance;
  console.log(`\nFLEXIBLE:  distance=${fDist.toFixed(0)} m   points=${fPath.length}`);

  // ── 4. Distinctness metrics ──
  const ov = overlap(pPath, fPath);          // 0..1 fraction of flex path near primary
  const inAvoidPrimary = pPath.filter((p) => pointInPoly(p, ring)).length;
  const inAvoidFlex = fPath.filter((p) => pointInPoly(p, ring)).length;
  console.log('\n# ── DISTINCTNESS ──');
  console.log(`overlap(flex vs primary) = ${(ov * 100).toFixed(1)}%`);
  console.log(`primary points inside avoid-zone = ${inAvoidPrimary}`);
  console.log(`flexible points inside avoid-zone = ${inAvoidFlex}`);
  console.log(`distance delta = ${(fDist - pDist).toFixed(0)} m`);

  // PASS: flexible route returned AND it is materially different from primary
  // (corridor visiblement différent, D-PO-2) — measured as either reduced
  // avoid-zone presence or a non-trivial overlap drop / distance change.
  const distinct =
    fPath.length > 0 &&
    (ov < 0.85 || inAvoidFlex < inAvoidPrimary || Math.abs(fDist - pDist) > Math.max(50, pDist * 0.02));

  console.log(`\nPOC ${distinct ? 'PASS ✅ — distinct flexible trace produced WITHOUT LM' : 'FAIL ❌ — no distinct trace (→ AC-G2 gate)'}`);
  process.exit(distinct ? 0 : 1);
})().catch((e) => { console.error('POC ERROR:', e.message); process.exit(2); });
