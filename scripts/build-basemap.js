#!/usr/bin/env node
/**
 * Build docs/basemap.json — the roads-and-waterways backdrop for the map view.
 *
 *   node scripts/build-basemap.js
 *
 * Pulls the EDGE_KM box around Frome from the OpenStreetMap Overpass API,
 * projects it to Web Mercator, simplifies the lines, and writes an integer-grid
 * JSON the page draws as SVG. No dependencies, no API key. Re-run it whenever you
 * want the streets refreshed, or after changing EDGE_KM — nothing else on timing.
 *
 * OSM data © OpenStreetMap contributors, ODbL. That credit must stay on the page.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Keep CENTRE in step with poll.js. The box is an asymmetric rectangle — km
// offsets from CENTRE — shaped to the Frome catchment: long N–S, reaching WSW
// down the Mells, barely east. It must contain the map's CROP_KM (docs/lib/
// map.js) with a small margin, so keep these ≥ CROP_KM + ~1.
const CENTRE = { lat: 51.2308, lon: -2.3208 };
const EDGE_KM = { n: 14, s: 11, e: 7, w: 16 };
const GRID = (EDGE_KM.e + EDGE_KM.w) * 1000;   // local units across the box (≈ 1/m)
const SIMPLIFY = 6;           // drop points closer than this many units to the line

// Tried in order — the main instance 504s on a box this size when it's busy.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// How OSM tags map to the layers the page styles. Order = draw order later.
const ROAD_CLASS = {
  motorway: 'major', trunk: 'major', primary: 'major',
  motorway_link: 'major', trunk_link: 'major', primary_link: 'major',
  secondary: 'mid', tertiary: 'mid', secondary_link: 'mid', tertiary_link: 'mid',
  unclassified: 'minor', residential: 'minor', living_street: 'minor',
};
const WATERWAY_CLASS = { river: 'river', canal: 'river', stream: 'stream', drain: 'stream' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'basemap.json');

// --- Geo -------------------------------------------------------------------

const metresPerDegLat = 111_132;
const box = (() => {
  const perLat = 1000 / metresPerDegLat;
  const perLon = 1000 / (metresPerDegLat * Math.cos((CENTRE.lat * Math.PI) / 180));
  return {
    W: CENTRE.lon - EDGE_KM.w * perLon,
    E: CENTRE.lon + EDGE_KM.e * perLon,
    S: CENTRE.lat - EDGE_KM.s * perLat,
    N: CENTRE.lat + EDGE_KM.n * perLat,
  };
})();

/** Web Mercator, world normalised to 0..1. */
function worldXY(lon, lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return [
    (lon + 180) / 360,
    0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  ];
}

const [wx0, wy0] = worldXY(box.W, box.N); // top-left
const [wx1, wy1] = worldXY(box.E, box.S); // bottom-right
const scale = GRID / (wx1 - wx0);
const height = Math.round((wy1 - wy0) * scale);

/** lon/lat → integer local grid coordinate. */
function project(lon, lat) {
  const [wx, wy] = worldXY(lon, lat);
  return [Math.round((wx - wx0) * scale), Math.round((wy - wy0) * scale)];
}

const [cX, cY] = project(CENTRE.lon, CENTRE.lat);   // town, in grid units

// --- Line simplification (Douglas–Peucker) --------------------------------

function segDist2(p, a, b) {
  let [x, y] = a;
  const dx = b[0] - x;
  const dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = b;
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}

function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let far = 0;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist2(points[i], points[lo], points[hi]);
      if (d > far) { far = d; idx = i; }
    }
    if (far > tol2) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// --- Fetch ---------------------------------------------------------------

const roadRe = Object.keys(ROAD_CLASS).join('|');
const waterRe = Object.keys(WATERWAY_CLASS).join('|');
const bbox = `${box.S},${box.W},${box.N},${box.E}`;
const query = `[out:json][timeout:120];
(
  way["highway"~"^(${roadRe})$"](${bbox});
  way["waterway"~"^(${waterRe})$"](${bbox});
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
  node["place"~"^(town|village|hamlet|suburb)$"](${bbox});
);
out geom;`;

console.log(`Fetching OSM for a ${EDGE_KM.w + EDGE_KM.e}×${EDGE_KM.n + EDGE_KM.s} km box around Frome…`);
const body = new URLSearchParams({ data: query });

