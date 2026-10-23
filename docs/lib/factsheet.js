/**
 * The Overview tab's factsheet: a bento grid of headline facts built from
 * `data.json`, ending in the call to action.
 *
 *   renderFactsheet(container, data, onSeeOnMap, cta);
 *
 * `cta` is the page's own "Take action" box (static HTML in index.html), moved
 * into the grid as its last, wide tile.
 *
 * Two kinds of figure sit side by side here and must never be added together
 * or drawn on one axis: the Environment Agency's annual returns (official,
 * counted by their 12/24h method, a year in arrears) and this project's own
 * live-tracked window (raw activations since watching began — a floor). Every
 * tile says which it is, via its kicker line.
 *
 * All maths goes through format.js, so a total here is the same total the
 * cards show.
 */

import {
  fmtDate, fmtDuration, fmtWhen, mapStatusOf, offlineMs, rankByTotal, recordIsYoung,
  spillWeather,
} from './format.js';

const EA = 'Environment Agency annual return';
const OURS = 'Tracked live by Overflow Watch';

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
};

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const hours = (h) => `${Math.round(h).toLocaleString('en-GB')} h`;
const name = (m) => m.site_name ? titleCase(m.site_name) : m.label;

// Wessex's site names arrive in capitals ("NUNNEY STORM TANK").
function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Wessex's overflow_type, grouped to three plain kinds. Shared by the "Where
// they are" tile and the league table's tags, so the two always agree.
const KINDS = [
  { label: 'On the sewer network', tag: 'Sewer network', test: (t) => /sewer network/i.test(t) },
  { label: 'At pumping stations', tag: 'Pumping station', test: (t) => /pumping station/i.test(t) },
  { label: 'At treatment works', tag: 'Treatment works', test: (t) => /water recycling centre/i.test(t) },
];
const kindOf = (m) => KINDS.find((k) => k.test(m.overflow_type ?? ''));
const groundwater = (m) => /groundwater/i.test(m.cause ?? '');

/** What a monitor is, as short tags: its kind, and groundwater if it applies. */
const tagsOf = (m) => [kindOf(m)?.tag, groundwater(m) ? 'Groundwater' : null].filter(Boolean);

/** One tile: kicker (what kind of figure), big figure, then any body nodes. */
function tile({ kicker, figure, unit, size = '', tone = '' }, ...body) {
  const t = el('section', `fs-tile ${size} ${tone}`.trim());
  if (kicker) t.append(el('p', 'fs-kicker', kicker));
  if (figure != null) {
    const f = el('p', 'fs-figure', figure);
    if (unit) f.append(el('span', 'fs-unit', ` ${unit}`));
    t.append(f);
  }
  t.append(...body.filter(Boolean));
  return t;
}

/** Horizontal bars, longest first: [{ label, value, text, monitor, tags }]. */
function bars(rows, onSeeOnMap) {
  const list = el('ol', 'fs-bars');
  const max = Math.max(...rows.map((r) => r.value), 1);
  for (const r of rows) {
    const li = el('li', 'fs-bar');
    const label = el(r.monitor ? 'button' : 'span', 'fs-bar-label', r.label);
    if (r.monitor) {
      label.type = 'button';
      label.title = 'View on map';
      label.addEventListener('click', () => onSeeOnMap(r.monitor));
    }
    const track = el('span', 'fs-bar-track');
    const fill = el('span', 'fs-bar-fill');
    fill.style.width = `${(r.value / max) * 100}%`;
    track.append(fill);
    const head = el('span', 'fs-bar-head');
    head.append(label, ...(r.tags ?? []).map((t) => el('span', 'fs-tag', t)));
    li.append(head, el('span', 'fs-bar-value', r.text), track);
    list.append(li);
  }
  return list;
}

// --- The figures ------------------------------------------------------------

