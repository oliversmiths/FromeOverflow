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
  RECENT_HOURS, fmtDuration, fmtWhen, mapStatusOf, mapsUrl, spillMs,
} from './format.js';

const SVGNS = 'http://www.w3.org/2000/svg';

// Map-pin glyph for the popup's coordinate link — inherits colour and size.
const PIN =
  '<svg class="pin" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 2a7.5 7.5 0 0 0-7.5 7.5c0 5.2 6.3 11.7 6.6 12a1.2 1.2 0 0 0 1.8 0' +
  'c.3-.3 6.6-6.8 6.6-12A7.5 7.5 0 0 0 12 2Zm0 10.2a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4Z"/></svg>';
const DRAW_ORDER = ['water', 'stream', 'river', 'minor', 'mid', 'major'];
const MAX_ZOOM_IN = 40;    // smallest viewBox = zoomed-out width / this
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
const LABEL_ZOOM = { town: 1.1, village: 1.1, road: 0.55, suburb: 0.5, hamlet: 0.22 };

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
];

export function renderLegend(ul) {
  for (const [key, text] of LEGEND) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `mappin mappin--${key}`;
    li.append(dot, document.createTextNode(text));
    ul.append(li);
  }
}

function popup(monitor, now) {
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

  const s = document.createElement('p');
  s.className = `pop-state is-${state.key}`;
  s.textContent = state.text;
  s.style.margin = '0 0 6px';

  const d = document.createElement('p');
  d.className = 'pop-last';
  d.textContent = last
    ? `Last discharge ${fmtWhen(last.start, now)}, ${fmtDuration(spillMs(last, now))}.`
    : 'No discharge recorded in the last 90 days.';

  el.append(s, h, d);

  if (monitor.lat != null && monitor.lon != null) {
    const lat = monitor.lat.toFixed(5);
    const lon = monitor.lon.toFixed(5);
    const a = document.createElement('a');
    a.href = mapsUrl(lat, lon);
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = `${PIN}<span>${lat}, ${lon} ↗</span>`;
    el.append(a);
  }
  return el;
}

/**
 * Fetch `basemap.json` and draw the map into `host`. `opts.initialZoom` is the
 * fraction of the full 10 km box to open on (1 = whole box, 0.36 ≈ two clicks in).
 */
export function buildMap(host, data, opts = {}) {
  const { initialZoom = 1 } = opts;
  let api = null;
  const pending = [];   // focus() calls made before the basemap finished loading

  fetch(`basemap.json?${Date.now()}`)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((bm) => {
      api = drawMap(host, bm, data.monitors, data.polled_at, initialZoom);
      for (const m of pending) api.focus(m);
      pending.length = 0;
    })
    .catch(() => {
      host.classList.add('is-broken');
      host.textContent = 'The map backdrop failed to load.';
    });

  // Fly the camera to one monitor's pin and open its popup — the panel's
  // "See on map" links call this.
  return {
    focus(monitor) { api ? api.focus(monitor) : pending.push(monitor); },
  };
}

function drawMap(host, bm, monitors, now, initialZoom) {
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
  zin.setAttribute('aria-label', 'Zoom in');
  zout.setAttribute('aria-label', 'Zoom out');
  ctrl.append(zin, zout);
  host.append(ctrl);

  const attr = document.createElement('div');
  attr.className = 'map-attr';
  attr.innerHTML =
    'Streets © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
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

  function apply() {
    svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
    placeLabels();
    placePins();
    placePopup();
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
    for (const p of pins) {
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
  const RANK = { town: 0, village: 1, road: 2, suburb: 3, hamlet: 4 };
  const labels = [
    ...(bm.labels?.places ?? []).map((l) => ({ ...l, kind: l.kind ?? 'suburb' })),
    ...(bm.labels?.roads ?? []).map((l) => ({ ...l, kind: 'road' })),
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
  let openM = null;
  let popW = 0, popH = 0;   // measured once per open; content is fixed thereafter

  function openPopup(m) {
    openM = m;
    pop.replaceChildren();
    const close = Object.assign(document.createElement('button'),
      { type: 'button', className: 'pop-close', textContent: '×' });
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', (e) => { e.stopPropagation(); closePopup(); });
    pop.append(close, popup(m, now));
    pop.hidden = false;
    const r = pop.getBoundingClientRect();
    popW = r.width;
    popH = r.height;
    placePopup();
  }
  function closePopup() { openM = null; pop.hidden = true; }

  // Sit the popup above the pin, centred; flip below if it would clip the top,
  // then clamp so it never leaves the map — so an edge pin still gets a readable
  // popup.
  function placePopup() {
    if (!openM) return;
    const { sx, sy, edge } = screenXY(projX(openM.lon), projY(openM.lat));
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

  // --- focus one monitor: ease the camera onto its pin, then open the popup ---
  let flyRAF = 0;
  function focus(monitor) {
    const p = pins.find((x) => x.m.id === monitor.id);
    if (!p) return;                       // unknown id, or a monitor with no coords
    const [pw, ph] = size();
    const a = pw / ph;
    const start = { vx, vy, vw };

    vw = Math.max(VW_IN, VW_OUT * 0.14);  // lean in on the pin
    vh = vw / a;
    vx = p.gx - vw / 2;
    vy = p.gy - vh / 2;
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
      else openPopup(p.m);
    })(t0);
  }

  new ResizeObserver(recalc).observe(host);
  recalc();

  return { focus };
}
