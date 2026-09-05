/**
 * The per-monitor list shown in the timeline panel: one card each, current
 * status plus a GitHub-style 90-day strip (one bar a day, from `dayCells`).
 *
 *   renderCards(containerEl, data, onSeeOnMap);   // returns the ranked monitors
 *
 * `onSeeOnMap(monitor)` is called when a card's "View on map" button is clicked.
 */

import {
  dayCells, fmtDate, fmtDuration, fmtWhen, offlineMs, rankByTotal, statusOf,
  windowPhrase,
} from './format.js';

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

export function renderCards(container, data, onSeeOnMap) {
  const now = data.polled_at;
  const monitors = rankByTotal(data.monitors, now);
  container.replaceChildren();

  for (const monitor of monitors) {
    const state = statusOf(monitor.status);
    const last = monitor.events.at(-1);
    const runs = monitor.events.length;

    const card = document.createElement('div');
    card.className = `o-card is-${state.key}`;

    const head = document.createElement('div');
    head.className = 'o-head';
    const heading = document.createElement('h3');
    heading.textContent = monitor.label;
    const where = document.createElement('span');
    where.className = 'o-where';
    where.textContent = ` ${monitor.watercourse}`;
    heading.append(document.createTextNode(''), where);
    head.append(heading);

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
      d.dataset.tipStatus = CELL_LABEL[cell.state];
      d.dataset.tipState = cell.state;
      // Exactly one day per monitor is only *partly* covered: the one watching
      // started during. It is not a `nodata` day — we watched some of it — so say
      // that, rather than implying the whole day predates the record.
      const partial = monitor.since != null
        && cell.start <= monitor.since && monitor.since < cell.end;
      if (partial) d.dataset.tipNote = 'Incomplete day';
      strip.append(d);
    }

    const scale = document.createElement('div');
    scale.className = 'o-scale';
    scale.append(
      Object.assign(document.createElement('span'), { textContent: `${data.window_days} days ago` }),
      Object.assign(document.createElement('span'), { textContent: 'Today' }));

    card.append(head, meta, strip, scale);

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
