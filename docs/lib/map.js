/**
 * The no-library map: draws `basemap.json` (roads + waterways) as one SVG whose
 * viewBox is the camera, with an HTML overlay of pins, labels and popups on top.
 * Pan/zoom/pinch are clamped to the 10 km box the basemap covers.
 *
 * Extracted from the original single-file page so both it and the archive can
 * share one implementation. The archive keeps its own inline copy, frozen.
 *
 *   buildMap(hostEl, data, { initialZoom: 0.36 });
 *   renderLegend(ulEl);
 *
 * The Web Mercator projection in `drawMap` MUST match `scripts/build-basemap.js`.
 */

import {
  RECENT_HOURS, fmtDuration, fmtWhen, mapStatusOf, mapsUrl, spillMs,
} from './format.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const DRAW_ORDER = ['water', 'stream', 'river', 'minor', 'mid', 'major'];
const MAX_ZOOM_IN = 16;    // smallest viewBox = zoomed-out width / this
// How far out you can pull back. At 1 the 10 km box exactly covers the viewport
// (never a gap past its edges — on a wide screen you see the full width and pan
// up/down, on a tall screen the full height and pan left/right). Below 1 the
// stop comes sooner; keep it >= the page's initialZoom.
const MAX_ZOOM_OUT = 1;

// A monitor outside the 10 km square (or panned off-screen) can either be
// pinned to the edge as a marker, or simply hidden. Flip to true to bring the
// edge markers back — the positioning logic in screenXY still computes them.
const SHOW_EDGE_MARKERS = false;

// A label shows only once the view is at or below this fraction of the full-box
// width (1 = whole box, smaller = zoomed in). Suburbs from the start, road names
// once you lean in.
const LABEL_ZOOM = { place: 1.1, road: 0.52 };

export const LEGEND = [
  ['discharging', 'Discharging now'],
  ['recent', `Discharged in the last ${RECENT_HOURS}h`],
  ['dry', 'Not discharging'],
  ['offline', 'No data / offline'],
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

  const h = document.createElement('h3');
  h.textContent = monitor.label;

  const s = document.createElement('p');
  s.className = `pop-state is-${state.key}`;
  s.textContent = state.text;
  s.style.margin = '0 0 6px';

  const w = document.createElement('p');
  w.style.margin = '0 0 6px';
  w.textContent = `Into the ${monitor.watercourse}. ` + (last
    ? `Last discharge ${fmtWhen(last.start, now)}, ${fmtDuration(spillMs(last, now))}.`
    : 'No discharge recorded in the last 90 days.');

  el.append(h, s, w);

  if (monitor.lat != null && monitor.lon != null) {
    const lat = monitor.lat.toFixed(5);
    const lon = monitor.lon.toFixed(5);
    const a = document.createElement('a');
    a.href = mapsUrl(lat, lon);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `${lat}, ${lon} ↗`;
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

  fetch(`basemap.json?${Date.now()}`)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((bm) => drawMap(host, bm, data.monitors, data.polled_at, initialZoom))
    .catch(() => {
      host.classList.add('is-broken');
      host.textContent = 'The map backdrop failed to load.';
    });
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
    vx = vw >= GW ? (GW - vw) / 2 : Math.min(Math.max(vx, 0), GW - vw);
    vy = vh >= GH ? (GH - vh) / 2 : Math.min(Math.max(vy, 0), GH - vh);
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
    // Most zoomed out: the box *covers* the viewport, so its edge is never
    // crossed. min() picks the axis that runs out of box first — the other axis
    // then pans within the square.
    VW_OUT = Math.min(GW, GH * a) * MAX_ZOOM_OUT;
    VW_IN = VW_OUT / MAX_ZOOM_IN;
    if (vw === undefined) {
      vw = VW_OUT * initialZoom;         // open on this fraction of the 10 km box
      vh = vw / a;
      vx = (GW - vw) / 2;                // …centred, i.e. on Frome
      vy = (GH - vh) / 2;
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

  // Position within the box first (so a monitor beyond the 10 km box sticks to
  // its edge), then within the viewport (so one panned off-screen sticks too).
  function screenXY(gx, gy) {
    const inBox = gx >= 0 && gx <= GW && gy >= 0 && gy <= GH;
    let sx = (Math.min(Math.max(gx, 0), GW) - vx) / vw;
    let sy = (Math.min(Math.max(gy, 0), GH) - vy) / vh;
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

  // --- labels (suburb + road names) ---
  const labels = [
    ...(bm.labels?.places ?? []).map((l) => ({ ...l, kind: 'place' })),
    ...(bm.labels?.roads ?? []).map((l) => ({ ...l, kind: 'road' })),
  ].map((l) => {
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

  function openPopup(m) {
    openM = m;
    pop.replaceChildren();
    const close = Object.assign(document.createElement('button'),
      { type: 'button', className: 'pop-close', textContent: '×' });
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', (e) => { e.stopPropagation(); closePopup(); });
    pop.append(close, popup(m, now));
    placePopup();
  }
  function closePopup() { openM = null; pop.hidden = true; }
  function placePopup() {
    if (!openM) return;
    const { sx, sy, edge } = screenXY(projX(openM.lon), projY(openM.lat));
    if (edge && !SHOW_EDGE_MARKERS) { pop.hidden = true; return; }
    pop.hidden = false;
    pop.style.left = `${sx * 100}%`;
    pop.style.top = `${sy * 100}%`;
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

  new ResizeObserver(recalc).observe(host);
  recalc();
}
