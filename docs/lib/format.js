/**
 * Shared duration maths and formatting.
 *
 * Imported by both `poll.js` and `docs/index.html`, so a spill is measured and
 * described identically in the console and on screen. This is the single source
 * of truth for how a discharge is counted — change it here, nowhere else.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Length of a spill in milliseconds. An event is `{ start, end }` in epoch ms;
 * while it is still discharging `end` is null and we measure up to `now`.
 * Returns NaN when the start is missing, so callers can filter it out.
 */
export function spillMs(event, now) {
  const start = event?.start;
  if (start == null) return NaN;
  const end = event.end == null ? now : event.end;
  return end - start;
}

/** Compact, human duration: "2d 4h", "3h 20m", "45m", "<1m". */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < MINUTE) return '<1m';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Google Maps "drop a pin here" link, opened on satellite view — the exact
 * ground an outfall or swim spot sits on is worth seeing, not just a road
 * map. Not the documented Maps URLs API (that only has a pin-less "centre
 * the map here" action, `map_action=map`); this is the format Maps' own
 * "Share location" link uses — `!3m1!1e3` is the satellite-layer flag.
 * Undocumented, but it's what Maps generates for itself, so it's held
 * stable for years.
 */
export const mapsUrl = (lat, lon) =>
  `https://www.google.com/maps/@${lat},${lon},18z/data=!3m1!1e3`;

/**
 * Absolute calendar date: "01.09.26" (DD.MM.YY, local calendar day). Numeric and
 * zero-padded rather than "1 Sept 2026" — shorter, and unambiguous for a UK
 * audience without pulling in a locale formatter for three extra characters.
 */
export function fmtDate(ms) {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

/**
 * Clock time only: "14:32" (24h, local, zero-padded) — paired with `fmtDate`
 * when a tooltip needs to say exactly when a spill started or ended, not just
 * which day it fell on.
 */
export function fmtTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * One-line description of a single spill's span and length, for the day-cell
 * tooltip: "14:32–16:05 · 1h 33m" when it starts and ends the same calendar
 * day, "04.09.26 14:32–05.09.26 02:10 · 11h 38m" when it crosses midnight (so
 * the reader isn't left assuming a same-day span), "14:32–ongoing · 3h 10m"
 * while still discharging.
 */
export function fmtSpillSpan(event, now) {
  const endMs = event.end ?? now;
  const startDay = fmtDate(event.start);
  const endDay = fmtDate(endMs);
  const startStr = startDay === endDay ? fmtTime(event.start) : `${startDay} ${fmtTime(event.start)}`;
  const endStr = event.end == null
    ? 'ongoing'
    : startDay === endDay ? fmtTime(event.end) : `${endDay} ${fmtTime(event.end)}`;
  return `${startStr}–${endStr} · ${fmtDuration(spillMs(event, now))}`;
}

/**
 * Relative phrasing for anything within the last week ("just now", "12 min ago",
 * "3 hours ago", "yesterday", "4d ago"), falling back to an absolute date beyond
 * that. `now` defaults to the wall clock so the page can call it with a single
 * argument.
 */
export function fmtWhen(ms, now = Date.now()) {
  const delta = now - ms;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) {
    const m = Math.floor(delta / MINUTE);
    return `${m} min ago`;
  }
  if (delta < DAY) {
    const h = Math.round(delta / HOUR);
    return h === 1 ? 'an hour ago' : `${h} hours ago`;
  }
  if (delta < 7 * DAY) {
    const d = Math.round(delta / DAY);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  }
  return fmtDate(ms);
}

/**
 * Status code → display. Codes (from Wessex's `Status` field):
 *   1  = discharging, -1 = offline / no signal, anything else = dry.
 * `key` matches the `.is-*` CSS classes in `index.html`.
 */
export function statusOf(status) {
  if (status === 1) return { key: 'discharging', text: 'Discharging' };
  if (status === -1) return { key: 'offline', text: 'No signal' };
  return { key: 'dry', text: 'Dry' };
}

/**
 * True while a monitor's own record is shallower than `windowDays` — the shared
 * condition behind `windowPhrase`, so a caller that needs to know *which* phrase
 * applies (not just read it) doesn't re-implement the check.
 */
export function recordIsYoung(monitor, windowDays, now) {
  const started = monitor?.since;
  return started != null && now - started < windowDays * DAY;
}

/**
 * How to describe the period a monitor's figures cover: "in the last 90 days"
 * once its record is that deep, otherwise "(watching since 30.08.26)".
 *
 * The "watching since" wording isn't a claim about history — it disambiguates
 * what the date means. A bare "since 30.08.26" reads as ordinary English for
 * "that's when it last happened", which may or may not be true (Wessex's own
 * history can reach further back than what this page publishes). Saying it's
 * when *we* started watching is true regardless of what, if anything, happened
 * before it — so it applies whenever the phrase is in its "since" form, for
 * every card, not just ones with no discharge. It's parenthesised rather than
 * inline ("3 discharges since watching began …") because that reads as a
 * trailing aside on the count, not a claim baked into the sentence.
 *
 * **Keep this permanently.** It reads the monitor's *own* `since`, not the
 * site's, so it is not just a launch-window patch: any monitor added later —
 * Wessex commission a new outfall, or you extend `PIN_TO_IDS` — starts its own
 * record from scratch, and for its first 90 days "in the last 90 days" would
 * claim a history nobody has. It switches over per monitor, on its own.
 *
 * `dayCells` (hatching before `since`) and `exportJson`'s event filter handle
 * the same case the same way, for the same reason.
 */
export function windowPhrase(monitor, windowDays, now) {
  return recordIsYoung(monitor, windowDays, now)
    ? `(watching since ${fmtDate(monitor.since)})`
    : `in the last ${windowDays} days`;
}

/** A discharge that ended within this long counts as "recent" on the map. */
export const RECENT_HOURS = 48;
export const RECENT_MS = RECENT_HOURS * HOUR;

/**
 * Four-state status for the map pins — the traffic light. Adds a "recent" step
 * that `statusOf` doesn't have:
 *   discharging – spilling right now            (red)
 *   recent      – stopped within RECENT_HOURS   (amber)
 *   dry         – not spilling, nothing recent  (green)
 *   offline     – no signal / unknown           (grey)
 * `key` matches the `.mappin--*` CSS classes in `index.html`.
 */
export function mapStatusOf(monitor, now) {
  if (monitor.status === 1) return { key: 'discharging', text: 'Discharging now' };
  if (monitor.status === -1 || monitor.status == null) {
    return { key: 'offline', text: 'No data' };
  }
  const last = monitor.events.at(-1);
  const endedAt = last ? (last.end ?? now) : null;
  if (endedAt != null && now - endedAt <= RECENT_MS) {
    return { key: 'recent', text: `Discharged <${RECENT_HOURS}h` };
  }
  return { key: 'dry', text: 'Not discharging' };
}

/**
 * One cell per day for the last `days` days (oldest first) — the data behind
 * the per-monitor 90-day strip on the page. Each cell is `{ start, end, state }`,
 * `start` being the local-midnight epoch ms of that day and `state` one of:
 *   'nodata'  – the day is before this monitor's first reading
 *   'spill'   – a discharge overlapped the day
 *   'recent'  – within RECENT_HOURS of a discharge ending, but not spilling
 *   'offline' – the monitor was reporting no signal for part of the day
 *   'dry'     – monitored that day, no discharge, nothing recent
 * checked in that order. `nodata` comes first deliberately: Wessex hand over
 * their latest event with the first reading, so a monitor can carry one spill
 * from months before we were watching. Drawing it put a lone red bar in a field
 * of hatching and implied the whole stretch was covered. Days before `since` are
 * unknown, and stay unknown. An ongoing event (`end == null`) counts as spilling
 * right up to `now`, and so does an unfinished offline spell.
 *
 * A `spill`/`recent` cell also carries `events` — every event that earned it
 * that state, oldest first — so a caller can show actual start/end times
 * rather than just the generic label. Usually one, but a day can hold more
 * than one discrete spill (or more than one recently-ended one), so this is
 * always an array, never a single event.
 */
export function dayCells(monitor, now, days = 90) {
  const since = monitor.since ?? null;
  const events = monitor.events ?? [];
  const offline = monitor.offline ?? [];
  const cells = [];

  // Local-midnight boundaries, one more than there are days so each cell can use
  // the next edge as its end.
  //
  // Stepped with setDate rather than subtracting a fixed 24 hours. A clock change
  // makes one day 23 or 25 hours, and a fixed offset would shift every earlier
  // cell off midnight for the rest of the window — putting an event just after
  // midnight in the wrong day. setDate asks the engine for "the same wall-clock
  // time, one calendar day on", so the rules live in the browser's timezone
  // database, not here: no transition date is hardcoded, it follows the viewer's
  // zone, and it keeps working when the dates move each year (or if the UK ever
  // changes the rules). Verified clean across all twelve UK transitions 2026–31.
  const edges = [];
  const walk = new Date(now);
  walk.setHours(0, 0, 0, 0);
  walk.setDate(walk.getDate() - (days - 1));
  for (let i = 0; i <= days; i++) {
    edges.push(walk.getTime());
    walk.setDate(walk.getDate() + 1);
  }

  for (let i = 0; i < days; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    let state;
    let matches;

    if (since != null && end <= since) {
      // Checked first: a day before this monitor's record began is unknown, and
      // stays unknown even if a stray event from the feed happens to cover it.
      state = 'nodata';
    } else if ((matches = events.filter((e) => e.start < end && (e.end ?? now) > start)).length) {
      state = 'spill';
    } else if ((matches = events.filter((e) => e.end != null && start < e.end + RECENT_MS && end > e.end)).length) {
      state = 'recent';
    } else if (offline.some((o) => o.start < end && (o.end ?? now) > start)) {
      state = 'offline';
    } else {
      state = 'dry';
    }
    cells.push(matches?.length ? { start, end, state, events: matches } : { start, end, state });
  }
  return cells;
}

/**
 * The Environment Agency's own regulator-verified figures for a monitor, for
 * the map popup's own `.pop-annual` box — split so the caller can style the
 * spill count and duration (the headline figures) differently from the rest
 * of the sentence:
 *   { year: 2025, spillCount: 58, duration: "3d 9h", durationMs: 291600000,
 *     avg: "61.6 spills/yr avg since 2019" }
 * reading as "58 spills, total 3d 9h in 2025" / "61.6 spills/yr avg since 2019".
 * `durationMs` is the same figure as `duration`, unformatted, so a caller can
 * threshold on it (the popup's `.pop-annual` box colour) without reparsing the
 * display string. `spillCount`/`duration`/`durationMs`/`avg` are `null`
 * independently if that part is missing; the whole thing is `null` when
 * there's no annual-return data yet — a monitor `scripts/fetch-annual-returns.js`
 * hasn't matched, or hasn't been run since this monitor was added.
 *
 * Deliberately the *other* number from everything else on this page: ours is
 * a live-tracked floor that can miss a spill between two 15-minute polls (see
 * CLAUDE.md's "Known undercount"); this is Wessex's official return, counted
 * by EA's own 12–24h method. They're expected to disagree.
 */
export function fmtAnnualReturn(monitor) {
  const returns = monitor.annual_returns;
  if (!returns?.length) return null;
  const latest = returns.at(-1);   // exported oldest first
  if (latest.spill_count == null && latest.duration_hours == null) return null;

  const avg = latest.long_term_avg_spills != null && latest.data_start_year != null
    ? `${latest.long_term_avg_spills.toFixed(1)} spills/yr avg since ${latest.data_start_year}`
    : null;

  return {
    year: latest.year,
    spillCount: latest.spill_count,
    duration: latest.duration_hours != null ? fmtDuration(latest.duration_hours * HOUR) : null,
    durationMs: latest.duration_hours != null ? latest.duration_hours * HOUR : null,
    avg,
  };
}

/**
 * Every EA annual-return year on record for a monitor, oldest first — the
 * card's own History view (`fmtAnnualReturn` above only ever surfaces the
 * latest):
 *   [{ year: 2024, spillCount: 98, durationMs: 5189400000 },
 *    { year: 2025, spillCount: 73, durationMs: 2806372705 }]
 * `spillCount`/`durationMs` are `null` independently, same as
 * `fmtAnnualReturn`. Always 2024 on — see scripts/fetch-annual-returns.js's
 * header for why 2021–2023 can't be matched to a monitor. Empty array, not
 * null, when there's no annual-return data yet, so callers can check
 * `.length` without a null guard first.
 */
export function annualHistory(monitor) {
  const returns = monitor.annual_returns;
  if (!returns?.length) return [];
  return returns
    .filter((r) => r.spill_count != null || r.duration_hours != null)
    .map((r) => ({
      year: r.year,
      spillCount: r.spill_count ?? null,
      durationMs: r.duration_hours != null ? r.duration_hours * HOUR : null,
    }));
}

/**
 * The Environment Agency's own long-term average spill count for a monitor —
 * the same figure `fmtAnnualReturn`'s `avg` formats into a sentence, as a
 * plain number for sorting. `null` with no annual-return data yet.
 */
export function avgAnnualSpills(monitor) {
  const returns = monitor.annual_returns;
  return returns?.length ? returns.at(-1).long_term_avg_spills ?? null : null;
}

/**
 * This project's *own* mean annual discharge duration across whatever EA
 * annual-return years are on record for a monitor (2024 on) — not an EA
 * figure. Their data has a long-term-average spill *count* (see
 * `avgAnnualSpills`) but no equivalent for duration, so this is ours: a
 * plain mean of however many years we actually have, which today is one or
 * two. `null` if no year on record has a duration.
 */
export function avgAnnualDurationMs(monitor) {
  const durations = annualHistory(monitor).map((h) => h.durationMs).filter((v) => v != null);
  return durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
}

/**
 * A swim spot's latest water-quality sampling, for the map popup:
 *   { date: "11.08.26", status: "…excellent indicative water quality…",
 *     readings: ["E coli 170/100mL", "Enterococci 66/100mL"] }
 * `readings` is every determinand sampled on that same date — usually both
 * E. coli and Intestinal Enterococci, the two the Bathing Water Regulations
 * require — built from `result`/`determinand` rather than the source's own
 * `units` string, which bakes the determinand name into ungainly text
 * ("E. Coli/ 100 mL"). `status` is Wessex's own sentence, shown verbatim
 * rather than trying to extract just "excellent"/"poor" from it — a plain
 * word we guessed out of their phrasing could misread a future sentence
 * shaped differently than today's samples. `null` when the spot has no
 * water-quality data (not sampled here, or not fetched yet).
 */
export function fmtWaterQuality(spot) {
  const readings = spot.water_quality;
  if (!readings?.length) return null;
  const latest = readings[0];   // exported newest first
  return {
    date: fmtDate(latest.sampled_at),
    status: latest.status,
    readings: readings
      .filter((r) => r.sampled_at === latest.sampled_at)
      .map((r) => `${r.determinand} ${r.result}/100mL`),
  };
}

/**
 * A swim spot's latest river-flow reading, for the map popup: "0.52 m³/s
 * (10.08.26)". `null` when there's no reading yet.
 */
export function fmtFlow(spot) {
  const flow = spot.flow;
  if (flow?.value == null) return null;
  return `${flow.value.toFixed(2)} m³/s (${fmtDate(flow.measured_at)})`;
}

/**
 * Total time a monitor spent offline within the published window, in ms. The
 * counterpart to a monitor's discharge `total`: "no discharge recorded" means
 * much less when the sensor was dark for a stretch, so the card says both.
 */
export function offlineMs(monitor, now) {
  return (monitor.offline ?? []).reduce((sum, span) => {
    const ms = spillMs(span, now);
    return Number.isFinite(ms) ? sum + Math.max(0, ms) : sum;
  }, 0);
}

/**
 * Every monitor given a `total` field (ms) — the 90-day (or whatever window)
 * discharge total, clipped to the monitor's own record: if a spill was
 * already running when we first saw the monitor, only the part we actually
 * watched is counted, so the total never claims time the record doesn't
 * cover. Shared by all three `rankBy*` functions below, since the card's own
 * 90-day figure is shown regardless of which one sorted the list. Input
 * monitors are not mutated.
 */
function withTotal(monitors, now) {
  return monitors.map((m) => ({
    ...m,
    total: m.events.reduce((sum, e) => {
      const start = m.since == null ? e.start : Math.max(e.start, m.since);
      const ms = spillMs({ start, end: e.end }, now);
      return Number.isFinite(ms) ? sum + Math.max(0, ms) : sum;
    }, 0),
  }));
}

// A monitor with no value for the field being sorted always sorts last,
// regardless of direction — "unknown" isn't the same claim as "zero".
function byFieldDesc(get) {
  return (a, b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return String(a.label).localeCompare(String(b.label));
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av || String(a.label).localeCompare(String(b.label));
  };
}

/**
 * Monitors sorted by total discharge time within the window, longest first,
 * each given a `total` field (ms). Ties break alphabetically by label.
 */
export function rankByTotal(monitors, now) {
  return withTotal(monitors, now).sort(byFieldDesc((m) => m.total));
}

/**
 * Monitors sorted by the Environment Agency's own long-term average spill
 * count (the same figure `fmtAnnualReturn`'s `avg` formats, from the latest
 * annual-return year on record), highest first. A monitor with no
 * annual-return data yet sorts last, not to zero.
 */
export function rankByAvgSpills(monitors, now) {
  return withTotal(monitors, now).sort(byFieldDesc((m) => avgAnnualSpills(m)));
}

/**
 * Monitors sorted by *this project's own* mean annual duration across
 * whatever EA annual-return years are on record (2024 on — see
 * scripts/fetch-annual-returns.js's header for why earlier years are
 * unreachable), highest first. Deliberately not called an "average" in the
 * EA sense: there's no long-term-average-duration field in their data, only
 * a spill-count one, so this is ours, not theirs — see `avgAnnualDurationMs`.
 */
export function rankByAvgDuration(monitors, now) {
  return withTotal(monitors, now).sort(byFieldDesc((m) => avgAnnualDurationMs(m)));
}
