#!/usr/bin/env node
/**
 * Refresh the hand-curated swim spots and their latest readings.
 *
 *   node scripts/fetch-swim-spots.js          # write
 *   node scripts/fetch-swim-spots.js --dry    # show what would change
 *
 * SWIM_SPOTS below is the whole list — edit it by hand to add another spot,
 * the same way PIN_TO_IDS in poll.js is hand-curated. Coordinates are the
 * ones actually used for the pin/popup; they're the spot as people find it,
 * not necessarily wherever the sampling point's own coordinates land (the
 * FeatureServer's Farleigh Hungerford point is ~400m off from the crossing
 * people actually swim at).
 *
 * The readings come from a public ArcGIS FeatureServer behind Wessex Water's
 * own "Farleigh Hungerford Dashboard" (found by digging into the dashboard's
 * item config — it's not linked from the dashboard UI itself): weekly E. coli
 * / Intestinal Enterococci sampling with a plain-English verdict, and a daily
 * river-flow reading from the EA's hydrology API at the Tellisford gauge. The
 * flow reading isn't specific to one spot — Farleigh Hungerford and Tellisford
 * Weir are the same short reach of river — so it's written to every spot in
 * SWIM_SPOTS, not just whichever one is nearest the gauge. Water quality is
 * only sampled at Farleigh Hungerford; a spot with no reading for a layer
 * just keeps whatever it already had (staleness shows up in `fetched_at`
 * elsewhere, not by silently clearing a good reading).
 *
 * Not part of the 15-minute poll — run this by hand every so often. `--dry`
 * to preview.
 */

import { DatabaseSync } from 'node:sqlite';

import { SCHEMA, DB_PATH, migrate } from '../poll.js';

const API =
  'https://services.arcgis.com/3SZ6e0uCvPROr4mS/arcgis/rest/services/' +
  'farleigh_hungerford_wq_sampling/FeatureServer';

const SWIM_SPOTS = [
  {
    id: 'farleigh-hungerford',
    name: 'Farleigh Hungerford',
    latitude: 51.317830,
    longitude: -2.281940,
    recognised: 1,
    description: 'A recognised bathing spot on the Frome, sampled weekly through the season.',
    dashboardUrl: 'https://www.arcgis.com/apps/dashboards/a058553168f44f02905dd0b9dd667875',
    waterQuality: true,
  },
  {
    id: 'tellisford-weir',
    name: 'Tellisford Weir',
    latitude: 51.297801,
    longitude: -2.280823,
    recognised: 0,
    description: 'A popular spot on the Frome, just upstream of Farleigh Hungerford — not an officially recognised bathing water, so no water quality sampling here.',
    dashboardUrl: null,
    waterQuality: false,
  },
];

const dryRun = process.argv.includes('--dry');

