#!/usr/bin/env node
/**
 * Fill in the static reference data for each monitor from Wessex's
 * `overflow_context` layer.
 *
 *   node scripts/fetch-context.js          # write
 *   node scripts/fetch-context.js --dry    # show what would change
 *
 * The near real-time activity feed poll.js reads publishes only 11 fields — no
 * site name, no waterbody. Wessex put that on a *separate* public layer in the
 * same ArcGIS org, keyed on `National_Unique_Id_2025` (which holds the same
 * `WXW…` ids the activity feed uses; `National_Unique_Id` is the older `WSX…`
 * scheme, so if a future rename breaks this, that's the field to look at).
 *
 * None of it changes more than about once a year, so it is deliberately NOT part
 * of the 15-minute poll — run this by hand every few months, like
 * scripts/audit-ids.js. Nothing here touches `monitors.label`: that column stays
 * yours to hand-edit, and `exportJson` prefers it over `site_name`.
 */

import { DatabaseSync } from 'node:sqlite';

import { SCHEMA, DB_PATH, migrate } from '../poll.js';

const API =
  'https://services.arcgis.com/3SZ6e0uCvPROr4mS/arcgis/rest/services/' +
  'overflow_context/FeatureServer/0/query';

const KEY = 'National_Unique_Id_2025';

/** Our column ← their field. Doubles as the outFields list. */
const FIELDS = {
  site_name: 'Storm_Overflow_name',
  waterbody: 'Receiving_Waterbody_Catchment_N',
  overflow_type: 'Storm_Overflow_Type',
  treatment: 'Level_of_treatment',
  cause: 'Cause_of_Discharge',
};

const COLUMNS = Object.keys(FIELDS);
const CHUNK = 50;   // ids per request, to keep the URL a sane length

const dryRun = process.argv.includes('--dry');

/** ArcGIS pads and upper-cases inconsistently; store trimmed, or NULL if empty. */
const clean = (v) => {
  const s = typeof v === 'string' ? v.trim() : v;
  return s === '' || s === undefined ? null : s;
};

async function fetchContext(ids) {
  const rows = new Map();

  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const params = new URLSearchParams({
      where: `${KEY} IN (${batch.map((id) => `'${id}'`).join(',')})`,
      outFields: [KEY, ...Object.values(FIELDS)].join(','),
      returnGeometry: 'false',
      f: 'json',
    });

    const response = await fetch(`${API}?${params}`, {
      signal: AbortSignal.timeout(60_000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`overflow_context returned ${response.status}`);

    const body = await response.json();
    // ArcGIS reports failures with HTTP 200 and an error object.
    if (body.error) throw new Error(`overflow_context: ${body.error.message}`);

    for (const feature of body.features ?? []) {
      const a = feature.attributes;
      rows.set(String(a[KEY]), a);
    }
  }

  return rows;
}

const db = new DatabaseSync(DB_PATH);
db.exec(SCHEMA);
migrate(db);

const monitors = db.prepare('SELECT id, label FROM monitors ORDER BY id').all();
if (monitors.length === 0) {
  console.error('No monitors in the database yet — run `npm run poll` first.');
  db.close();
  process.exitCode = 1;
} else {
  // Our own ids, but quoted straight into a WHERE — keep them to the shape the
  // feed actually uses rather than trusting the column blindly.
  const ids = monitors.map((m) => m.id).filter((id) => /^[A-Za-z0-9_-]+$/.test(id));

  console.log(`Fetching overflow_context for ${ids.length} monitors…`);
  const context = await fetchContext(ids);
  console.log(`  ${context.size} matched\n`);

  const update = db.prepare(`
    UPDATE monitors
    SET site_name = ?, waterbody = ?, overflow_type = ?, treatment = ?,
        cause = ?, context_at = ?
    WHERE id = ?`);

  const now = Date.now();
  const missing = [];
  let changed = 0;

  const current = db.prepare(
    `SELECT ${COLUMNS.join(', ')} FROM monitors WHERE id = ?`);

  db.exec('BEGIN');
  try {
    for (const { id, label } of monitors) {
      const row = context.get(id);
      if (!row) { missing.push(id); continue; }

      const values = COLUMNS.map((col) => clean(row[FIELDS[col]]));
      const before = current.get(id);
      const differs = COLUMNS.some((col, i) => (before[col] ?? null) !== values[i]);

      if (differs) {
        changed += 1;
        const overridden = label ? `  (label "${label}" wins on the page)` : '';
        console.log(`  ${id}  ${values[0] ?? '?'}${overridden}`);
      }
      if (!dryRun) update.run(...values, now, id);
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  if (missing.length) {
    console.log(`\n${missing.length} monitor(s) had no context row — check ${KEY}:`);
    for (const id of missing) console.log(`  ? ${id}`);
  }

  console.log(
    `\n${changed} row(s) ${dryRun ? 'would change' : 'updated'}` +
    (dryRun ? ' — nothing written (--dry)' : '. Run `npm run poll` to republish data.json.'));
  db.close();
}
