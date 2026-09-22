/**
 * The no-library map: draws `basemap.json` (roads + waterways) as one SVG whose
 * viewBox is the camera, with an HTML overlay of pins, labels and popups on top.
 * Pan/zoom/pinch are clamped to `CROP_KM`, an asymmetric box on the town.
 *
 *   buildMap(hostEl, data, { initialZoom: 0.28 });
 *   renderLegend(ulEl);
 *
 * The Web Mercator projection in `drawMap` MUST match `scripts/build-basemap.js`.
 */

import {
  DAY, MINUTE, RECENT_HOURS, fmtAnnualReturn, fmtDate, fmtDuration, fmtFlow,
  fmtWhen, fmtWaterQuality, mapStatusOf, mapsUrl, offlineMs, spillMs,
  windowPhrase,
} from './format.js';

const SVGNS = 'http://www.w3.org/2000/svg';

// Map-pin glyph for the popup's coordinate link — inherits colour and size.
const PIN =
  '<svg class="pin" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 2a7.5 7.5 0 0 0-7.5 7.5c0 5.2 6.3 11.7 6.6 12a1.2 1.2 0 0 0 1.8 0' +
  'c.3-.3 6.6-6.8 6.6-12A7.5 7.5 0 0 0 12 2Zm0 10.2a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4Z"/></svg>';
// Three ascending bars for the popup's "View Timeline" link — echoes the
// timeline's own day strip, the reverse direction of cards.js's LOUPE.
const BARS =
  '<svg class="ico" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" ' +
  'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
  '<path d="M4 20V13"/><path d="M12 20V7"/><path d="M20 20V16"/></svg>';
// Two overlapping squares — "copy", for the Share button's own action
// (copying the popup's URL), not a generic share-arrow glyph.
const COPY =
  '<svg class="ico" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" ' +
  'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">' +
  '<rect x="8" y="8" width="12" height="12" rx="1.5"/>' +
  '<path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>';
// Four corner brackets — the map-ctrl reset button, read as "back to fit"
// rather than a directional arrow. An SVG rather than a unicode dingbat: a
// dingbat's ink isn't centred in its own em-box (varies by glyph, let alone
// across `--body`'s system-ui, which resolves to a different actual font per
// OS), so it can't be centred reliably with CSS alone the way an SVG can
// (`.map-reset` below just grid-centres the box). Font Awesome Pro
// (commercial licence) — confirm redistribution rights before this ships in
// a commit; swap for a Free-tier or hand-drawn equivalent otherwise.
const RESET =
  '<svg class="ico" viewBox="0 0 640 640" width="18" height="18" aria-hidden="true">' +
  '<path fill="currentColor" d="M240 96L256 96L256 128L128 128L128 256L96 256L96 96L240 96zM96 400L96 384L128 384' +
  'L128 512L256 512L256 544L96 544L96 400zM528 96L544 96L544 256L512 256L512 128L384 128L384 96L528 96zM512 400' +
  'L512 384L544 384L544 544L384 544L384 512L512 512L512 400z"/></svg>';
const DRAW_ORDER = ['water', 'stream', 'river', 'minor', 'mid', 'major'];
const MAX_ZOOM_IN = 40;   // smallest viewBox = zoomed-out width / this
// How far out you can pull back. At 1 the crop (CROP_KM below) exactly covers
// the viewport — never a gap past its edges: a wide screen shows the full crop
// width and pans up/down, a tall screen the full height and pans left/right.
// Below 1 the stop comes sooner; keep it >= the page's initialZoom.
const MAX_ZOOM_OUT = 1;

// A monitor outside the crop (or panned off-screen) can either be pinned to the
// edge as a marker, or simply hidden. Flip to true to bring the edge markers
// back — the positioning logic in screenXY still computes them.
const SHOW_EDGE_MARKERS = false;

// A label shows only once the view is at or below this fraction of the
// fully-zoomed-out width (1 = zoomed right out, smaller = leaning in). Towns
// always; villages/suburbs mid-zoom; hamlets and road names once you lean in.
const LABEL_ZOOM = { town: 1.1, village: 1.1, road: 0.55, waterway: 0.55, suburb: 0.5, hamlet: 0.22 };

// Named brooks/streams (build-basemap.js's OS Open Rivers pull) as labels on
// the water lines themselves. Flip to false if that reads as clutter rather
// than useful orientation — nothing else depends on it.
const SHOW_WATERWAY_LABELS = true;

// The camera is clamped to this rectangle, not the whole basemap — an asymmetric
// box on the town (km from CENTRE) shaped to the Frome catchment: long N–S,
// reaching WSW down the Mells, barely east. Keep it inside EDGE_KM in
// scripts/build-basemap.js so the streets are there.
const CROP_KM = { n: 13, s: 10, e: 6, w: 15 };

