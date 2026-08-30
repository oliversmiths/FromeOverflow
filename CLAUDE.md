# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-town storm-overflow monitor for Frome, Somerset. It polls Wessex Water's
near real-time event duration monitor (EDM) feed — an ArcGIS FeatureServer that
publishes *current status only, no history* — and keeps its own history in SQLite,
then exports JSON for a static page. See [README.md](README.md) and
[SETUP.md](SETUP.md) for the user-facing story and deployment steps.

## Runtime

- **Node 23.4+ required** (24 in CI). `node:sqlite` (`DatabaseSync`) and global
  `fetch` are both used unguarded. On Node 22 it needs `node --experimental-sqlite`.
- **Zero dependencies, no `node_modules`, no lockfile.** Keep it that way — the
  point is that the poller runs anywhere with a modern Node and nothing installed.
- SQLite prints an experimental-feature warning on startup; `--no-warnings` silences it.

## Commands

- `npm run poll` → `node poll.js` — fetch one reading, update DB, rewrite `docs/data.json`
- `npm run serve` — `serve.js`, a zero-dep static server for `docs/` on
  `http://localhost:8000` (`PORT=8001` to override)
- `npm run dev` — one poll, then serve
- `npm run basemap` → `node scripts/build-basemap.js` — rebuild `docs/basemap.json`
  (the map view's streets) from the OSM Overpass API. Run rarely, by hand.

There is no test suite or linter. `build-basemap.js` is the only build step and its
output is committed. The page must be served over http — browsers block module
imports and `fetch` on `file://`.

Inspect the collected data with the system `sqlite3`:

```bash
sqlite3 overflows.db "SELECT id, watercourse, label FROM monitors ORDER BY id;"
```

## Architecture

```
Wessex ArcGIS feed ──▶ poll.js ──▶ overflows.db (node:sqlite)
                          │
                          └───────▶ docs/data.json ──▶ docs/index.html (static)
```

- **[poll.js](poll.js)** — the whole backend. Pages the entire Wessex feed
  (`fetchAll`, 2000/request), filters to the Frome catchment (`isLocal`), upserts
  into SQLite (`store`), then writes the last 90 days as JSON (`exportJson`).
- **`docs/lib/format.js`** — shared duration maths and formatting (`spillMs`,
  `fmtDuration`, `rankByTotal`, `statusOf`, `mapStatusOf`, `DAY`, `RECENT_HOURS`,
  …). **Imported by both `poll.js` and `docs/index.html`** so a spill is measured
  identically in the console and on screen. This is the single source of truth for
  how a discharge is counted — change it here, nowhere else. `statusOf` is the
  3-state code (discharging / offline / dry); `mapStatusOf` adds the "recent" step
  (a spill that ended within `RECENT_HOURS`, default 48) for the map's traffic
  light.
- **`docs/index.html`** — static page, no framework. `fetch`es `data.json` once
  and offers two tab views (state in the URL hash, `#timeline` / `#map`):
  - **Timeline** — the "barcode" (one row per monitor, 90-day timeline) and
    "Right now" status cards. Each card links its coordinates to Google Maps.
  - **Map** — **no library, no tile service.** `buildMap` (lazy, on first switch
    to the tab) fetches `basemap.json` and draws roads/waterways as one SVG whose
    `viewBox` is the camera; pins are an HTML overlay repositioned each frame.
    Pan (drag), wheel/`±` zoom and two-finger pinch are clamped to a 10 km square
    on Frome and a min/max zoom, so nothing outside the square is ever needed.
    Pins are coloured by `mapStatusOf` (`.mappin--*`: red / amber / bright green /
    grey); `mapStatusOf` also drives the legend. A monitor outside the square (or
    panned off-screen) is hidden; flip `SHOW_EDGE_MARKERS` to instead stick it to
    the edge as a square (`screenXY` still computes the clamped position — box
    first, then viewport). Popups are the same `popup()` DOM used nowhere else.
    Web Mercator projection in `drawMap` **must match `scripts/build-basemap.js`**.
    The map div is `#overflow-map`, deliberately *not* `id="map"`, so the `#map`
    hash doesn't scroll the browser past the masthead.
    Labels (`bm.labels`) are an HTML overlay too: `place=suburb` names always,
    named `major`/`mid` road names once zoomed past `LABEL_ZOOM.road`. A cheap
    per-frame greedy box-overlap cull thins them (list order = priority: suburbs,
    then roads longest-first).
- **[scripts/build-basemap.js](scripts/build-basemap.js)** — one-off, zero-dep.
  Overpass query for a `BOX_KM` (10) square on `CENTRE` (keep in step with
  `poll.js`), projects to a `GRID`-unit integer grid, Douglas–Peucker simplifies,
  writes `docs/basemap.json` (`box`, `size`, `layers`, `labels`). Roads with a
  `name` in the `major`/`mid` classes and > `MIN_ROAD_LEN` become road labels
  (top 40 by length); `place=suburb` nodes become place labels. The page trusts
  `basemap.json`'s own `box`/`size`, so a rebuild with different bounds just works.
- **[.github/workflows/poll.yml](.github/workflows/poll.yml)** — GitHub Action:
  polls every 15 min, commits `overflows.db` + `docs/data.json` back to the
  branch, optionally rsyncs `docs/` to SiteGround (gated on the
  `DEPLOY_TO_SITEGROUND` repo variable). **The repo is the database**; GitHub
  Pages / SiteGround just serves `docs/`.

### Layout

```
poll.js                 fetch + store + export    (root)
serve.js                zero-dep static server for docs/
scripts/build-basemap.js one-off: OSM streets → docs/basemap.json
docs/index.html         the page — Timeline + Map tab views
docs/lib/format.js      shared maths, imported by poll.js and index.html
docs/data.json          generated by poll.js (git-committed; absent in a fresh
                        checkout until the first poll)
docs/basemap.json       generated by build-basemap.js (git-committed)
overflows.db            node:sqlite file (git-committed)
```

## Data model & domain rules

Three tables (schema in [poll.js](poll.js) `SCHEMA`):

- **`monitors`** — one row per outfall. `label` is **human-owned; the poller never
  writes it** (`UPDATE monitors SET label=... WHERE id=...`). Everything else is refreshed each poll.
- **`events`** — keyed on `(monitor_id, start_ms)`. Wessex give us only the latest
  event's start/end, so: a start we've seen before just fills in `end_ms`
  (`COALESCE`, never overwritten); an unseen start is a new spill.
- **`snapshots`** — every raw reading, kept so the event history can be rebuilt
  with better logic later without data loss.

Rules baked into `store` / `exportJson`:

- **Status codes:** `1` = discharging, `-1` = offline/no signal, anything else = dry.
- While `Status === 1` the event's `end_ms` is left `NULL` — the end Wessex report
  during an active spill belongs to the *previous* event.
- ArcGIS returns `undefined` for absent fields; `node:sqlite` rejects `undefined`,
  so everything crossing into a query goes through `val()`.
- **Known undercount:** if a monitor spills twice between two polls, only the
  second is recorded. Totals are a floor. Rare at a 15-min interval against a
  15-min feed; `snapshots` is the recovery path.
- **`exportJson` only publishes monitors seen in the last 7 days** (`last_seen`).
  One that stops matching the filter ages off the page but keeps its history in
  the DB.

## Which overflows are kept (`isLocal` in [poll.js](poll.js))

The whole region-wide feed is fetched every poll, then filtered — nothing is
hardcoded, so new Wessex monitors appear on their own. A row is kept if:

1. `PIN_TO_IDS` is non-empty and lists its `Id` — geography is then ignored
   entirely (the intended end state once the right IDs are known); **else**
2. it is within `RADIUS_KM` (8 km) of `CENTRE` (Frome centre); **else**
3. it is within `CATCHMENT_KM` (25 km) **and** its `ReceivingWaterCourse` contains
   one of `WATERCOURSES` (`frome`, `mells`, `rodden`).

Rule 3's outer bound matters: Wessex also supply Dorset, which has its own River
Frome running to Poole Harbour — an unbounded name match drags those in 60 km
away. Rows with no coordinates are dropped. `EXPORT_DAYS` (90) sets the JSON/page
window.

## Caveats to preserve

An EDM records *when* an overflow starts/stops — not volume, not water quality, and
an activation *indicates* rather than *confirms* a discharge (debris can trigger
one). These figures will not match Wessex's regulator-verified annual returns.
Keep this framing in any user-facing copy.
