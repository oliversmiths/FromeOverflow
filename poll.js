#!/usr/bin/env node
/**
 * Poll Wessex Water's near real-time storm overflow feed, keep a local history
 * for the overflows around Frome, and export JSON for the page.
 *
 *   node poll.js
 *
 * No API key. No dependencies. Node 24 has node:sqlite and fetch built in.
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DAY, fmtDuration, spillMs } from './docs/lib/format.js';

// --- Configuration ---------------------------------------------------------

const API =
  'https://services.arcgis.com/3SZ6e0uCvPROr4mS/arcgis/rest/services/' +
  'Wessex_Water_Storm_Overflow_Activity/FeatureServer/0/query';

const PAGE_SIZE = 2000; // Wessex's documented per-request ceiling

// Frome town centre. Everything within RADIUS_KM is kept outright.
const CENTRE = { lat: 51.2308, lon: -2.3208 };
const RADIUS_KM = 8;

// Named watercourses are kept further out, to catch upstream outfalls whose
// spills reach the town — but only as far as CATCHMENT_KM. Wessex also supply
// Dorset, which has its own River Frome running to Poole Harbour, so an
// unbounded name match would drag in outfalls sixty miles away.
const WATERCOURSES = ['frome', 'mells', 'rodden'];
const CATCHMENT_KM = 25;

// Once you know which IDs you actually want, list them here and the geography
// is ignored entirely. Leave empty to keep discovering them.
const PIN_TO_IDS = [
  'WXW01297', // River Frome
  'WXW01245', // River Frome via SWS
  'WXW00454', // River Frome (S)
  'WXW00453', // River Frome (S)
  'WXW01242', // River Frome
  'WXW00051', // River Frome via SWS
  'WXW00711', // River Frome via SWS
  'WXW00934', // River Frome via SWS
  'WXW00805', // River Frome
  'WXW01185', // River Frome
  'WXW00880', // River Frome
  'WXW00062', // River Frome via SWS
  'WXW00654', // Trib of River Frome via SWS
  'WXW00420', // Adderwell Brook
];

const EXPORT_DAYS = 90;

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(ROOT, 'overflows.db');
const JSON_PATH = join(ROOT, 'docs', 'data.json');

// --- Database --------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS monitors (
  id           TEXT PRIMARY KEY,
  label        TEXT,            -- your name for it; the poller never overwrites this
  latitude     REAL,
  longitude    REAL,
  watercourse  TEXT,
  first_seen   INTEGER,
  last_seen    INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  monitor_id   TEXT NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER,         -- NULL while ongoing
  PRIMARY KEY (monitor_id, start_ms)
);

CREATE TABLE IF NOT EXISTS snapshots (
  polled_at       INTEGER NOT NULL,
  monitor_id      TEXT NOT NULL,
  status          INTEGER,
  latest_start_ms INTEGER,
  latest_end_ms   INTEGER,
  PRIMARY KEY (polled_at, monitor_id)
);

CREATE INDEX IF NOT EXISTS idx_events_start ON events (start_ms);
`;

/** node:sqlite rejects `undefined`, which ArcGIS hands us for absent fields. */
const val = (x) => (x === undefined ? null : x);

// --- Fetching --------------------------------------------------------------

