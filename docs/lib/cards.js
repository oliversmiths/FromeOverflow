/**
 * The per-monitor list shown in the timeline panel: one card each, current
 * status plus a switchable body — a GitHub-style 90-day strip (one bar a day,
 * from `dayCells`) or the EA's own multi-year annual-return history.
 *
 *   renderCards(containerEl, data, onSeeOnMap, { sort, view });   // returns the ranked monitors
 *   setCardsView(containerEl, view);                              // flips every rendered card at once
 *
 * `onSeeOnMap(monitor)` is called when a card's "View on map" button is clicked.
 * `sort` is one of `SORTS`' keys (default `'total'`); `view` is `'90day'`
 * (default) or `'history'` — the view every card, and the global toggle
 * (built in index.html), starts on.
 */

import {
  DAY, HOUR, annualHistory, avgAnnualDurationMs, dayCells, fmtAnnualReturn,
  fmtDate, fmtDuration, fmtSpillSpan, fmtWhen, offlineMs, rankByAvgDuration,
  rankByAvgSpills, rankByTotal, statusOf, windowPhrase,
} from './format.js';

const SORTS = {
  total: rankByTotal,
  avgSpills: rankByAvgSpills,
  avgDuration: rankByAvgDuration,
};

// A year's own severity tier, same three-colour vocabulary as the map
// popup's .pop-annual box — but a deliberately different threshold: that box
// tints on a single monitor's *latest* total, where under a minute reads as
// noise; this is a whole *year's* total, where under an hour is a real (if
// quiet) year rather than noise, so the floor is an hour, not a minute.
function yearSeverity(durationMs) {
  if (durationMs == null) return 'oxide';
  return durationMs < HOUR ? 'dry' : durationMs < DAY ? 'amber' : 'oxide';
}

// A card's own single representative tier — its *most recent* annual-return
// year's severity — used wherever a card needs one colour to stand for its
// whole History body: the left border (renderCards' applyView) and the
// legend swatches (buildHistoryView), so both agree with whatever the top
// (most recent) row's own bars are already showing. `null` with no
// annual-return data at all, not a guessed tier.
function monitorSeverity(monitor) {
  const hist = annualHistory(monitor);
  return hist.length ? yearSeverity(hist.at(-1).durationMs) : null;
}

// Magnifying-glass glyph for the "View on map" button — inherits colour and size.
const LOUPE =
  '<svg class="ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" ' +
  'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
  '<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="21" y2="21"/></svg>';

// Standalone status lines for the day tooltip (a coloured dot sits before each).
const CELL_LABEL = {
  nodata: 'Before watching began',
  dry: 'No discharge',
  offline: 'Monitor offline',
  recent: 'Within 48h of discharge',
  spill: 'Discharge recorded',
};

/**
 * A row of items as `.<itemClass>` spans joined by `.<sepClass>` dots, rather
 * than one text node — so CSS can wrap and style individual pieces
 * (`el.textContent = bits.join(' · ')` can't target "just this separator" or
 * colour one item differently from another).
 */
function joinRow(bits, itemClass, sepClass) {
  const frag = document.createDocumentFragment();
  bits.forEach(({ text, className }, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = sepClass;
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      frag.append(sep);
    }
    const item = document.createElement('span');
    item.className = className ? `${itemClass} ${className}` : itemClass;
    item.textContent = text;
    frag.append(item);
  });
  return frag;
}

/**
 * The card's History body: one row per EA annual-return year on record
 * (2024 on — see scripts/fetch-annual-returns.js's header for why earlier
 * years aren't reachable), most recent first, each with its exact spill
 * count and duration plus a pair of bars. `maxSpills`/`maxDuration` are the
 * biggest single-year figures across *every* rendered monitor (computed once
 * by renderCards, not per card) — a shared scale, not each card's own, so a
 * bar's length means the same thing wherever you see it on the page: a
 * monitor whose worst year barely registers next to the catchment's worst
 * offender looks that way, rather than every card's own max always filling
 * the row. A monitor `fetch-annual-returns.js` hasn't matched yet, or hasn't
 * been run since the monitor was added, gets a plain empty state rather than
 * a blank chart. `severity` is this monitor's own representative tier
 * (`monitorSeverity`, its most recent year) — colours the legend swatches to
 * match whatever the top row's own bars are already showing, since the
 * legend is illustrating this card's actual colours now, not a fixed example.
 */