/** Every EA year on record, oldest first, summed across the catchment. */
function eaYears(monitors) {
  const byYear = new Map();
  for (const m of monitors) {
    for (const r of m.annual_returns ?? []) {
      const y = byYear.get(r.year) ?? { year: r.year, spills: 0, hours: 0, monitors: 0 };
      y.spills += r.spill_count ?? 0;
      y.hours += r.duration_hours ?? 0;
      y.monitors += 1;
      byYear.set(r.year, y);
    }
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** Monitors ranked by one EA year's duration, with that year's row attached. */
function rankYear(monitors, year) {
  return monitors
    .map((m) => ({ m, r: (m.annual_returns ?? []).find((r) => r.year === year) }))
    .filter((x) => x.r?.duration_hours != null)
    .sort((a, b) => b.r.duration_hours - a.r.duration_hours);
}

/** How a site-wide window reads: "in the last 90 days" or "since 30.08.26". */
function sitePhrase(monitors, windowDays, now) {
  const earliest = Math.min(...monitors.map((m) => m.since ?? Infinity));
  return recordIsYoung({ since: earliest }, windowDays, now)
    ? `since watching began on ${fmtDate(earliest)}`
    : `in the last ${windowDays} days`;
}

// --- Rendering --------------------------------------------------------------

export function renderFactsheet(container, data, onSeeOnMap, cta) {
  container.replaceChildren();
  const now = data.polled_at;
  const monitors = data.monitors;
  const n = monitors.length;
  const windowDays = data.window_days;
  const phrase = sitePhrase(monitors, windowDays, now);

  const ranked = rankByTotal(monitors, now);
  const totalMs = ranked.reduce((s, m) => s + m.total, 0);
  const events = monitors.flatMap((m) => m.events.map((e) => ({ ...e, monitor: m })));
  const years = eaYears(monitors);
  const latest = years.at(-1);
  const prior = years.at(-2);

  const grid = el('div', 'fs-grid');

  // Right now — the same read the map pins and splash use.
  const states = monitors.map((m) => mapStatusOf(m, now).key);
  const live = states.filter((k) => k === 'discharging').length;
  const recent = states.filter((k) => k === 'recent').length;
  const offlineNow = states.filter((k) => k === 'offline').length;
  const last = events.filter((e) => e.start <= now).sort((a, b) => b.start - a.start)[0];
  grid.append(tile(
    { kicker: 'Right now', figure: String(live), unit: live === 1 ? 'overflow discharging' : 'overflows discharging',
      tone: live ? 'is-hot' : '' },
    el('p', 'fs-note', [
      recent ? `${recent} more discharged in the last 48 hours.` : null,
      last ? `Latest spill began ${fmtWhen(last.start, now)}, at ${name(last.monitor)}.` : null,
      offlineNow ? `${plural(offlineNow, 'monitor')} offline.` : null,
    ].filter(Boolean).join(' ')),
  ));

  // Catchment totals, EA years — one bar per year, on its own axis.
  if (years.length) {
    grid.append(tile(
      { kicker: EA, figure: hours(latest.hours), unit: `in ${latest.year}`, size: 'fs-wide' },
      el('p', 'fs-note', `Total spill time across all ${n} monitored overflows in the catchment, ` +
        `from ${plural(latest.spills, 'counted spill')}.`),
      bars(years.slice().reverse().map((y) => ({
        label: String(y.year), value: y.hours, text: `${hours(y.hours)} · ${plural(y.spills, 'spill')}`,
      }))),
    ));
  }

  // Our own window — kept apart from the EA tile on purpose.
  grid.append(tile(
    { kicker: OURS, figure: fmtDuration(totalMs), unit: 'spill time' },
    el('p', 'fs-note', `From ${plural(events.length, 'spill')} across the catchment ${phrase}. ` +
      'A floor, not a final figure: counted from Wessex Water’s live data, so it won’t match ' +
      'the official returns.'),
  ));

  // Top five, switchable between our window and each EA year.
  const league = tile({ kicker: 'Top five by spill duration', size: 'fs-wide fs-tall fs-league' });
  const switcher = el('div', 'fs-switch');
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', 'Period');
  const body = el('div');
  const periods = [
    { key: 'window', label: phrase.startsWith('in the last') ? `${windowDays} days` : `Since ${fmtDate(Math.min(...monitors.map((m) => m.since ?? Infinity)))}`, rows: () => ranked.filter((m) => m.total > 0).slice(0, 5)
      .map((m) => ({ label: name(m), value: m.total, text: fmtDuration(m.total), monitor: m, tags: tagsOf(m) })),
      note: `Tracked live, ${phrase}.` },
    ...years.slice().reverse().map((y) => ({
      key: String(y.year), label: String(y.year),
      rows: () => rankYear(monitors, y.year).slice(0, 5).map(({ m, r }) => ({
        label: name(m), value: r.duration_hours, text: hours(r.duration_hours), monitor: m, tags: tagsOf(m) })),
      note: `${EA}.`,
    })),
  ];
  const show = (p) => {
    for (const b of switcher.children) b.setAttribute('aria-pressed', String(b.dataset.key === p.key));
    const rows = p.rows();
    body.replaceChildren(
      rows.length ? bars(rows, onSeeOnMap) : el('p', 'fs-note', 'No spills recorded.'),
      el('p', 'fs-note fs-small', p.note));
  };
  for (const p of periods) {
    const b = el('button', 'fs-switch-btn', p.label);
    b.type = 'button';
    b.dataset.key = p.key;
    b.addEventListener('click', () => show(p));
    switcher.append(b);
  }
  league.append(switcher, body);
  show(periods[0]);
  grid.append(league);

  // Dry spills — only claimed for spills with usable rain data.
  const judged = events.filter((e) => spillWeather(e) != null);
  const dry = judged.filter((e) => spillWeather(e) === 'dry').length;
  grid.append(tile(
    { kicker: 'Dry-weather spills · live watch', figure: String(dry),
      unit: `of ${judged.length}`, tone: dry ? 'is-hot' : '' },
    el('p', 'fs-note', dry
      ? `spills ${phrase} began after no rain (0.25 mm or less at the Frome gauge in the 24 hours before). ` +
        'That indicates, not proves, a spill outside storm conditions.'
      : `No spill ${phrase} began after a dry day at the Frome gauge.`),
  ));

  // Groundwater — these can spill without rain at all.
  const ground = monitors.filter(groundwater).length;
  if (ground) {
    grid.append(tile(
      { kicker: 'Groundwater', figure: String(ground), unit: `of ${n}` },
      el('p', 'fs-note', 'overflows are known to be affected by groundwater: when the water table is ' +
        'high they can spill for long stretches, rain or not (Wessex Water).'),
    ));
  }

  // Year on year, with the rainfall caveat attached rather than left implied.
  if (prior && prior.hours > 0) {
    const change = Math.round(((latest.hours - prior.hours) / prior.hours) * 100);
    grid.append(tile(
      { kicker: 'Year on year change',
        figure: `${change > 0 ? '+' : ''}${change}%`, unit: 'spill time' },
      el('p', 'fs-note', `Catchment spill time ${change < 0 ? 'fell' : change > 0 ? 'rose' : 'held'} ` +
        `from ${hours(prior.hours)} in ${prior.year} to ${hours(latest.hours)} in ${latest.year}. Spill time follows the ` +
        'weather closely, so a wetter or drier year moves this as much as any change to the sewers.'),
      el('p', 'fs-note fs-small fs-foot', `${EA}.`),
    ));
  }

  // What kind of overflows — grouped from Wessex's own overflow_type.
  const kinds = KINDS
    .map((k) => ({ label: k.label, count: monitors.filter((m) => kindOf(m) === k).length }))
    .filter((k) => k.count);
  if (kinds.length) {
    grid.append(tile(
      { kicker: 'Where they are', figure: String(n), unit: 'storm overflows watched' },
      bars(kinds.map((k) => ({ label: k.label, value: k.count, text: String(k.count) }))),
    ));
  }

  // Honesty: how much of the record is missing.
  const darkMs = monitors.reduce((s, m) => s + offlineMs(m, now), 0);
  const darkMonitors = monitors.filter((m) => offlineMs(m, now) > 0).length;
  grid.append(tile(
    { kicker: 'Gaps in the record', figure: fmtDuration(darkMs), unit: 'offline', size: 'fs-wide' },
    el('p', 'fs-note', `Monitor time with no signal ${phrase}, across ${plural(darkMonitors, 'monitor')}. ` +
      'An offline monitor isn’t counted as spilling – but nor can it show that it wasn’t.'),
  ));

  if (cta) {
    cta.classList.add('fs-wide');
    grid.append(cta);
  }
  container.append(grid);
}
