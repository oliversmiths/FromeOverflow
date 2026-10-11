#!/usr/bin/env node
/**
 * Reconcile our own events against Wessex's verified event history.
 *
 *   node scripts/fetch-event-history.js          # write
 *   node scripts/fetch-event-history.js --dry    # show what would change
 *   node scripts/fetch-event-history.js --force  # even if Wessex haven't republished
 *
 * The activity feed poll.js reads shows only each monitor's *latest* event,
 * so two things slip through a 15-minute poll: a spill that ends and is
 * replaced by a newer one before we see its end (poll.js closes it at the next
 * event's start and marks it `end_source = 'superseded'`), and, rarer, a spill
 * that starts and ends entirely between two polls. Wessex publish every event
 * in a separate public table — one row per spill, `EventVerified` — but about
 * a month in arrears, which is why it backs up the feed rather than replacing
 * it. This script:
 *
 *   - replaces a superseded (guessed) end with the verified one, and
 *   - adds any spill we never saw at all, marked `source = 'history'`.
 *
 * Nothing else is touched: an end the feed gave us directly is never
 * overwritten (a disagreement is only reported), and nothing before a
 * monitor's `first_seen` is added — before then we weren't watching, so it
 * isn't something we missed (same rule exportJson publishes by).
 *
 * **Times in this table are UK wall-clock time labelled as UTC.** A spill at
 * 14:04 BST arrives as "14:04Z", and there are no events at all in the hour
 * the clocks skip each spring. `londonToUtc` undoes that.
 *
 * Runs every poll.yml tick, but costs one small metadata request unless the
 * table has been edited since it was last applied (`history_sync`).
 */

import { DatabaseSync } from 'node:sqlite';

import { SCHEMA, DB_PATH, migrate } from '../poll.js';

const BASE = 'https://services.arcgis.com/3SZ6e0uCvPROr4mS/arcgis/rest/services/';

// One service per calendar year, named however Wessex chose to name it that
// year (2026's `_view` is empty; `_view2` is the real one). Hand-maintained:
// when a new year starts, find it in the service list at BASE + '?f=json'
// and add it here — the script warns until you do.
const SERVICES = {
  2026: 'Wessex_Water_Event_Duration_Monitoring_2026_view2',
};

const PAGE_SIZE = 2000;
const CHUNK = 50;   // ids per request, to keep the URL a sane length

const dryRun = process.argv.includes('--dry');
const force = process.argv.includes('--force');

// --- Time -------------------------------------------------------------------

const london = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** How far ahead of UTC London's clocks are at this instant, in ms. */
function londonOffset(ms) {
  const p = Object.fromEntries(london.formatToParts(ms).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** A London wall-clock time stored as if it were UTC → the real instant. */
function londonToUtc(wallMs) {
  const guess = wallMs - londonOffset(wallMs);
  return wallMs - londonOffset(guess);
}

// --- Fetching ---------------------------------------------------------------

async function getJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const body = await response.json();
  // ArcGIS reports failures with HTTP 200 and an error object.
  if (body.error) throw new Error(`${url}: ${body.error.message}`);
  return body;
}

async function lastEdited(service) {
  const meta = await getJson(`${BASE}${service}/FeatureServer/0?f=json`);
  return meta.editingInfo?.dataLastEditDate ?? null;
}

/** Every event for these monitors starting on or after `fromWall` (wall-clock ms). */
async function fetchEvents(service, ids, fromWall) {
  const from = new Date(fromWall).toISOString().slice(0, 19).replace('T', ' ');
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const params = new URLSearchParams({
        where: `SiteId IN (${batch.map((id) => `'${id}'`).join(',')}) ` +
          `AND EventStart >= timestamp '${from}'`,
        outFields: 'SiteId,EventStart,EventEnd,EventVerified',
        orderByFields: 'OBJECTID',
        resultOffset: String(offset),
        resultRecordCount: String(PAGE_SIZE),
        returnGeometry: 'false',
        f: 'json',
      });
      const body = await getJson(`${BASE}${service}/FeatureServer/0/query?${params}`);
      for (const f of body.features ?? []) rows.push(f.attributes);
      if (!body.exceededTransferLimit) break;
    }
  }
  return rows;
}

// --- Reconciling ------------------------------------------------------------

const db = new DatabaseSync(DB_PATH);
db.exec(SCHEMA);
migrate(db);

const monitors = db.prepare('SELECT id, first_seen FROM monitors WHERE first_seen IS NOT NULL').all();
// Quoted straight into a WHERE — keep to the shape the feed actually uses.
const ids = monitors.map((m) => m.id).filter((id) => /^[A-Za-z0-9_-]+$/.test(id));
const firstSeen = new Map(monitors.map((m) => [m.id, m.first_seen]));

