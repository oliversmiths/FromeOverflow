#!/usr/bin/env node
/**
 * Fill in each monitor's regulator-verified annual spill figures from the
 * Environment Agency's EDM Storm Overflow Annual Return.
 *
 *   node scripts/fetch-annual-returns.js          # write
 *   node scripts/fetch-annual-returns.js --dry    # show what would change
 *
 * A public ArcGIS FeatureServer — the same data behind the EA's Storm
 * Overflow Explorer (https://experience.arcgis.com/experience/c9b8f3ba094c429aa30e0e2b6eaf43ac),
 * which is where a CSV export of this would otherwise have to come from by
 * hand every year. Keyed on `unique_id`, which holds the same `WXW…` ids the
 * activity feed uses — but **only from the 2024 annual return on**. Earlier
 * years (2021–2023) used the older `WSX####` scheme instead, `unique_id` is
 * NULL on those rows in this service, and there's no published crosswalk —
 * so those years are left alone rather than guessed at by fuzzy-matching
 * site names against regulator figures.
 *
 * This is deliberately the *other* number from what poll.js tracks: our own
 * totals are a live-tracked floor (see CLAUDE.md's "Known undercount"), this
 * is Wessex's official return for the year. Not part of the 15-minute poll —
 * run this by hand once EA publishes each year's figures (typically spring),
 * like scripts/fetch-context.js.
 */

import { DatabaseSync } from 'node:sqlite';

import { SCHEMA, DB_PATH, migrate } from '../poll.js';

const API =
  'https://services1.arcgis.com/JZM7qJpmv7vJ0Hzx/arcgis/rest/services/' +
  'edm_annual_returns_all_years_public/FeatureServer/0/query';

const KEY = 'unique_id';
const YEAR_FIELD = 'annual_return_year';
const OUT_FIELDS = [
  KEY, YEAR_FIELD,
  'counted_spills_12_24hr_calculated',
  'total_spill_duration_hrs_calculated',
  'longterm_average_spill_count_calculated',
  'data_start_calendar_year',
];
const CHUNK = 50;   // ids per request, to keep the URL a sane length

const dryRun = process.argv.includes('--dry');

/** ArcGIS's pre-parsed numeric fields arrive as numbers or nulls already —
 * only the year and the long-term-average's start year are strings here. */
function extract(a) {
  const spills = a.counted_spills_12_24hr_calculated;
  const startYear = a.data_start_calendar_year;
  return {
    spill_count: spills == null ? null : Math.round(spills),
    duration_hours: a.total_spill_duration_hrs_calculated ?? null,
    long_term_avg_spills: a.longterm_average_spill_count_calculated ?? null,
    data_start_year: startYear == null || startYear === '' ? null : Number(startYear),
  };
}

const COLUMNS = ['spill_count', 'duration_hours', 'long_term_avg_spills', 'data_start_year'];

async function fetchAnnualReturns(ids) {
  const rows = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const params = new URLSearchParams({
      where: `${KEY} IN (${batch.map((id) => `'${id}'`).join(',')})`,
      outFields: OUT_FIELDS.join(','),
      returnGeometry: 'false',
      f: 'json',
    });

    const response = await fetch(`${API}?${params}`, {
      signal: AbortSignal.timeout(60_000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`annual_returns returned ${response.status}`);

    const body = await response.json();
    // ArcGIS reports failures with HTTP 200 and an error object.
    if (body.error) throw new Error(`annual_returns: ${body.error.message}`);

    for (const feature of body.features ?? []) rows.push(feature.attributes);
  }

  return rows;
}

const db = new DatabaseSync(DB_PATH);
db.exec(SCHEMA);
migrate(db);

const monitors = db.prepare('SELECT id FROM monitors ORDER BY id').all();
if (monitors.length === 0) {
  console.error('No monitors in the database yet — run `npm run poll` first.');
  db.close();
  process.exitCode = 1;
} else {
  // Our own ids, but quoted straight into a WHERE — keep them to the shape the
  // feed actually uses rather than trusting the column blindly.
  const ids = monitors.map((m) => m.id).filter((id) => /^[A-Za-z0-9_-]+$/.test(id));

  console.log(`Fetching EA annual returns for ${ids.length} monitors…`);
  const rows = await fetchAnnualReturns(ids);

  // Rows with no unique_id are the pre-2024, WSX-keyed years — see the header
  // comment. Can't be matched to a monitor here, so they're dropped rather
  // than silently attributed to the wrong outfall.
  const matched = rows.filter((r) => r[KEY] != null && r[YEAR_FIELD] != null);
  const skipped = rows.length - matched.length;
  console.log(`  ${matched.length} year/monitor row(s) matched` +
    (skipped ? `, ${skipped} pre-2024 row(s) skipped (no WXW id)` : '') + '\n');

  const upsert = db.prepare(`
    INSERT INTO annual_returns (monitor_id, year, spill_count, duration_hours,
      long_term_avg_spills, data_start_year, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (monitor_id, year) DO UPDATE SET
      spill_count = excluded.spill_count,
      duration_hours = excluded.duration_hours,
      long_term_avg_spills = excluded.long_term_avg_spills,
      data_start_year = excluded.data_start_year,
      fetched_at = excluded.fetched_at`);

  const current = db.prepare(
    `SELECT ${COLUMNS.join(', ')} FROM annual_returns WHERE monitor_id = ? AND year = ?`);

  const now = Date.now();
  let changed = 0;

  db.exec('BEGIN');
  try {
    for (const attrs of matched) {
      const id = String(attrs[KEY]);
      const year = Number(attrs[YEAR_FIELD]);
      const values = extract(attrs);
      const before = current.get(id, year);
      const differs = !before
        || COLUMNS.some((col) => (before[col] ?? null) !== (values[col] ?? null));

      if (differs) {
        changed += 1;
        console.log(`  ${id}  ${year}  ${values.spill_count ?? '?'} spills, ` +
          `${values.duration_hours != null ? values.duration_hours.toFixed(1) : '?'}h`);
      }
      if (!dryRun) {
        upsert.run(id, year, values.spill_count, values.duration_hours,
          values.long_term_avg_spills, values.data_start_year, now);
      }
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  const missing = ids.filter((id) => !matched.some((r) => r[KEY] === id));
  if (missing.length) {
    console.log(`${missing.length} monitor(s) had no 2024+ annual return — check ${KEY}:`);
    for (const id of missing) console.log(`  ? ${id}`);
  }

  console.log(
    `\n${changed} row(s) ${dryRun ? 'would change' : 'updated'}` +
    (dryRun ? ' — nothing written (--dry)' : '.'));
  db.close();
}
