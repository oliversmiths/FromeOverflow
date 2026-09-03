/**
 * The per-monitor list shown in the timeline panel: one card each, current
 * status plus a GitHub-style 90-day strip (one bar a day, from `dayCells`).
 *
 *   renderCards(containerEl, data);   // returns the ranked monitors
 */

import {
  dayCells, fmtDate, fmtDuration, fmtWhen, mapsUrl, rankByTotal, statusOf,
} from './format.js';

// Small map-pin glyph, inherits colour and font size from its link.
const PIN =
  '<svg class="pin" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 2a7.5 7.5 0 0 0-7.5 7.5c0 5.2 6.3 11.7 6.6 12a1.2 1.2 0 0 0 1.8 0' +
  'c.3-.3 6.6-6.8 6.6-12A7.5 7.5 0 0 0 12 2Zm0 10.2a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4Z"/></svg>';

const CELL_LABEL = {
  nodata: 'no data yet',
  dry: 'no discharge',
  recent: 'within 48h of a discharge',
  spill: 'discharging',
};

export function renderCards(container, data) {
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
      const lat = monitor.lat.toFixed(5);
      const lon = monitor.lon.toFixed(5);
      const geo = document.createElement('p');
      geo.className = 'o-geo';
      const link = document.createElement('a');
      link.href = mapsUrl(lat, lon);
      link.target = '_blank';
      link.rel = 'noopener';
      link.innerHTML = `${PIN}${lat}, ${lon}`;
      geo.append(link);
      card.append(geo);
    }

    container.append(card);
  }

  return monitors;
}