if (ids.length === 0) {
  console.error('No monitors in the database yet — run `npm run poll` first.');
  process.exitCode = 1;
} else {
  const earliest = Math.min(...firstSeen.values());
  const years = [];
  for (let y = new Date(earliest).getUTCFullYear(); y <= new Date().getUTCFullYear(); y++) years.push(y);

  const synced = db.prepare('SELECT data_edited_at FROM history_sync WHERE service = ?');
  const markSynced = db.prepare(`
    INSERT INTO history_sync (service, data_edited_at, applied_at) VALUES (?, ?, ?)
    ON CONFLICT (service) DO UPDATE SET
      data_edited_at = excluded.data_edited_at, applied_at = excluded.applied_at`);

  const eventsOf = db.prepare(
    'SELECT start_ms, end_ms, end_source FROM events WHERE monitor_id = ? ORDER BY start_ms');
  const setEnd = db.prepare(
    "UPDATE events SET end_ms = ?, end_source = 'history' WHERE monitor_id = ? AND start_ms = ?");
  const insert = db.prepare(`
    INSERT INTO events (monitor_id, start_ms, end_ms, source, end_source)
    VALUES (?, ?, ?, 'history', 'history')`);

  let filled = 0, added = 0, disagree = 0, clash = 0;

  for (const year of years) {
    const service = SERVICES[year];
    if (!service) {
      console.log(`::warning::No event-history service listed for ${year} — add it to SERVICES ` +
        'in scripts/fetch-event-history.js.');
      continue;
    }

    const edited = await lastEdited(service);
    const before = synced.get(service)?.data_edited_at;
    if (!force && edited != null && before === edited) {
      console.log(`${year}: unchanged since ${new Date(edited).toISOString()}, skipping.`);
      continue;
    }

    // A day's slack so the wall-clock filter can't clip a spill near the edge.
    const fromWall = Math.max(earliest, Date.UTC(year, 0, 1)) - 86_400_000;
    const rows = await fetchEvents(service, ids, fromWall);
    console.log(`${year}: ${rows.length} event(s) in Wessex's history for our monitors` +
      (edited ? ` (edited ${new Date(edited).toISOString()})` : ''));

    db.exec('BEGIN');
    try {
      for (const r of rows) {
        if (r.EventStart == null || r.EventEnd == null) continue;
        const id = String(r.SiteId);
        const start = londonToUtc(r.EventStart);
        const end = londonToUtc(r.EventEnd);
        // Before we were watching isn't missed, it's just history.
        if (end < (firstSeen.get(id) ?? Infinity)) continue;

        const ours = eventsOf.all(id);
        const same = ours.find((e) => e.start_ms === start);
        const when = `${id}  ${new Date(start).toISOString().slice(0, 16)}Z`;

        if (same) {
          if (same.end_ms === end) continue;
          if (same.end_source === 'superseded' || same.end_ms == null) {
            filled += 1;
            console.log(`  end   ${when}  ${fmt(same.end_ms)} → ${fmt(end)}` +
              (same.end_source === 'superseded' ? '  (was inferred)' : ''));
            if (!dryRun) setEnd.run(end, id, start);
          } else if (same.end_source !== 'history') {
            // The feed told us this end directly — keep ours, just say so.
            disagree += 1;
            console.log(`  ?     ${when}  feed says ${fmt(same.end_ms)}, history ${fmt(end)} (kept feed)`);
          }
          continue;
        }

        // A spill we have no row for. Only add it if it doesn't overlap one we
        // do have — an overlap means the two sources split a spill differently,
        // which is worth a look by hand rather than a guess.
        const overlaps = ours.some((e) => e.start_ms < end && (e.end_ms ?? Infinity) > start);
        if (overlaps) {
          clash += 1;
          console.log(`  clash ${when}–${fmt(end)} overlaps one of ours, not added`);
          continue;
        }
        added += 1;
        console.log(`  added ${when}–${fmt(end)}  (missed by the poller)`);
        if (!dryRun) insert.run(id, start, end);
      }
      if (!dryRun && edited != null) markSynced.run(service, edited, Date.now());
      db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }

  const left = db.prepare("SELECT COUNT(*) AS n FROM events WHERE end_source = 'superseded'").get().n;
  console.log(
    `\n${filled} end(s) filled in, ${added} missed spill(s) ${dryRun ? 'would be ' : ''}added` +
    (disagree ? `, ${disagree} feed/history disagreement(s)` : '') +
    (clash ? `, ${clash} overlap(s) left alone` : '') +
    `. ${left} inferred end(s) still waiting on Wessex.` +
    (dryRun ? ' Nothing written (--dry).' : ''));
}
db.close();

function fmt(ms) {
  return ms == null ? 'open' : new Date(ms).toISOString().slice(11, 16) + 'Z';
}