function buildHistoryView(monitor, maxSpills, maxDuration, severity) {
  const wrap = document.createElement('div');
  wrap.className = 'o-view-history';

  const hist = annualHistory(monitor);
  if (!hist.length) {
    const p = document.createElement('p');
    p.className = 'o-history-empty';
    p.textContent = 'No Environment Agency annual return on record for this monitor yet.';
    wrap.append(p);
    return wrap;
  }

  const legend = document.createElement('p');
  legend.className = 'o-history-legend';
  legend.innerHTML =
    `<span class="o-history-swatch o-history-swatch--spills is-${severity}"></span>Spills` +
    `<span class="o-history-swatch o-history-swatch--duration is-${severity}"></span>Total duration`;
  wrap.append(legend);

  const rows = document.createElement('div');
  rows.className = 'o-history-rows';
  // `hist` itself stays oldest-first (annualHistory's own contract, and
  // `hist[0].year` below needs the oldest year regardless of display order)
  // — only the rendered rows go most-recent-first, a plain reverse of it.
  for (const h of [...hist].reverse()) {
    const row = document.createElement('div');
    row.className = 'o-history-row';

    const year = document.createElement('span');
    year.className = 'o-history-year';
    year.textContent = h.year;

    const figures = document.createElement('p');
    figures.className = 'o-history-figures';
    if (h.spillCount != null) {
      const b = document.createElement('strong');
      b.textContent = `${h.spillCount} spill${h.spillCount === 1 ? '' : 's'}`;
      figures.append(b);
    }
    if (h.durationMs != null) {
      figures.append(h.spillCount != null ? ', total ' : 'total ');
      const b = document.createElement('strong');
      b.textContent = fmtDuration(h.durationMs);
      figures.append(b);
    }

    // Both bars share this year's own severity tier (see yearSeverity above)
    // — solid for duration, a lighter tint of the same tier for spills — so
    // the pair reads as one year's story, not two differently-coloured
    // metrics.
    const tier = yearSeverity(h.durationMs);
    const bars = document.createElement('div');
    bars.className = 'o-history-bars';
    const spillBar = document.createElement('span');
    spillBar.className = `o-history-bar o-history-bar--spills is-${tier}`;
    spillBar.style.width = `${h.spillCount != null ? (h.spillCount / maxSpills) * 100 : 0}%`;
    const durBar = document.createElement('span');
    durBar.className = `o-history-bar o-history-bar--duration is-${tier}`;
    durBar.style.width = `${h.durationMs != null ? (h.durationMs / maxDuration) * 100 : 0}%`;
    bars.append(spillBar, durBar);

    row.append(year, figures, bars);
    rows.append(row);
  }
  wrap.append(rows);

  // Two different "average" flavours, deliberately labelled apart — spills is
  // the EA's own long-term figure (same one the map popup shows); duration is
  // this project's own mean across whatever years are on record, since the EA
  // publishes no long-term-average-duration figure at all. See
  // avgAnnualDurationMs's own comment.
  const avgBits = [];
  const spillsAvg = fmtAnnualReturn(monitor)?.avg;
  if (spillsAvg) avgBits.push(spillsAvg);
  const durationAvgMs = avgAnnualDurationMs(monitor);
  if (durationAvgMs != null) {
    avgBits.push(`avg ${fmtDuration(durationAvgMs)}/yr total since ${hist[0].year}`);
  }
  if (avgBits.length) {
    const avg = document.createElement('p');
    avg.className = 'o-history-avg';
    avg.textContent = avgBits.join(' · ');
    wrap.append(avg);
  }

  return wrap;
}

