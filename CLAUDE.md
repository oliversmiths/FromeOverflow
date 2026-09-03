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
  (the map's streets) from the OSM Overpass API. Run rarely, by hand.
- `npm run audit-ids` → `node scripts/audit-ids.js` — diff the fallback catchment
  rule against the hand-curated `PIN_TO_IDS`. Read-only; run every few months.

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
  `fmtDuration`, `rankByTotal`, `statusOf`, `mapStatusOf`, `dayCells`, `mapsUrl`,
  `DAY`, `RECENT_HOURS`, …). **Imported by `poll.js` and every page/lib module**
  so a spill is measured identically in the console and on screen. This is the
  single source of truth for how a discharge is counted — change it here, nowhere
  else. `statusOf` is the 3-state code (discharging / offline / dry); `mapStatusOf`
  adds the "recent" step (a spill that ended within `RECENT_HOURS`, default 48) for
  the traffic light. `dayCells` turns a monitor's events into one cell per day for
  the last 90 (`spill`/`recent`/`nodata`/`dry`, checked in that order) — the
  per-monitor strip.
- **`docs/lib/cards.js`** — `renderCards(container, data)`: the per-monitor list.
  One card each (ranked by total discharge time) with a `statusOf` badge, a
  summary line, and a GitHub-status-style 90-day strip — one bar per day from
  `dayCells` (`.o-day--spill` red / `--recent` amber / `--nodata` grey / plain
  `.o-day` green), capped at 450px wide, shrinking below that.
- **`docs/lib/map.js`** — `buildMap(host, data, { initialZoom })` + `renderLegend`.
  **No library, no tile service.** Fetches `basemap.json` and draws roads/
  waterways as one SVG whose `viewBox` is the camera; pins/labels/popups are an
  HTML overlay repositioned each frame. The camera is clamped to **`CROP_KM`**
  (in map.js) — an asymmetric rectangle on the town (`bm.centre`), km offsets
  `{n,s,e,w}`, shaped to the Frome catchment: long N–S, reaching WSW down the
  Mells, barely east. This is a *tighter* box than the basemap. Pan/wheel/pinch
  can't leave it: at `MAX_ZOOM_OUT` (1) the crop *covers* the viewport
  (`VW_OUT = min(CW, CH*a)`) so a wide screen shows the full crop width and pans
  up/down, a tall screen the full height. `MAX_ZOOM_IN` (40) sets the tightest
  zoom. `initialZoom` (live page: `0.28`) opens centred on the town, ~6 km
  across. Pins coloured by `mapStatusOf` (`.mappin--*`: red / amber / bright
  green / grey), which also drives the legend. A monitor outside the crop (or
  panned off-screen) is hidden; flip `SHOW_EDGE_MARKERS` to stick it to the edge
  instead. Web Mercator projection in `drawMap` **must match
  `scripts/build-basemap.js`**. Labels: `bm.labels.places` carry a `kind`
  (`town`/`village`/`suburb`/`hamlet`), styled and zoom-gated by `LABEL_ZOOM` —
  towns/villages always (orientation), roads/suburbs from mid-zoom in, hamlets
  only close up. A per-frame greedy box-overlap cull thins them; `RANK` sets the
  priority (town, village, road, suburb, hamlet — a street name locates an
  outfall better than a district). The host is `#overflow-map`, *not* `id="map"`.
- **`docs/index.html`** + **`docs/styles.css`** — the page: a full-viewport
  `#overflow-map`. One floating button (top-right) opens a right-hand slide-in
  drawer (`.panel`, 500px / 100% on mobile, deep-water-blue with white text)
  with a tab strip — **Timeline** (the `cards.js` list), **About**, **Credits**.
  Opens to Timeline; tabs are `role="tab"` with arrow-key nav; the active tab is
  the URL hash (`#timeline` / `#about` / `#credits`). The Timeline tab leads with
  the "N monitors · last checked …" stamp, then the `cards.js` list.
  The legend is a bottom-centre pill. On load a full-screen `.splash` shows the
  verdict big (`#splash-verdict`, `setSplashVerdict` sets it word-by-word for the
  hand-set look) over `docs/assets/overflow-img.webp`; then it fades after 5 s
  (tap/Esc to skip). No framework
  — `fetch`es `data.json` once, then `renderCards` + `buildMap`. `styles.css` is
  the only stylesheet.