async function overpass() {
  let lastErr;
  for (const url of OVERPASS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'frome-overflow-watch basemap build (github)',
          },
          body,
          signal: AbortSignal.timeout(240_000),
        });
        if (res.ok) return res.json();
        lastErr = new Error(`${url} → ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      console.log(`  ${lastErr.message}; retrying…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

const { elements } = await overpass();

// --- Transform ---------------------------------------------------------

const layers = { water: [], river: [], stream: [], major: [], mid: [], minor: [] };
const labels = { places: [], roads: [] };
const roadRuns = new Map();          // road name → [projected polyline, …]
const MIN_ROAD_LEN = 260;            // grid units (~metres) before a road is worth labelling
const NEAR_RD2 = (5000) ** 2;        // "central" road = midpoint within 5 km of the town

function addLine(geometry, bucket) {
  if (!layers[bucket] || !geometry || geometry.length < 2) return;
  const line = simplify(geometry.map((n) => project(n.lon, n.lat)), SIMPLIFY);
  if (line.length >= 2) layers[bucket].push(line.flat());
}

function polyLen(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}

for (const el of elements) {
  const t = el.tags ?? {};
  if (el.type === 'way' && t.highway) {
    const bucket = ROAD_CLASS[t.highway];
    addLine(el.geometry, bucket);
    // Named A/B-road-level streets ("Rodden Road", "Nunney Road") get a label.
    if (t.name && (bucket === 'major' || bucket === 'mid') && el.geometry?.length >= 2) {
      if (!roadRuns.has(t.name)) roadRuns.set(t.name, []);
      roadRuns.get(t.name).push(el.geometry.map((n) => project(n.lon, n.lat)));
    }
  } else if (el.type === 'way' && t.waterway) {
    addLine(el.geometry, WATERWAY_CLASS[t.waterway]);
  } else if (el.type === 'node' && /^(town|village|hamlet|suburb)$/.test(t.place ?? '') && t.name
             && !(t.place === 'hamlet' && /\b(farm|house|cottages?|barn)\b/i.test(t.name))) {
    const [x, y] = project(el.lon, el.lat);
    labels.places.push({ text: t.name, x, y, kind: t.place, d2: (x - cX) ** 2 + (y - cY) ** 2 });
  } else if (t.natural === 'water') {
    const rings = el.type === 'relation'
      ? (el.members ?? []).filter((m) => m.type === 'way' && (m.role === 'outer' || !m.role)).map((m) => m.geometry)
      : [el.geometry];
    for (const ring of rings) addLine(ring, 'water');
  }
}

for (const [name, runs] of roadRuns) {
  const len = runs.reduce((s, r) => s + polyLen(r), 0);
  if (len < MIN_ROAD_LEN) continue;
  const longest = runs.reduce((a, b) => (polyLen(a) >= polyLen(b) ? a : b));
  const [x, y] = longest[Math.floor(longest.length / 2)];
  labels.roads.push({ text: name, x, y, len: Math.round(len), d2: (x - cX) ** 2 + (y - cY) ** 2 });
}
// Roads near the town first (so the streets people navigate by aren't crowded
// out by long rural A-roads), then longest first. Then drop the `d2` field.
labels.roads = labels.roads
  .sort((a, b) => {
    const na = a.d2 < NEAR_RD2, nb = b.d2 < NEAR_RD2;
    if (na !== nb) return na ? -1 : 1;
    return b.len - a.len;
  })
  .slice(0, 110)
  .map(({ d2, ...r }) => r);

// List order is the page's label priority: towns, then villages / suburbs /
// hamlets each nearest-Frome first. The box reaches into the Radstock/Mendip
// fringe, so cap the further-out kinds — the nearest are the ones that orient you.
const PLACE_RANK = { town: 0, village: 1, suburb: 2, hamlet: 3 };
const PLACE_CAP = { town: 12, village: 40, suburb: 28, hamlet: 16 };
const kept = { town: 0, village: 0, suburb: 0, hamlet: 0 };
labels.places = labels.places
  .sort((a, b) => PLACE_RANK[a.kind] - PLACE_RANK[b.kind] || a.d2 - b.d2)
  .filter((p) => ++kept[p.kind] <= PLACE_CAP[p.kind])
  .map(({ d2, ...p }) => p);

const out = {
  generated: new Date().toISOString().slice(0, 10),
  attribution: '© OpenStreetMap contributors',
  centre: [CENTRE.lon, CENTRE.lat],
  box: [box.W, box.S, box.E, box.N],
  size: [GRID, height],
  layers,
  labels,
};

await writeFile(OUT, JSON.stringify(out));
const counts = Object.entries(layers).map(([k, v]) => `${k} ${v.length}`).join(', ');
const placeCounts = labels.places.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {});
console.log(`  ${counts}`);
console.log(`  labels: ${JSON.stringify(placeCounts)} places, ${labels.roads.length} roads`);
console.log(`  wrote docs/basemap.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
