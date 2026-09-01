#!/usr/bin/env node
/**
 * Check the hand-curated PIN_TO_IDS list in poll.js against the live feed.
 *
 *   node scripts/audit-ids.js
 *
 * Fetches the whole Wessex feed, applies the fallback rule (radius + watercourse
 * name), and prints what the rule would pick that the list doesn't have, and
 * what the list has that the rule no longer matches. Nothing is written — it's
 * a nudge to review PIN_TO_IDS by hand. Run it every few months; Wessex rarely
 * add monitors now that EDM coverage is basically complete.
 */

import {
  fetchAll, matchesRule, haversineKm, CENTRE, PIN_TO_IDS,
} from '../poll.js';

console.log('Fetching Wessex Water storm overflow feed…');
const all = await fetchAll();

const byId = new Map(all.map((r) => [String(r.Id), r]));
const pinned = new Set(PIN_TO_IDS);
const matched = new Set(all.filter(matchesRule).map((r) => String(r.Id)));

const km = (id) => {
  const r = byId.get(id);
  return r ? haversineKm(CENTRE, { lat: r.Latitude, lon: r.Longitude }).toFixed(1) : '?';
};
const wc = (id) => byId.get(id)?.ReceivingWaterCourse ?? '(gone from feed)';

const toAdd = [...matched].filter((id) => !pinned.has(id)).sort();
const toDrop = [...pinned].filter((id) => !matched.has(id)).sort();

console.log(`\n${all.length} monitors region-wide · ${pinned.size} pinned · ${matched.size} match the rule\n`);

if (toAdd.length) {
  console.log(`The rule now matches ${toAdd.length} monitor(s) not in PIN_TO_IDS:`);
  for (const id of toAdd) console.log(`  + '${id}',  // ${wc(id)}  (${km(id)} km)`);
} else {
  console.log('Nothing new matches the rule.');
}

if (toDrop.length) {
  console.log(`\n${toDrop.length} pinned monitor(s) no longer match the rule (moved, retagged, or removed):`);
  for (const id of toDrop) console.log(`  - '${id}',  // ${wc(id)}  (${km(id)} km)`);
} else {
  console.log('\nEvery pinned monitor still matches the rule.');
}

console.log('\nEdit poll.js PIN_TO_IDS by hand if any of this looks right.');