// Shared by each card's own toggle and the panel-wide one (index.html) that
// flips every rendered card at once — same operation either way, just a
// different caller.
function applyView(card, view) {
  card.dataset.view = view;
  const is90 = view !== 'history';
  card.querySelector('.o-view-90day').hidden = !is90;
  card.querySelector('.o-view-history').hidden = is90;
  const [btn90, btnHistory] = card.querySelectorAll('.o-view-btn');
  btn90.setAttribute('aria-pressed', String(is90));
  btnHistory.setAttribute('aria-pressed', String(!is90));

  // The left border follows whichever record is actually on screen — live
  // 90-day status normally (card.dataset.liveState, from statusOf), this
  // monitor's own representative historic severity in History view
  // (card.dataset.histState, from monitorSeverity — same tiers the bars and
  // legend already use). A monitor with no annual-return data at all has no
  // histState to show, so it just keeps its live colour even in History —
  // better than inventing a tier with nothing behind it.
  const key = is90 ? card.dataset.liveState : (card.dataset.histState || card.dataset.liveState);
  card.className = `o-card is-${key}`;
}

/** Flip every rendered card to `view` ('90day' | 'history') at once — the
 * panel-wide toggle above the list, built in index.html. */
export function setCardsView(container, view) {
  for (const card of container.querySelectorAll('.o-card')) applyView(card, view);
}

