#!/usr/bin/env node
/**
 * Build docs/basemap.json — the roads-and-waterways backdrop for the map view.
 *
 *   node scripts/build-basemap.js
 *
 * Pulls a 10 km box around Frome from the OpenStreetMap Overpass API, projects
 * it to Web Mercator, simplifies the lines, and writes a small integer-grid
 * JSON the page draws as SVG. No dependencies, no API key. Re-run it whenever
 * you want the streets refreshed — nothing else depends on the timing.
 *
 * OSM data © OpenStreetMap contributors, ODbL. That credit must stay on the page.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Keep the centre in step with CENTRE in poll.js; BOX_KM sets the whole extent.
const CENTRE = { lat: 51.2308, lon: -2.3208 };
const BOX_KM = 10;
const GRID = 10_000;          // local units across the box (≈ 1 unit per metre)
const SIMPLIFY = 6;           // drop points closer than this many units to the line

const OVERPASS = 'https://overpass-api.de/api/interpreter';

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
  const dLat = (BOX_KM * 1000) / 2 / metresPerDegLat;
  const dLon = (BOX_KM * 1000) / 2 / (metresPerDegLat * Math.cos((CENTRE.lat * Math.PI) / 180));
  return { W: CENTRE.lon - dLon, S: CENTRE.lat - dLat, E: CENTRE.lon + dLon, N: CENTRE.lat + dLat };
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
  node["place"="suburb"](${bbox});
);
out geom;`;

console.log(`Fetching OSM for ${BOX_KM} km around Frome…`);
const res = await fetch(`${OVERPASS}?${new URLSearchParams({ data: query })}`, {
  headers: {
    accept: 'application/json',
    'user-agent': 'frome-overflow-watch basemap build (github)',
  },
  signal: AbortSignal.timeout(180_000),
});
if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
const { elements } = await res.json();

// --- Transform ---------------------------------------------------------

const layers = { water: [], river: [], stream: [], major: [], mid: [], minor: [] };
const labels = { places: [], roads: [] };
const roadRuns = new Map();          // road name → [projected polyline, …]
const MIN_ROAD_LEN = 320;            // grid units (~metres) before a road is worth labelling

function addLine(geometry, bucket) {
  if (!geometry || geometry.length < 2) return;
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
  } else if (el.type === 'node' && t.place === 'suburb' && t.name) {
    const [x, y] = project(el.lon, el.lat);
    labels.places.push({ text: t.name, x, y });
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
  labels.roads.push({ text: name, x, y, len: Math.round(len) });
}
labels.roads.sort((a, b) => b.len - a.len);   // longer roads win the declutter
labels.roads = labels.roads.slice(0, 40);

const out = {
  generated: new Date().toISOString().slice(0, 10),
  attribution: '© OpenStreetMap contributors',
  box: [box.W, box.S, box.E, box.N],
  size: [GRID, height],
  layers,
  labels,
};

await writeFile(OUT, JSON.stringify(out));
const counts = Object.entries(layers).map(([k, v]) => `${k} ${v.length}`).join(', ');
console.log(`  ${counts}`);
console.log(`  labels: ${labels.places.length} suburbs, ${labels.roads.length} roads`);
console.log(`  wrote docs/basemap.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