export const LEGEND = [
  //['discharging', 'Discharging now'],
  //['recent', `Discharged in the last ${RECENT_HOURS}h`],
  //['dry', 'Not discharging'],
  //['offline', 'No data / offline'],
   ['discharging', 'Discharging now'],
  ['recent', `Discharged recently`],
  ['dry', 'Not discharging'],
  ['offline', 'Offline'],
  ['swim', 'Swimming spot', 'swimpin'],
];

export function renderLegend(ul) {
  for (const [key, text, extraClass] of LEGEND) {
    const li = document.createElement('li');
    li.className = `legend--${key}`;   // colours the dot and the label together
    const dot = document.createElement('span');
    dot.className = extraClass ? `mappin ${extraClass}` : 'mappin';
    li.append(dot, document.createTextNode(text));
    ul.append(li);
  }
}

// The second half of a popup: static reference data from Wessex's
// `overflow_context` layer, filled in by scripts/fetch-context.js. Everything
// above the divider comes from the live activity feed; everything below is
// context that explains it. Rows with no value are skipped, so a monitor whose
// context hasn't been fetched simply shows the feed half. `treatment` is
// fetched and stored (scripts/fetch-context.js, monitors.treatment) but not
// listed here — it reads like Wessex's own framing of the discharge rather
// than a neutral fact, and it's one of the longer fields for the space it
// bought. Still in the database and in data.json for anyone who wants it.
const CONTEXT_ROWS = [
  ['Site', 'site_name'],
  ['Waterbody', 'waterbody'],
  ['Type', 'overflow_type'],
  ['Cause', 'cause'],
];

/**
 * Copies the popup's own URL to the clipboard — by the time this can be
 * clicked, openPopup()/openSwimPopup() has already set `location.hash` to
 * this item's own Id, so `location.href` is already the exact link. In
 * popup() it lives inside the collapsed "+ More" section (.pop-more) so the
 * popup's default view stays as uncluttered as it was before sharing
 * existed; swimPopup() has no other reason for a "+ More" toggle to exist
 * (no CONTEXT_ROWS-style data to hide), so there it sits straight in
 * .pop-foot instead. The label swaps to a brief "Copied!"/"Copy failed"
 * acknowledgement rather than opening any toast/tooltip machinery of its own.
 */
function buildShareButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pop-action pop-share';
  const label = document.createElement('span');
  label.textContent = 'Share';
  btn.innerHTML = COPY;
  btn.append(label);
  let resetTimer = 0;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(location.href);
      label.textContent = 'Copied!';
    } catch {
      label.textContent = 'Copy failed';
    }
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { label.textContent = 'Share'; }, 1600);
  });
  return btn;
}

