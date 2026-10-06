#!/usr/bin/env node
/**
 * Fetch 15-minute rainfall from the Environment Agency's Frome gauge (531108)
 * into the `rainfall` table.
 *
 *   node scripts/fetch-rainfall.js          # top up (or backfill if empty)
 *   node scripts/fetch-rainfall.js --dry    # show what would change
 *
 * Two EA sources, same gauge, same UTC 15-minute stamps:
 *   - flood-monitoring API: 0.01 mm resolution, but only the last ~28 days.
 *   - Hydrology API: reaches back years, but each reading is rounded to 0.1 mm.
 * The 0.1 mm rounding matters against a 0.25 mm dry-weather threshold, so live
 * rows always win: Hydrology only fills what the live window can't reach, and
 * never overwrites a live row. Live rows overwrite Hydrology ones.
 *
 * Starts two days before the earliest monitor was first seen (the page's own
 * start, ~30 Aug 2026), so every spill has a full 24 hours of rain behind it.
 * Once the table has data, only the last few hours are re-read each run.
 *
 * Readings are "Unchecked" quality, same as the EA's own live feed.
 */

import { DatabaseSync } from 'node:sqlite';

import { SCHEMA, DB_PATH, migrate } from '../poll.js';

const STATION = '531108';
const LIVE = `https://environment.data.gov.uk/flood-monitoring/id/stations/${STATION}/readings.json`;
const HYDRO =
  'https://environment.data.gov.uk/hydrology/id/measures/' +
  '6f5f9100-ce2a-4094-9b9b-76d69be9a4cd-rainfall-t-900-mm-qualified/readings.json';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIVE_WINDOW_DAYS = 26; // the API keeps ~28; stay inside it
const HYDRO_CHUNK_DAYS = 28; // 96/day * 28 = 2688, under the 5000 limit
const OVERLAP_MS = 6 * HOUR; // re-read recent hours on a top-up, in case of late edits
const LEAD_MS = 2 * DAY;

const dryRun = process.argv.includes('--dry');

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(60_000),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`  ${e.message}; retrying…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** Live 15-minute readings from `fromMs` to now → [{ ts_ms, mm }]. */
async function fetchLive(fromMs) {
  const url = `${LIVE}?parameter=rainfall&_limit=10000&since=${new Date(fromMs).toISOString()}`;
  const { items } = await getJson(url);
  return items
    .filter((r) => typeof r.value === 'number')
    .map((r) => ({ ts_ms: Date.parse(r.dateTime), mm: r.value }));
}

/** Hydrology readings in [fromMs, toMs), chunked. Its stamps carry no 'Z'; they are UTC. */
async function fetchHydrology(fromMs, toMs) {
  const out = [];
  for (let start = fromMs; start < toMs; start += HYDRO_CHUNK_DAYS * DAY) {
    const end = Math.min(start + HYDRO_CHUNK_DAYS * DAY, toMs);
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const { items } = await getJson(
      `${HYDRO}?_limit=5000&mineq-date=${day(start)}&max-date=${day(end)}`);
    for (const r of items) {
      if (typeof r.value !== 'number') continue;
      out.push({ ts_ms: Date.parse(`${r.dateTime}Z`), mm: r.value });
    }
  }
  return out;
}

const db = new DatabaseSync(DB_PATH);
db.exec(SCHEMA);
migrate(db);

const earliest = db.prepare('SELECT MIN(first_seen) AS t FROM monitors').get().t;
const latestStored = db.prepare('SELECT MAX(ts_ms) AS t FROM rainfall WHERE station_id = ?').get(STATION).t;
const now = Date.now();
// Snapped to UTC midnight so the Hydrology range (whole days, end exclusive)
// butts up against it with no hole between the two sources.
const liveFrom = Math.floor(Math.max(now - LIVE_WINDOW_DAYS * DAY,
  latestStored != null ? latestStored - OVERLAP_MS : 0) / DAY) * DAY;
const wantFrom = (earliest ?? now) - LEAD_MS;

console.log(`Fetching rainfall for station ${STATION}…`);
const live = await fetchLive(liveFrom);
console.log(`  live: ${live.length} reading(s) since ${new Date(liveFrom).toISOString()}`);

// Hydrology only for what live can't reach, and only when the table has a hole
// there: nothing at the start, nothing up to the live window, or a gap over three
// hours between (a missing reading or two is normal -- the gauge drops
// some now and then -- so short gaps don't count). It only ever
// inserts, so asking again is harmless.
let hydro = [];
if (wantFrom < liveFrom) {
  const rows = db.prepare(
    'SELECT ts_ms FROM rainfall WHERE station_id = ? AND ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms')
    .all(STATION, wantFrom, liveFrom).map((r) => r.ts_ms);
  const edges = [wantFrom, ...rows, liveFrom];
  const hole = edges.some((t, i) => i > 0 && t - edges[i - 1] > 3 * HOUR);
  if (hole) {
    hydro = await fetchHydrology(Math.floor(wantFrom / DAY) * DAY, liveFrom);
    console.log(`  hydrology: ${hydro.length} reading(s) for the earlier gap`);
  }
}

const current = db.prepare('SELECT mm, source FROM rainfall WHERE station_id = ? AND ts_ms = ?');
// 'live' always overwrites; 'hydrology' only inserts.
const upsertLive = db.prepare(`
  INSERT INTO rainfall (station_id, ts_ms, mm, source) VALUES (?, ?, ?, 'live')
  ON CONFLICT (station_id, ts_ms) DO UPDATE SET mm = excluded.mm, source = 'live'`);
const insertHydro = db.prepare(`
  INSERT INTO rainfall (station_id, ts_ms, mm, source) VALUES (?, ?, ?, 'hydrology')
  ON CONFLICT (station_id, ts_ms) DO NOTHING`);

let added = 0;
let changed = 0;
db.exec('BEGIN');
try {
  for (const r of hydro) {
    if (current.get(STATION, r.ts_ms)) continue;
    added += 1;
    if (!dryRun) insertHydro.run(STATION, r.ts_ms, r.mm);
  }
  for (const r of live) {
    const before = current.get(STATION, r.ts_ms);
    if (!before) added += 1;
    else if (before.mm !== r.mm || before.source !== 'live') changed += 1;
    else continue;
    if (!dryRun) upsertLive.run(STATION, r.ts_ms, r.mm);
  }
  db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  db.close();
  throw error;
}

const span = db.prepare(
  'SELECT COUNT(*) AS n, MIN(ts_ms) AS a, MAX(ts_ms) AS b FROM rainfall WHERE station_id = ?').get(STATION);
console.log(
  `\n${added} added, ${changed} changed${dryRun ? ' — nothing written (--dry)' : '.'}` +
  (span.n ? ` Table holds ${span.n} reading(s), ${new Date(span.a).toISOString()} → ${new Date(span.b).toISOString()}.` : ''));
db.close();