- **`docs/assets/`** — committed static assets: `icon.png` (favicon / apple-touch),
  `overflow-img.webp` (splash backdrop), `happy-times-NG_italic_master_web.woff2`
  (the `--display` face, self-hosted via `@font-face`; `--body`/`--data` still
  come from the Adobe kit `hpb4tyd`). `data.json` / `basemap.json` stay at the
  `docs/` root — they're generated, not assets.
- **[scripts/build-basemap.js](scripts/build-basemap.js)** — one-off, zero-dep.
  Overpass query for the **`EDGE_KM`** box on `CENTRE` — an asymmetric rectangle
  (`{n,s,e,w}` km) that must contain map.js's `CROP_KM` with ~1 km margin.
  Projects to a `GRID = (e+w)*1000` integer grid (~1 unit/m), Douglas–Peucker
  simplifies, writes `docs/basemap.json` (`centre`, `box`, `size`, `layers`,
  `labels`). Roads named at `major`/`mid` class and > `MIN_ROAD_LEN` become road
  labels, nearest-Frome-first then longest (top 110); `place=town|village|hamlet|
  suburb` nodes become place labels tagged with `kind`, also nearest-first and
  capped per kind (`PLACE_CAP`) because the box reaches the Radstock/Mendip
  fringe. The page
  trusts `basemap.json`'s own `centre`/`box`/`size`, so a rebuild with different
  bounds just works. Overpass 504s on a box this size when busy — the script
  tries three instances, twice each. Output is ~410 KB (~170 KB gzipped); bump
  `SIMPLIFY` if that needs to come down.
- **[scripts/audit-ids.js](scripts/audit-ids.js)** — zero-dep. Imports
  `fetchAll` + `matchesRule` from `poll.js` (which only runs `main()` when
  executed directly), fetches the feed, and prints a diff between the fallback
  rule and the hand-curated `PIN_TO_IDS`. Run every few months to catch new or
  retagged Wessex monitors; nothing is written.
- **[.github/workflows/poll.yml](.github/workflows/poll.yml)** — GitHub Action:
  commits `overflows.db` + `docs/data.json` back to the branch, optionally rsyncs
  `docs/` to SiteGround (gated on the `DEPLOY_TO_SITEGROUND` repo variable).
  **The repo is the database**; GitHub Pages / SiteGround just serves `docs/`.
  Cadence: the `schedule:` cron is `7,22,37,52 * * * *` (off the hour on purpose)
  but is only a fallback — GitHub skips most ticks on a low-traffic repo. An
  external cron (cron-job.org) hits the `workflow_dispatch` API every 15 min for
  the real cadence; see [SETUP.md](SETUP.md). `concurrency: poll` absorbs any
  double-trigger.

### Layout

```
poll.js                 fetch + store + export    (root)
serve.js                zero-dep static server for docs/
scripts/build-basemap.js one-off: OSM streets → docs/basemap.json
scripts/audit-ids.js    one-off: diff the fallback rule against PIN_TO_IDS
docs/index.html         the page — full-screen map + slide-in panels
docs/styles.css         its stylesheet
docs/lib/format.js      shared maths, imported by poll.js and the page modules
docs/lib/cards.js       renderCards() — the per-monitor list + 90-day strip
docs/lib/map.js         buildMap() — the no-library SVG map
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

The whole region-wide feed is fetched every poll, then filtered. `isLocal`:

1. If `PIN_TO_IDS` is non-empty, keep exactly those `Id`s — **this is the live
   state**: a fixed, hand-curated list of 38 monitors (the map crop and the whole
   design assume this set). Edit it by hand; run `node scripts/audit-ids.js` now
   and then to see what the rule below would pick that the list doesn't have.
2. Otherwise (list empty) apply the **fallback rule**: within `RADIUS_KM` (7 km),
   **or** within `CATCHMENT_KM` (30 km) with a `ReceivingWaterCourse` matching
   one of `WATERCOURSES` (`frome`, `mells`, `nunney brook`, …).

The catchment bound matters: real Frome-system monitors all sit within ~15 km,
the **Bristol** Frome (a different river) starts ~31 km out, and the Dorset Frome
further still — there's a clean 16 km gap, so 30 is safe. Rows with no
coordinates are dropped. `EXPORT_DAYS` (90) sets the JSON/page window.

## Caveats to preserve

An EDM records *when* an overflow starts/stops — not volume, not water quality, and
an activation *indicates* rather than *confirms* a discharge (debris can trigger
one). These figures will not match Wessex's regulator-verified annual returns.
Keep this framing in any user-facing copy.