async function arcgisQuery(url, params) {
  const body = new URLSearchParams({ f: 'json', ...params });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${url}?${body}`, {
        signal: AbortSignal.timeout(60_000),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      const json = await res.json();
      // ArcGIS reports failures with HTTP 200 and an error object.
      if (json.error) throw new Error(`${url}: ${json.error.message}`);
      return json.features ?? [];
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`  ${e.message}; retrying…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** The latest sampling date's rows — usually two, E. coli and Enterococci. */
async function fetchWaterQuality() {
  const rows = await arcgisQuery(`${API}/2/query`, {
    where: '1=1',
    outFields: 'Sample_Taken,Determinand,Units,Result,Latest_Status',
    orderByFields: 'Sample_Taken DESC',
    resultRecordCount: '8',
  });
  const latest = Math.max(...rows.map((r) => r.attributes.Sample_Taken));
  return rows
    .map((r) => r.attributes)
    .filter((a) => a.Sample_Taken === latest);
}

/** The single most recent flow reading. */
async function fetchFlow() {
  const rows = await arcgisQuery(`${API}/1/query`, {
    where: '1=1',
    outFields: 'dateTime,value',
    orderByFields: 'dateTime DESC',
    resultRecordCount: '1',
  });
  return rows[0]?.attributes ?? null;
}

console.log('Fetching swim spot readings…');
const [waterQuality, flow] = await Promise.all([fetchWaterQuality(), fetchFlow()]);
console.log(`  ${waterQuality.length} water-quality reading(s) for the latest sampling date` +
  (flow ? `, flow ${flow.value} m³/s` : ', no flow reading'));

const db = new DatabaseSync(DB_PATH);
db.exec(SCHEMA);
migrate(db);

const now = Date.now();

const upsertSpot = db.prepare(`
  INSERT INTO swim_spots (id, name, latitude, longitude, recognised, description,
    dashboard_url, flow_value, flow_measured_at, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    name = excluded.name, latitude = excluded.latitude, longitude = excluded.longitude,
    recognised = excluded.recognised, description = excluded.description,
    dashboard_url = excluded.dashboard_url,
    flow_value = COALESCE(excluded.flow_value, swim_spots.flow_value),
    flow_measured_at = COALESCE(excluded.flow_measured_at, swim_spots.flow_measured_at),
    fetched_at = excluded.fetched_at`);

const upsertReading = db.prepare(`
  INSERT INTO swim_spot_readings (spot_id, determinand, result, units, status, sampled_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (spot_id, determinand, sampled_at) DO UPDATE SET
    result = excluded.result, units = excluded.units, status = excluded.status`);

// Compared against before writing, same as fetch-context.js/fetch-annual-returns.js
// — this table is a keyed upsert either way (re-running never adds a duplicate
// row), so the point isn't to protect the database, only to make the console
// output say something true: "0 changed" on a re-run where nothing's new,
// rather than always claiming success regardless.
const SPOT_COLUMNS = ['name', 'latitude', 'longitude', 'recognised', 'description', 'dashboard_url', 'flow_value', 'flow_measured_at'];
const currentSpot = db.prepare(`SELECT ${SPOT_COLUMNS.join(', ')} FROM swim_spots WHERE id = ?`);
const READING_COLUMNS = ['result', 'units', 'status'];
const currentReading = db.prepare(
  'SELECT result, units, status FROM swim_spot_readings WHERE spot_id = ? AND determinand = ? AND sampled_at = ?');

let spotsChanged = 0;
let readingsChanged = 0;

db.exec('BEGIN');
try {
  for (const spot of SWIM_SPOTS) {
    const newSpot = {
      name: spot.name, latitude: spot.latitude, longitude: spot.longitude,
      recognised: spot.recognised, description: spot.description,
      dashboard_url: spot.dashboardUrl,
      flow_value: flow?.value ?? null, flow_measured_at: flow?.dateTime ?? null,
    };
    const beforeSpot = currentSpot.get(spot.id);
    const spotDiffers = !beforeSpot
      || SPOT_COLUMNS.some((col) => (beforeSpot[col] ?? null) !== (newSpot[col] ?? null));
    if (spotDiffers) {
      spotsChanged += 1;
      console.log(`  ${spot.name}${spot.recognised ? '' : ' (not recognised)'}`);
    }
    if (!dryRun) {
      upsertSpot.run(
        spot.id, spot.name, spot.latitude, spot.longitude, spot.recognised,
        spot.description, spot.dashboardUrl,
        newSpot.flow_value, newSpot.flow_measured_at, now);
    }

    if (spot.waterQuality) {
      for (const r of waterQuality) {
        const newReading = { result: r.Result, units: r.Units, status: r.Latest_Status };
        const beforeReading = currentReading.get(spot.id, r.Determinand, r.Sample_Taken);
        const readingDiffers = !beforeReading
          || READING_COLUMNS.some((col) => (beforeReading[col] ?? null) !== (newReading[col] ?? null));
        if (readingDiffers) {
          readingsChanged += 1;
          console.log(`    ${r.Determinand}: ${r.Result} ${r.Units}`);
        }
        if (!dryRun) {
          upsertReading.run(
            spot.id, r.Determinand, r.Result, r.Units, r.Latest_Status, r.Sample_Taken);
        }
      }
    }
  }
  db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  db.close();
  throw error;
}

console.log(
  `\n${spotsChanged} spot(s), ${readingsChanged} reading(s) ${dryRun ? 'would change' : 'changed'}` +
  (dryRun ? ' — nothing written (--dry)' : '.'));
db.close();
