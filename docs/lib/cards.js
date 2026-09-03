/**
 * The per-monitor list shown in the timeline panel: one card each, current
 * status plus a GitHub-style 90-day strip (one bar a day, from `dayCells`).
 *
 *   renderCards(containerEl, data, onSeeOnMap);   // returns the ranked monitors
 *
 * `onSeeOnMap(monitor)` is called when a card's "View on map" button is clicked.
 */

import {
  dayCells, fmtDate, fmtDuration, fmtWhen, rankByTotal, statusOf,
} from './format.js';

// Magnifying-glass glyph for the "View on map" button — inherits colour and size.
const LOUPE =
  '<svg class="ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" ' +
  'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
  '<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="21" y2="21"/></svg>';

const CELL_LABEL = {
  nodata: 'no data yet',
  dry: 'no discharge',
  recent: 'within 48h of a discharge',
  spill: 'discharging',
};

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
    where.textContent = ` into ${monitor.watercourse}`;
    heading.append(document.createTextNode(''), where);
    head.append(heading);

    const meta = document.createElement('p');
    meta.className = 'o-meta';
    meta.textContent = runs
      ? `${runs} discharge${runs === 1 ? '' : 's'} in the last ${data.window_days} days` +
        ` · ${fmtDuration(monitor.total)} total · last was ${fmtWhen(last.start, now)}`
      : `no discharge in the last ${data.window_days} days`;

    const cells = dayCells(monitor, now, data.window_days);
    const tally = cells.reduce((t, c) => (t[c.state]++, t), { nodata: 0, dry: 0, recent: 0, spill: 0 });

    const strip = document.createElement('div');
    strip.className = 'o-strip';
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label',
      `${data.window_days}-day history: ${tally.spill} day${tally.spill === 1 ? '' : 's'} ` +
      `with a discharge, ${tally.recent} within 48h after, ${tally.dry} clear, ` +
      `${tally.nodata} before monitoring began`);
    for (const cell of cells) {
      const d = document.createElement('span');
      d.className = cell.state === 'dry' ? 'o-day' : `o-day o-day--${cell.state}`;
      d.title = `${fmtDate(cell.start)} — ${CELL_LABEL[cell.state]}`;
      strip.append(d);
    }

    const scale = document.createElement('div');
    scale.className = 'o-scale';
    scale.append(
      Object.assign(document.createElement('span'), { textContent: `${data.window_days} days ago` }),
      Object.assign(document.createElement('span'), { textContent: 'Today' }));

    card.append(head, meta, strip, scale);

    if (monitor.lat != null && monitor.lon != null) {
      const geo = document.createElement('p');
      geo.className = 'o-geo';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `${LOUPE}<span>View on map</span>`;
      btn.addEventListener('click', () => onSeeOnMap?.(monitor));
      geo.append(btn);
      card.append(geo);
    }

    container.append(card);
  }

  return monitors;
}