function popup(monitor, now, windowDays, onSeeInTimeline) {
  const state = mapStatusOf(monitor, now);
  const last = monitor.events.at(-1);
  const el = document.createElement('div');

  // Label and watercourse share one heading line; each in its own span so the
  // stylesheet can treat them differently.
  const h = document.createElement('h3');
  const label = document.createElement('span');
  label.className = 'pop-label';
  label.textContent = monitor.label;
  const w = document.createElement('span');
  w.className = 'pop-watercourse';
  w.textContent = monitor.watercourse;
  h.append(label, ' ', w);

  // State and coordinates share one row — status left, location right — so the
  // link costs no extra height. It closes the feed half, directly above the
  // context divider. `.pop-top` wraps to two rows if they can't sit side by side.
  const s = document.createElement('p');
  s.className = `pop-state is-${state.key}`;
  s.textContent = state.text;

  const top = document.createElement('div');
  top.className = 'pop-top';
  top.append(s);

  if (monitor.lat != null && monitor.lon != null) {
    const lat = monitor.lat.toFixed(5);
    const lon = monitor.lon.toFixed(5);
    const a = document.createElement('a');
    a.href = mapsUrl(lat, lon);
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = `${PIN}<span>${lat}, ${lon} ↗</span>`;
    top.append(a);
  }

  const d = document.createElement('p');
  d.className = 'pop-last';
  d.textContent = last
    ? `Last discharge ${fmtWhen(last.start, now)}, ${fmtDuration(spillMs(last, now))}.`
    : `0 discharge recorded ${windowPhrase(monitor, windowDays, now)}.`;

  el.append(h, d);

  // Same caveat the timeline cards carry: what the record doesn't cover.
  const dark = offlineMs(monitor, now);
  if (dark > 0) {
    const o = document.createElement('p');
    o.className = 'pop-offline';
    o.textContent = `Offline for ${fmtDuration(dark)} in that time.`;
    el.append(o);
  }

  el.append(top);

  // Its own box, not CONTEXT_ROWS entries below — a regulator's published
  // figure reads as a claim of its own, not just another attribute of the
  // monitor. Ahead of the context divider, not after it: this is a live-ish
  // fact worth seeing before you'd have to go looking for it.
  const annualReturn = fmtAnnualReturn(monitor);
  if (annualReturn) {
    const box = document.createElement('div');
    // Tinted by the total's own severity, same three-colour vocabulary as
    // everywhere else on the page (pins, the 90-day strip): under a minute
    // reads as noise rather than a real discharge (--dry), under a day is
    // worth a second look (--amber), a day or more is the existing --oxide.
    // `durationMs` is null when the return has a spill count but no duration
    // — falls back to the oxide default rather than guessing.
    const { durationMs } = annualReturn;
    const tint = durationMs == null ? 'oxide' : durationMs < MINUTE ? 'dry' : durationMs < DAY ? 'amber' : 'oxide';
    box.className = `pop-annual pop-annual--${tint}`;
    const heading = document.createElement('p');
    heading.className = 'pop-annual-heading';
    heading.textContent = 'Environment Agency Annual Return';

    // The spill count and duration are the headline figures, so they're bold
    // — everything else ("total", "in <year>") is just the sentence holding
    // them together.
    const yearLine = document.createElement('p');
    const { spillCount, duration, year } = annualReturn;
    if (spillCount != null) {
      const b = document.createElement('strong');
      b.textContent = `${spillCount} spill${spillCount === 1 ? '' : 's'}`;
      yearLine.append(b);
    }
    if (duration != null) {
      yearLine.append(spillCount != null ? ', total ' : 'total ');
      const b = document.createElement('strong');
      b.textContent = duration;
      yearLine.append(b);
    }
    yearLine.append(` in ${year}`);

    box.append(heading, yearLine);
    if (annualReturn.avg) {
      const avgLine = document.createElement('p');
      avgLine.textContent = annualReturn.avg;
      box.append(avgLine);
    }
    el.append(box);
  }

  // Collapsed by default. Not a native <details> — its content would have to
  // live inside it, sharing .pop-foot's flex row with "View Timeline"
  // and getting squeezed into whatever width that leaves (a 2-column grid of
  // full sentences doesn't fit in that); a plain toggle button lets the
  // revealed .pop-more render full-width, below the row, once it's open.
  // Always built, even with no CONTEXT_ROWS to show — Share (see
  // buildShareButton) lives in here too, and needs a home regardless of
  // whether this monitor's context has been fetched yet.
  const rows = CONTEXT_ROWS.filter(([, key]) => monitor[key]);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pop-action pop-more-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<span>+ More</span>';

  const more = document.createElement('div');
  more.className = 'pop-more';
  more.hidden = true;
  if (rows.length) {
    const dl = document.createElement('dl');
    dl.className = 'pop-context';
    for (const [term, key] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = monitor[key];
      dl.append(dt, dd);
    }
    more.append(dl);
  }
  more.append(buildShareButton());

  toggle.addEventListener('click', () => {
    more.hidden = !more.hidden;
    toggle.setAttribute('aria-expanded', String(!more.hidden));
    toggle.querySelector('span').textContent = more.hidden ? '+ More' : '− Less';
  });

  // The reverse of the timeline card's own "View on map" button.
  const foot = document.createElement('div');
  foot.className = 'pop-foot';
  foot.append(toggle);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pop-action';
  btn.innerHTML = `${BARS}<span>View Timeline</span>`;
  btn.addEventListener('click', () => onSeeInTimeline(monitor));
  foot.append(btn);
  el.append(foot, more);

  return el;
}

/**
 * A swim spot's popup — a different shape of content entirely from an
 * overflow monitor's, so its own renderer rather than forcing `popup()` to
 * branch. Name, a recognised/not-recognised line, the description, the
 * latest water-quality reading (its own box, same treatment as `popup()`'s
 * annual-return one) and river flow if there is one, and a link out to
 * Wessex's own dashboard for the full history.
 */