async function fetchAll() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'false',
      f: 'json',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
    });

    const response = await fetch(`${API}?${params}`, {
      signal: AbortSignal.timeout(60_000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Wessex feed returned ${response.status}`);

    const body = await response.json();
    // ArcGIS reports failures with HTTP 200 and an error object.
    if (body.error) throw new Error(`Wessex feed: ${body.error.message}`);

    const page = (body.features ?? []).map((f) => f.attributes);
    rows.push(...page);

    if (page.length < PAGE_SIZE || !body.exceededTransferLimit) return rows;
  }
}

function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function isLocal(row) {
  if (PIN_TO_IDS.length > 0) return PIN_TO_IDS.includes(String(row.Id));

  const { Latitude: lat, Longitude: lon } = row;
  if (lat == null || lon == null) return false;

  const km = haversineKm(CENTRE, { lat, lon });
  if (km <= RADIUS_KM) return true;

  const watercourse = (row.ReceivingWaterCourse ?? '').toLowerCase();
  return km <= CATCHMENT_KM && WATERCOURSES.some((name) => watercourse.includes(name));
}

// --- Storing ---------------------------------------------------------------

/**
 * Wessex give us the latest event's start and end directly, so an event is
 * identified by (monitor, start). Seeing the same start again just fills in the
 * end time; a start we haven't seen before is a new spill.
 */
function store(db, rows, polledAt) {
  const upsertMonitor = db.prepare(`
    INSERT INTO monitors (id, latitude, longitude, watercourse, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      watercourse = excluded.watercourse,
      last_seen = excluded.last_seen`);

  const recordSnapshot = db.prepare(`
    INSERT OR REPLACE INTO snapshots
      (polled_at, monitor_id, status, latest_start_ms, latest_end_ms)
    VALUES (?, ?, ?, ?, ?)`);

  const seenEvent = db.prepare(
    'SELECT 1 AS found FROM events WHERE monitor_id = ? AND start_ms = ?');

  const upsertEvent = db.prepare(`
    INSERT INTO events (monitor_id, start_ms, end_ms) VALUES (?, ?, ?)
    ON CONFLICT(monitor_id, start_ms) DO UPDATE SET
      end_ms = COALESCE(excluded.end_ms, events.end_ms)`);

  let fresh = 0;

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const id = String(row.Id);

      upsertMonitor.run(
        id, val(row.Latitude), val(row.Longitude),
        row.ReceivingWaterCourse ?? 'Unknown', polledAt, polledAt);

      recordSnapshot.run(
        polledAt, id, val(row.Status),
        val(row.LatestEventStart), val(row.LatestEventEnd));

      const start = row.LatestEventStart;
      if (start == null) continue;

      // While it's still discharging the reported end belongs to a previous
      // event, so leave the end open until the status clears.
      const end = row.Status === 1 ? null : val(row.LatestEventEnd);

      if (!seenEvent.get(id, start)) fresh += 1;
      upsertEvent.run(id, start, end);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return fresh;
}

// --- Exporting -------------------------------------------------------------

async function exportJson(db, rows, polledAt) {
  const liveStatus = new Map(rows.map((r) => [String(r.Id), r.Status]));
  const cutoff = polledAt - EXPORT_DAYS * DAY;

  const eventsFor = db.prepare(`
    SELECT start_ms, end_ms FROM events
    WHERE monitor_id = ? AND start_ms >= ?
    ORDER BY start_ms`);

  // Only publish monitors the filter has matched recently. A monitor that drops
  // out — because you narrowed the catchment, or Wessex stopped listing it —
  // ages off the page after a week but keeps its history in the database.
  const monitors = db
    .prepare(`SELECT id, label, latitude, longitude, watercourse, first_seen FROM monitors
              WHERE last_seen >= ? ORDER BY id`)
    .all(polledAt - 7 * DAY)
    .map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      lat: m.latitude,
      lon: m.longitude,
      watercourse: m.watercourse,
      since: m.first_seen,
      status: liveStatus.get(m.id) ?? null,
      events: eventsFor.all(m.id, cutoff)
        .map((e) => ({ start: e.start_ms, end: e.end_ms })),
    }));

  await mkdir(dirname(JSON_PATH), { recursive: true });
  await writeFile(
    JSON_PATH,
    JSON.stringify(
      { polled_at: polledAt, window_days: EXPORT_DAYS, place: 'Frome', monitors },
      null, 1) + '\n');

  return monitors.length;
}

// --- Entry point -----------------------------------------------------------

async function main() {
  const polledAt = Date.now();

  console.log('Fetching Wessex Water storm overflow feed…');
  const all = await fetchAll();
  const local = all.filter(isLocal);
  console.log(`  ${all.length} overflows region-wide, ${local.length} near Frome`);

  if (local.length === 0) {
    console.error('  Nothing matched. Widen RADIUS_KM, or check the field names.');
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);

  const fresh = store(db, local, polledAt);
  const count = await exportJson(db, local, polledAt);
  db.close();

  const discharging = local.filter((r) => r.Status === 1);
  const offline = local.filter((r) => r.Status === -1).length;
  const ongoing = discharging
    .map((r) => spillMs({ start: r.LatestEventStart, end: null }, polledAt))
    .filter(Number.isFinite);

  console.log(
    `  ${discharging.length} discharging` +
    (ongoing.length ? ` (longest running ${fmtDuration(Math.max(...ongoing))})` : '') +
    `, ${offline} offline, ${fresh} new spill${fresh === 1 ? '' : 's'} recorded`);
  console.log(`  wrote docs/data.json (${count} monitors)`);
}

main().catch((error) => {
  console.error(`Poll failed: ${error.message}`);
  process.exitCode = 1;
});