export function renderCards(container, data, onSeeOnMap, opts = {}) {
  const { sort = 'total', view = '90day' } = opts;
  const now = data.polled_at;
  const rank = SORTS[sort] ?? rankByTotal;
  const monitors = rank(data.monitors, now);
  container.replaceChildren();

  // One shared scale for every card's History bars, not a per-card one — see
  // buildHistoryView's own comment on why. 1 floors a page with no
  // annual-return data anywhere yet, same reason withTotal-style helpers do.
  const allHistory = monitors.flatMap((m) => annualHistory(m));
  const maxSpills = Math.max(1, ...allHistory.map((h) => h.spillCount ?? 0));
  const maxDuration = Math.max(1, ...allHistory.map((h) => h.durationMs ?? 0));

  for (const monitor of monitors) {
    const state = statusOf(monitor.status);
    const histSeverity = monitorSeverity(monitor);
    const last = monitor.events.at(-1);
    const runs = monitor.events.length;

    const card = document.createElement('div');
    card.className = 'o-card';
    // Read by applyView (below) to colour the left border for whichever
    // view is actually showing — live status normally, this monitor's own
    // representative historic severity in History (empty string with no
    // annual-return data at all, so applyView's own fallback kicks in).
    card.dataset.liveState = state.key;
    card.dataset.histState = histSeverity ?? '';
    // Looked up by the map popup's "View Timeline" link, the reverse of
    // this card's own "View on map" button.
    card.dataset.monitorId = monitor.id;

    const head = document.createElement('div');
    head.className = 'o-head';
    const heading = document.createElement('h3');
    heading.textContent = monitor.label;
    const where = document.createElement('span');
    where.className = 'o-where';
    where.textContent = ` ${monitor.watercourse}`;
    heading.append(document.createTextNode(''), where);

    // 90-Day / History — same switch as the panel-wide one above the list
    // (index.html), just scoped to this one card. `applyView` (below) is
    // what actually flips the two bodies; this only wires the clicks.
    const viewToggle = document.createElement('div');
    viewToggle.className = 'o-view-toggle';
    viewToggle.setAttribute('role', 'group');
    viewToggle.setAttribute('aria-label', `${monitor.label} view`);
    const btn90 = document.createElement('button');
    btn90.type = 'button';
    btn90.className = 'o-view-btn';
    btn90.textContent = '90-Day';
    btn90.addEventListener('click', () => applyView(card, '90day'));
    const btnHistory = document.createElement('button');
    btnHistory.type = 'button';
    btnHistory.className = 'o-view-btn';
    btnHistory.textContent = 'History';
    btnHistory.addEventListener('click', () => applyView(card, 'history'));
    viewToggle.append(btn90, btnHistory);

    head.append(heading, viewToggle);

    // Both running totals — time spent discharging, time spent dark — move to
    // the foot row (see below), alongside "View on map", leaving this line to
    // just say what happened and when.
    const dark = offlineMs(monitor, now);
    const window = windowPhrase(monitor, data.window_days, now);
    const bits = runs
      ? [`${runs} discharge${runs === 1 ? '' : 's'} ${window}`,
         `last was ${fmtWhen(last.start, now)}`]
      : [`0 discharge recorded ${window}`];

    const meta = document.createElement('p');
    meta.className = 'o-meta';
    meta.append(joinRow(bits.map((text) => ({ text })), 'o-meta-item', 'o-meta-sep'));

    const cells = dayCells(monitor, now, data.window_days);
    const tally = cells.reduce((t, c) => (t[c.state]++, t),
      { nodata: 0, dry: 0, offline: 0, recent: 0, spill: 0 });

    const strip = document.createElement('div');
    strip.className = 'o-strip';
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label',
      `${data.window_days}-day history: ${tally.spill} day${tally.spill === 1 ? '' : 's'} ` +
      `with a discharge, ${tally.recent} within 48h after, ${tally.offline} with the ` +
      `monitor offline, ${tally.dry} clear, ${tally.nodata} before watching began`);
    for (const cell of cells) {
      const d = document.createElement('span');
      d.className = cell.state === 'dry' ? 'o-day' : `o-day o-day--${cell.state}`;
      d.dataset.tipDate = fmtDate(cell.start);
      // A day can hold more than one discrete spill (or more than one
      // recently-ended one) — say so in the status line rather than the
      // generic singular label, since the note below lists them all.
      d.dataset.tipStatus = cell.state === 'spill' && cell.events.length > 1
        ? `${cell.events.length} discharges recorded`
        : CELL_LABEL[cell.state];
      d.dataset.tipState = cell.state;
      // Exactly one day per monitor is only *partly* covered: the one watching
      // started during. It is not a `nodata` day — we watched some of it — so say
      // that, rather than implying the whole day predates the record.
      const partial = monitor.since != null
        && cell.start <= monitor.since && monitor.since < cell.end;
      // A spill cell carries every event that earned it that state — show
      // each one's real start/end/length rather than leaving the reader with
      // just the generic label. One per line (`.tip-note` is
      // `white-space: pre-line`) rather than comma-separated, so two spills
      // read as two distinct events, not a single run-on span. `recent` skips
      // this: the spill itself is shown in full on its own (earlier) day, and
      // that day can fall just outside the visible window — not worth
      // special-casing for.
      const notes = [];
      if (cell.state === 'spill') notes.push(...cell.events.map((e) => fmtSpillSpan(e, now)));
      if (partial) notes.push('Incomplete day');
      if (notes.length) d.dataset.tipNote = notes.join('\n');
      strip.append(d);
    }

    const scale = document.createElement('div');
    scale.className = 'o-scale';
    scale.append(
      Object.assign(document.createElement('span'), { textContent: `${data.window_days} days ago` }),
      Object.assign(document.createElement('span'), { textContent: 'Today' }));

    // The two switchable bodies — only one is ever visible; `applyView`
    // (below) toggles which, keyed off `.o-view-90day`/`.o-view-history`
    // rather than anything more specific, so it works the same whether it's
    // this card's own toggle or the panel-wide one driving it.
    const view90day = document.createElement('div');
    view90day.className = 'o-view-90day';
    view90day.append(meta, strip, scale);

    const viewHistory = buildHistoryView(monitor, maxSpills, maxDuration, histSeverity);

    card.append(head, view90day, viewHistory);
    applyView(card, view);

    // The foot row: the two running totals on the left, "View on map" on the
    // right — using the space the button leaves spare rather than crowding
    // both totals into the meta line above. Colour-coded to match their
    // meaning elsewhere (oxide = discharging, silt = offline).
    const stats = [];
    if (runs) stats.push({ text: `${fmtDuration(monitor.total)} total`, className: 'o-total' });
    if (dark > 0) stats.push({ text: `${fmtDuration(dark)} offline`, className: 'o-offline' });

    const foot = document.createElement('div');
    foot.className = 'o-foot';
    if (stats.length) {
      const stat = document.createElement('span');
      stat.className = 'o-stats';
      stat.append(joinRow(stats, 'o-stat', 'o-stat-sep'));
      foot.append(stat);
    }
    if (monitor.lat != null && monitor.lon != null) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `${LOUPE}<span>View on map</span>`;
      btn.addEventListener('click', () => onSeeOnMap?.(monitor));
      foot.append(btn);
    }
    if (foot.children.length) card.append(foot);

    container.append(card);
  }

  return monitors;
}
