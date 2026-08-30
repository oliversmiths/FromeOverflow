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