function swimPopup(spot) {
  const el = document.createElement('div');

  // Same shape as popup() above: heading, then the one live-ish fact, then
  // state + coordinates sharing a row.
  const h = document.createElement('h3');
  const label = document.createElement('span');
  label.className = 'pop-label';
  label.textContent = spot.name;
  h.append(label);

  const flow = fmtFlow(spot);
  const f = document.createElement('p');
  f.className = 'pop-last';
  f.textContent = flow ? `River flow at Tellisford: ${flow}` : 'No river flow reading yet.';

  el.append(h, f);

  const badge = document.createElement('p');
  badge.className = `pop-state ${spot.recognised ? 'is-dry' : 'is-offline'}`;
  badge.textContent = spot.recognised ? 'Recognised bathing spot' : 'Unofficial bathing spot';

  const top = document.createElement('div');
  top.className = 'pop-top';
  top.append(badge);

  if (spot.lat != null && spot.lon != null) {
    const lat = spot.lat.toFixed(5);
    const lon = spot.lon.toFixed(5);
    const a = document.createElement('a');
    a.href = mapsUrl(lat, lon);
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = `${PIN}<span>${lat}, ${lon} ↗</span>`;
    top.append(a);
  }

  el.append(top);

  // Only relevant where a spot is actually sampled — same "set apart, not
  // just another attribute" treatment as popup()'s annual-return box. Always
  // the --oxide tint: unlike that box, there's no severity scale here.
  const wq = fmtWaterQuality(spot);
  if (wq) {
    const box = document.createElement('div');
    box.className = 'pop-annual pop-annual--oxide';
    const heading = document.createElement('p');
    heading.className = 'pop-annual-heading';
    heading.textContent = 'Water Quality';
    const statusLine = document.createElement('p');
    statusLine.textContent = wq.status;
    const readingsLine = document.createElement('p');
    readingsLine.textContent = `${wq.readings.join(', ')} — ${wq.date}`;
    box.append(heading, statusLine, readingsLine);
    el.append(box);
  }

  // Below its own divider, same as popup()'s CONTEXT_ROWS — static background
  // on the spot, not a live fact.
  if (spot.description) {
    const d = document.createElement('p');
    d.className = 'pop-note';
    d.textContent = spot.description;
    el.append(d);
  }

  // No "+ More" here, unlike popup() — a swim spot has no CONTEXT_ROWS-style
  // data to hide behind one, so an expand/collapse toggle would exist purely
  // to reveal Share (see buildShareButton) and nothing else, which is just
  // an extra click for no reason. Straight in .pop-foot instead, always
  // visible.
  const foot = document.createElement('div');
  foot.className = 'pop-foot';
  foot.append(buildShareButton());
  if (spot.dashboard_url) {
    const a = document.createElement('a');
    a.href = spot.dashboard_url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'pop-action';
    a.innerHTML = '<span>Water quality history ↗</span>';
    foot.append(a);
  }
  el.append(foot);

  return el;
}

/**
 * Fetch `basemap.json` and draw the map into `host`. `opts.initialZoom` is the
 * fraction of the full 10 km box to open on (1 = whole box, 0.36 ≈ two clicks in).
 * `opts.onSeeInTimeline(monitor)` is called when a popup's "View Timeline"
 * link is clicked — the reverse of a card's own "View on map".
 */
export function buildMap(host, data, opts = {}) {
  const { initialZoom = 1, onSeeInTimeline = () => {} } = opts;
  let api = null;
  const pending = [];   // focus() calls made before the basemap finished loading

  fetch(`basemap.json?${Date.now()}`)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((bm) => {
      api = drawMap(host, bm, data.monitors, data.swim_spots, data.polled_at, initialZoom,
        data.window_days, onSeeInTimeline);
      for (const m of pending) api.focus(m);
      pending.length = 0;
    })
    .catch(() => {
      host.classList.add('is-broken');
      host.textContent = 'The map backdrop failed to load.';
    });

  // Fly the camera to one monitor or swim spot's pin and open its popup — a
  // card's "View on map" and index.html's own hash routing both call this.
  return {
    focus(item) { api ? api.focus(item) : pending.push(item); },
    closePopup() { api?.closePopup(); },
  };
}

