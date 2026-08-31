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

/** Google Maps "drop a pin here" link (the documented Maps URLs API form). */
export const mapsUrl = (lat, lon) =>
  `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric',
});

/** Absolute calendar date: "5 Aug 2026". */
export function fmtDate(ms) {
  return DATE.format(new Date(ms));
}

/**
 * Relative phrasing for anything within the last week ("just now", "12 min ago",
 * "3 hours ago", "yesterday", "4 days ago"), falling back to an absolute date
 * beyond that. `now` defaults to the wall clock so the page can call it with a
 * single argument.
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
    return d === 1 ? 'yesterday' : `${d} days ago`;
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
    return { key: 'recent', text: `Discharged in the last ${RECENT_HOURS}h` };
  }
  return { key: 'dry', text: 'Not discharging' };
}

/**
 * One cell per day for the last `days` days (oldest first) — the data behind
 * the per-monitor 90-day strip on the page. Each cell is `{ start, state }`,
 * `start` being the local-midnight epoch ms of that day and `state` one of:
 *   'spill'  – a discharge overlapped the day
 *   'recent' – within RECENT_HOURS of a discharge ending, but not spilling
 *   'nodata' – no event, and the day is before this monitor's first reading
 *   'dry'    – monitored that day, no discharge, nothing recent
 * An ongoing event (`end == null`) counts as spilling right up to `now`. A known
 * event is always drawn even if it predates `since` — the first reading Wessex
 * hands us carries the latest event, so that one spill is real history.
 */
export function dayCells(monitor, now, days = 90) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = monitor.since ?? null;
  const events = monitor.events ?? [];
  const cells = [];

  for (let i = days - 1; i >= 0; i--) {
    const start = midnight.getTime() - i * DAY;
    const end = start + DAY;
    let state;

    if (events.some((e) => e.start < end && (e.end ?? now) > start)) {
      state = 'spill';
    } else if (events.some((e) => e.end != null && start < e.end + RECENT_MS && end > e.end)) {
      state = 'recent';
    } else if (since != null && end <= since) {
      state = 'nodata';
    } else {
      state = 'dry';
    }
    cells.push({ start, state });
  }
  return cells;
}

/**
 * Monitors sorted by total discharge time within the window, longest first,
 * each given a `total` field (ms). Ties break alphabetically by label. Input
 * monitors are not mutated.
 */
export function rankByTotal(monitors, now) {
  return monitors
    .map((m) => ({
      ...m,
      total: m.events.reduce((sum, e) => {
        const ms = spillMs(e, now);
        return Number.isFinite(ms) ? sum + Math.max(0, ms) : sum;
      }, 0),
    }))
    .sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label)));
}