function drawMap(host, bm, monitors, swimSpots, now, initialZoom, windowDays, onSeeInTimeline) {
  const [BW, BS, BE, BN] = bm.box;
  const [GW, GH] = bm.size;

  // Web Mercator → basemap grid units. Must match scripts/build-basemap.js.
  const worldY = (lat) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const wx0 = (BW + 180) / 360;
  const wy0 = worldY(BN);
  const gscale = GW / ((BE + 180) / 360 - wx0);
  const projX = (lon) => ((lon + 180) / 360 - wx0) * gscale;
  const projY = (lat) => (worldY(lat) - wy0) * gscale;

  // The crop rectangle in grid units — the camera never leaves this. `bm.centre`
  // is the town; CROP_KM the offsets. (north edge = smaller y).
  const [cLon, cLat] = bm.centre ?? [(BW + BE) / 2, (BS + BN) / 2];
  const kmLat = 1 / 111.132;
  const kmLon = 1 / (111.132 * Math.cos((cLat * Math.PI) / 180));
  const CX0 = projX(cLon - CROP_KM.w * kmLon);
  const CX1 = projX(cLon + CROP_KM.e * kmLon);
  const CY0 = projY(cLat + CROP_KM.n * kmLat);
  const CY1 = projY(cLat - CROP_KM.s * kmLat);
  const CW = CX1 - CX0;
  const CH = CY1 - CY0;
  const townX = projX(cLon);
  const townY = projY(cLat);

  // --- SVG backdrop ---
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');

  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('class', 'map-bg');
  bg.setAttribute('width', GW);
  bg.setAttribute('height', GH);
  svg.append(bg);

  for (const name of DRAW_ORDER) {
    const lines = bm.layers[name] ?? [];
    if (!lines.length) continue;
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', `bm bm--${name}`);
    for (const flat of lines) {
      let d = `M${flat[0]} ${flat[1]}`;
      for (let i = 2; i < flat.length; i += 2) d += `L${flat[i]} ${flat[i + 1]}`;
      if (name === 'water') d += 'Z';
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      g.append(p);
    }
    svg.append(g);
  }
  const frame = document.createElementNS(SVGNS, 'rect');
  frame.setAttribute('class', 'map-frame');
  frame.setAttribute('width', GW);
  frame.setAttribute('height', GH);
  svg.append(frame);
  host.append(svg);

  // --- overlays ---
  const labelLayer = document.createElement('div');
  labelLayer.className = 'label-layer';
  host.append(labelLayer);

  const pinLayer = document.createElement('div');
  pinLayer.className = 'pin-layer';
  host.append(pinLayer);

  const ctrl = document.createElement('div');
  ctrl.className = 'map-ctrl';
  const zin = Object.assign(document.createElement('button'), { type: 'button', textContent: '+' });
  const zout = Object.assign(document.createElement('button'), { type: 'button', textContent: '−' });
  const zreset = Object.assign(document.createElement('button'), { type: 'button', innerHTML: RESET });
  zin.setAttribute('aria-label', 'Zoom in');
  zout.setAttribute('aria-label', 'Zoom out');
  zreset.className = 'map-reset';
  zreset.setAttribute('aria-label', 'Reset map view');
  ctrl.append(zreset, zin, zout);
  host.append(ctrl);

  const attr = document.createElement('div');
  attr.className = 'map-attr';
  attr.innerHTML =
    'Streets © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> ' +
    '· Waterways © OS &amp; EA';
  host.append(attr);

  const pop = document.createElement('div');
  pop.className = 'map-popup';
  pop.hidden = true;
  host.append(pop);

  // --- camera (viewBox) ---
  let vx, vy, vw, vh, VW_OUT, VW_IN;

  const size = () => {
    const r = host.getBoundingClientRect();
    return [r.width || 1, r.height || 1];
  };

  function clamp(a) {
    vw = Math.min(Math.max(vw, VW_IN), VW_OUT);
    vh = vw / a;
    vx = vw >= CW ? CX0 + (CW - vw) / 2 : Math.min(Math.max(vx, CX0), CX0 + CW - vw);
    vy = vh >= CH ? CY0 + (CH - vh) / 2 : Math.min(Math.max(vy, CY0), CY0 + CH - vh);
  }

  // True once the camera is back at the view the map opened on (same town
  // centring and initialZoom fraction recalc()/resetView() use) — drives
  // .map-reset's is-inactive class below. EPS is grid units (~1/m), well
  // under float drift but comfortably past it, since flyTo's last animation
  // frame lands on the exact target rather than something merely close.
  function atOpeningView() {
    const [pw, ph] = size();
    const vw2 = VW_OUT * initialZoom;
    const vh2 = vw2 / (pw / ph);
    const EPS = 0.01;
    return Math.abs(vw - vw2) < EPS
      && Math.abs(vx - (townX - vw2 / 2)) < EPS
      && Math.abs(vy - (townY - vh2 / 2)) < EPS;
  }

  function apply() {
    svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
    placeLabels();
    placePins();
    placePopup();
    const atRest = atOpeningView();
    zreset.classList.toggle('is-inactive', atRest);
    zreset.disabled = atRest;
  }

  function recalc() {
    const [pw, ph] = size();
    const a = pw / ph;
    // Most zoomed out: the crop *covers* the viewport, so its edge is never
    // crossed. min() picks the axis that runs out of crop first — the other axis
    // then pans within it.
    VW_OUT = Math.min(CW, CH * a) * MAX_ZOOM_OUT;
    VW_IN = VW_OUT / MAX_ZOOM_IN;
    if (vw === undefined) {
      vw = VW_OUT * initialZoom;         // open on this fraction, centred on town
      vh = vw / a;
      vx = townX - vw / 2;
      vy = townY - vh / 2;
    }
    clamp(a);
    apply();
  }

  function zoomAt(factor, fx, fy) {
    const [pw, ph] = size();
    const a = pw / ph;
    const gx = vx + fx * vw;
    const gy = vy + fy * vh;
    vw = Math.min(Math.max(vw * factor, VW_IN), VW_OUT);
    vh = vw / a;                       // recompute before anchoring, or the zoom drifts
    vx = gx - fx * vw;
    vy = gy - fy * vh;
    clamp(a);
    apply();
  }

  // --- pins ---
  const pins = monitors
    .filter((m) => m.lat != null && m.lon != null)
    .map((m) => {
      const st = mapStatusOf(m, now);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `mappin mappin--${st.key}`;
      el.setAttribute('aria-label', `${m.label} — ${st.text}`);
      el.addEventListener('click', (e) => { e.stopPropagation(); openPopup(m); });
      pinLayer.append(el);
      return { m, el, gx: projX(m.lon), gy: projY(m.lat) };
    });

  // Points of interest, not overflow monitors — same layer, own shape/colour
  // (.swimpin) so they don't read as another traffic-light state.
  const swimPins = (swimSpots ?? [])
    .filter((s) => s.lat != null && s.lon != null)
    .map((s) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'mappin swimpin';
      el.setAttribute('aria-label', `${s.name} — swimming spot`);
      el.addEventListener('click', (e) => { e.stopPropagation(); openSwimPopup(s); });
      pinLayer.append(el);
      return { s, el, gx: projX(s.lon), gy: projY(s.lat) };
    });

  // Position within the crop first (so anything beyond it sticks to the edge),
  // then within the viewport (so one panned off-screen sticks too).
  function screenXY(gx, gy) {
    const inBox = gx >= CX0 && gx <= CX1 && gy >= CY0 && gy <= CY1;
    let sx = (Math.min(Math.max(gx, CX0), CX1) - vx) / vw;
    let sy = (Math.min(Math.max(gy, CY0), CY1) - vy) / vh;
    const inView = sx >= 0 && sx <= 1 && sy >= 0 && sy <= 1;
    sx = Math.min(Math.max(sx, 0.012), 0.988);
    sy = Math.min(Math.max(sy, 0.014), 0.986);
    return { sx, sy, edge: !inBox || !inView };
  }

  function placePins() {
    for (const p of [...pins, ...swimPins]) {
      const { sx, sy, edge } = screenXY(p.gx, p.gy);
      if (edge && !SHOW_EDGE_MARKERS) { p.el.classList.remove('is-shown'); continue; }
      p.el.classList.add('is-shown');
      p.el.classList.toggle('is-edge', edge);
      p.el.style.left = `${sx * 100}%`;
      p.el.style.top = `${sy * 100}%`;
    }
  }

  // --- labels (place + road names) ---
  // List order is the declutter cull's priority: town, village, then road ahead
  // of suburb/hamlet (a street name locates an outfall better than a district).
  // build-basemap.js already sorts places and roads sensibly within each kind;
  // the sort here is stable so that order survives.
  const RANK = { town: 0, village: 1, road: 2, waterway: 3, suburb: 4, hamlet: 5 };
  const labels = [
    ...(bm.labels?.places ?? []).map((l) => ({ ...l, kind: l.kind ?? 'suburb' })),
    ...(bm.labels?.roads ?? []).map((l) => ({ ...l, kind: 'road' })),
    ...(SHOW_WATERWAY_LABELS ? (bm.labels?.waterways ?? []).map((l) => ({ ...l, kind: 'waterway' })) : []),
  ].sort((x, y) => RANK[x.kind] - RANK[y.kind]).map((l) => {
    const el = document.createElement('span');
    el.className = `map-label map-label--${l.kind}`;
    el.textContent = l.text;
    labelLayer.append(el);
    return { ...l, el };
  });

  function placeLabels() {
    const [pw, ph] = size();
    const frac = vw / VW_OUT;
    const placed = [];   // screen boxes already taken, so labels don't collide
    for (const l of labels) {
      const { sx, sy, edge } = screenXY(l.x, l.y);
      const px = sx * pw;
      const py = sy * ph;
      const hw = l.text.length * 3.4 + 5;
      const hh = 9;
      const clash = placed.some((b) =>
        Math.abs(b.px - px) < b.hw + hw && Math.abs(b.py - py) < b.hh + hh);
      if (edge || frac > LABEL_ZOOM[l.kind] || clash) {
        l.el.classList.remove('is-shown');
        continue;
      }
      placed.push({ px, py, hw, hh });
      l.el.style.left = `${sx * 100}%`;
      l.el.style.top = `${sy * 100}%`;
      l.el.classList.add('is-shown');
    }
  }

  // --- popup ---
  // `openItem` is whichever monitor or swim spot the popup currently belongs
  // to — both carry {lon, lat}, so placePopup() doesn't need to know which
  // kind it's looking at, only showPopup()'s pin-ringing does.
  let openItem = null;
  let popW = 0, popH = 0;   // measured once per open; content is fixed thereafter

  function showPopup(content, item, pinEl) {
    openItem = item;
    pop.replaceChildren();
    const close = Object.assign(document.createElement('button'),
      { type: 'button', className: 'pop-close', textContent: '×' });
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', (e) => { e.stopPropagation(); closePopup(); });
    pop.append(close, content);
    pop.hidden = false;
    const r = pop.getBoundingClientRect();
    popW = r.width;
    popH = r.height;
    placePopup();
    // Ring the pin its popup belongs to, so it stays visually tied to it
    // rather than just wherever the popup happens to be pointing.
    for (const p of [...pins, ...swimPins]) p.el.classList.toggle('is-selected', p.el === pinEl);

    // popup()'s own "+ More" toggle (CONTEXT_ROWS + Share — swimPopup() has
    // no equivalent, Share sits straight in its .pop-foot instead) changes
    // the popup's own height after the fact — popW/popH were measured before
    // that, and `pop` sits inside `host`'s own overflow:hidden, so a stale
    // position could clip the expanded content rather than just look
    // slightly off. Re-measure and reposition whenever it opens or closes. A
    // plain button + click, not a native <details>'s `toggle` event — see
    // popup()'s own comment on why. Registered after popup()'s own click
    // listener on the same element (which is what actually flips
    // .pop-more's `hidden`), so the geometry this reads is always the
    // post-toggle one.
    const moreToggle = pop.querySelector('.pop-more-toggle');
    if (moreToggle) {
      moreToggle.addEventListener('click', () => {
        const r2 = pop.getBoundingClientRect();
        popW = r2.width;
        popH = r2.height;
        placePopup();
      });
    }
  }
  // A monitor or swim spot's own Id as the URL hash while its popup is open —
  // the write side of index.html's own read (`#WXW00308` or
  // `#farleigh-hungerford` on load flies to and opens that pin). Both id
  // spaces are hand-curated and disjoint (`WXW…` from Wessex, plain slugs
  // from SWIM_SPOTS in scripts/fetch-swim-spots.js), so there's no risk of
  // one shadowing the other. `replaceState`, not a `location.hash`
  // assignment, so this never pushes a back-button entry — same convention
  // index.html's own selectTab/closePanel already use for the tab hash.
  function openPopup(m) {
    showPopup(popup(m, now, windowDays, onSeeInTimeline), m, pins.find((p) => p.m.id === m.id)?.el);
    history.replaceState(null, '', `#${m.id}`);
  }
  function openSwimPopup(s) {
    showPopup(swimPopup(s), s, swimPins.find((p) => p.s.id === s.id)?.el);
    history.replaceState(null, '', `#${s.id}`);
  }
  function closePopup() {
    openItem = null;
    pop.hidden = true;
    for (const p of [...pins, ...swimPins]) p.el.classList.remove('is-selected');
    history.replaceState(null, '', location.pathname + location.search);
  }

  // Sit the popup above the pin, centred; flip below if it would clip the top,
  // then clamp so it never leaves the map — so an edge pin still gets a readable
  // popup.
  function placePopup() {
    if (!openItem) return;
    const { sx, sy, edge } = screenXY(projX(openItem.lon), projY(openItem.lat));
    if (edge && !SHOW_EDGE_MARKERS) { pop.hidden = true; return; }
    pop.hidden = false;

    const [pw, ph] = size();
    const px = sx * pw;
    const py = sy * ph;
    const M = 8;      // keep this far from the map edge
    const GAP = 14;   // gap between pin and popup
    const PIN = 10;   // pin half-height

    let left = px - popW / 2;
    let top = py - GAP - popH;
    if (top < M) top = py + GAP + PIN;                    // no room above → below

    left = Math.min(Math.max(left, M), Math.max(M, pw - popW - M));
    top = Math.min(Math.max(top, M), Math.max(M, ph - popH - M));

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  // --- interaction: drag to pan, wheel / ± to zoom, two fingers to pinch ---
  const pointers = new Map();   // pointerId → { x, y }
  let pan = null;               // { x, y, vx, vy }
  let pinch = null;             // { dist, cx, cy, vx, vy, vw, vh }

  const twoFinger = () => {
    const [a, b] = [...pointers.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  };

  host.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mappin, .map-ctrl, .map-popup')) return;
    host.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      closePopup();
      pan = { x: e.clientX, y: e.clientY, vx, vy };
      host.classList.add('is-panning');
    } else if (pointers.size === 2) {
      pan = null;
      pinch = { ...twoFinger(), vx, vy, vw, vh };
    }
  });

  host.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [pw, ph] = size();
    const a = pw / ph;
    const r = host.getBoundingClientRect();

    if (pinch && pointers.size >= 2) {
      const tf = twoFinger();
      const gx = pinch.vx + ((pinch.cx - r.left) / pw) * pinch.vw;
      const gy = pinch.vy + ((pinch.cy - r.top) / ph) * pinch.vh;
      vw = Math.min(Math.max(pinch.vw * (pinch.dist / tf.dist), VW_IN), VW_OUT);
      vh = vw / a;
      vx = gx - ((tf.cx - r.left) / pw) * vw;
      vy = gy - ((tf.cy - r.top) / ph) * vh;
      clamp(a);
      apply();
    } else if (pan) {
      vx = pan.vx - (e.clientX - pan.x) * (vw / pw);
      vy = pan.vy - (e.clientY - pan.y) * (vh / ph);
      clamp(a);
      apply();
    }
  });

  function releasePointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      const [p] = pointers.values();
      pan = { x: p.x, y: p.y, vx, vy };
    } else if (pointers.size === 0) {
      pan = null;
      host.classList.remove('is-panning');
    }
  }
  host.addEventListener('pointerup', releasePointer);
  host.addEventListener('pointercancel', releasePointer);

  host.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = host.getBoundingClientRect();
    zoomAt(Math.exp(e.deltaY * 0.0015), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });

  zin.addEventListener('click', () => zoomAt(0.6, 0.5, 0.5));
  zout.addEventListener('click', () => zoomAt(1 / 0.6, 0.5, 0.5));
  zreset.addEventListener('click', () => resetView());

  // --- fly the camera to a target viewBox, easing from wherever it is now.
  // Shared by focus() (onto a pin) and resetView() (back to the opening
  // view) so there's one easing curve/duration for both.
  let flyRAF = 0;
  function flyTo(targetVW, targetVX, targetVY, onDone) {
    const [pw, ph] = size();
    const a = pw / ph;
    const start = { vx, vy, vw };

    vw = targetVW;
    vh = vw / a;
    vx = targetVX;
    vy = targetVY;
    clamp(a);
    const end = { vx, vy, vw };

    cancelAnimationFrame(flyRAF);
    const t0 = performance.now();
    const D = 420;
    const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
    (function step(t) {
      const k = Math.min(1, (t - t0) / D);
      const e = ease(k);
      vw = start.vw + (end.vw - start.vw) * e;
      vh = vw / a;
      vx = start.vx + (end.vx - start.vx) * e;
      vy = start.vy + (end.vy - start.vy) * e;
      clamp(a);
      apply();
      if (k < 1) flyRAF = requestAnimationFrame(step);
      else onDone?.();
    })(t0);
  }

  // Focus one monitor or swim spot: ease the camera onto its pin, then open
  // the popup — `item` only needs an `.id`; which array it's found in decides
  // which popup opens, so a card's "View on map" and index.html's own hash
  // routing can pass either a monitor or a swim spot interchangeably.
  function focus(item) {
    const p = pins.find((x) => x.m.id === item.id) ?? swimPins.find((x) => x.s.id === item.id);
    if (!p) return;                       // unknown id, or an item with no coords
    const [pw, ph] = size();
    const vw2 = Math.max(VW_IN, VW_OUT * 0.14);  // lean in on the pin
    const vh2 = vw2 / (pw / ph);
    flyTo(vw2, p.gx - vw2 / 2, p.gy - vh2 / 2, () => {
      if (p.m) openPopup(p.m); else openSwimPopup(p.s);
    });
  }

  // Reset button (map-ctrl): back to the view the map opened on — same town
  // centring and initialZoom fraction recalc() used on first load, just
  // eased there instead of cut straight to it.
  function resetView() {
    const [pw, ph] = size();
    const vw2 = VW_OUT * initialZoom;
    const vh2 = vw2 / (pw / ph);
    flyTo(vw2, townX - vw2 / 2, townY - vh2 / 2);
  }

  new ResizeObserver(recalc).observe(host);
  recalc();

  return { focus, closePopup };
}
