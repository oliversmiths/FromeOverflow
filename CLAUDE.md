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
- `npm run context` → `node scripts/fetch-context.js` — fill in each monitor's
  static reference data (site name, waterbody, overflow type, treatment, cause)
  from Wessex's `overflow_context` layer. Writes to `monitors`; run every few
  months, then `npm run poll` to republish. `--dry` shows what would change.
- `npm run annual-returns` → `node scripts/fetch-annual-returns.js` — fill in
  each monitor's regulator-verified annual spill figures (spill count,
  duration, long-term average) from the Environment Agency's EDM Storm
  Overflow Annual Return. Writes to `annual_returns`; run once a year, after
  EA publishes (typically spring). `--dry` shows what would change.
- `npm run swim-spots` → `node scripts/fetch-swim-spots.js` — refresh the
  hand-curated swim spots (currently Farleigh Hungerford, Tellisford Weir) and
  their latest water-quality/river-flow readings from a public FeatureServer
  behind Wessex's Farleigh Hungerford Dashboard. Writes to `swim_spots` and
  `swim_spot_readings`. Already runs automatically, roughly daily, as part of
  `poll.yml` — run it by hand only if you want a reading sooner than that.
  `--dry` shows what would change.

There is no test suite or linter. `build-basemap.js` is the only build step and its
output is committed. The page must be served over http — browsers block module
imports and `fetch` on `file://`.

**`overflows.db` is gitignored on `main`** — it lives on the orphan `db` branch.
A fresh checkout has no database; fetch the current one with:

```bash
git fetch origin db && git show origin/db:overflows.db > overflows.db
```

Then inspect it with the system `sqlite3`:

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
  `exportJson` also republishes `swim_spots` (unwindowed — there are only ever
  a couple of rows) alongside `monitors` every poll, even though only
  `scripts/fetch-swim-spots.js` ever changes what's in it. `fetchAll`'s
  per-page request goes through `fetchPage`, which retries
  (`FETCH_RETRIES`, 5s apart) on the failures a flaky connection produces —
  `fetch()` throwing outright (Node reports a dropped connection or DNS blip as
  a bare "fetch failed") and 5xx responses — since a run every 15 minutes hits
  Wessex's server often enough that one is expected noise, not an outage. A 4xx
  or an ArcGIS-reported `body.error` fails immediately instead, since those mean
  the request itself is wrong and won't change on retry.
- **`docs/lib/format.js`** — shared duration maths and formatting (`spillMs`,
  `fmtDuration`, `rankByTotal`, `statusOf`, `mapStatusOf`, `dayCells`, `mapsUrl`,
  `DAY`, `RECENT_HOURS`, …). **Imported by `poll.js` and every page/lib module**
  so a spill is measured identically in the console and on screen. This is the
  single source of truth for how a discharge is counted — change it here, nowhere
  else. `statusOf` is the 3-state code (discharging / offline / dry); `mapStatusOf`
  adds the "recent" step (a spill that ended within `RECENT_HOURS`, default 48) for
  the traffic light. The map popup is split in two by a rule: **above it is the
  live activity feed** (Id + watercourse, state, last discharge, offline total,
  coordinates). **Below it, in order:** a monitor with annual-return data gets
  its own `.pop-annual` box — not folded into the context grid below, because
  a regulator's published figure reads as a claim of its own, not just
  another attribute, and it's ahead of the divider because it's a live-ish
  fact worth seeing without having to go looking for it — built from
  `fmtAnnualReturn`: a heading, "N spills, total `<duration>` in `<year>`"
  (spill count and duration in `<strong>`, the headline figures), and "N
  spills/yr avg since `<year>`" when the long-term figure is there too. These
  are the Environment Agency's own regulator-verified numbers, deliberately
  the *other* figure from everything else on the page (ours is a live-tracked
  floor; theirs is official, counted differently, a year in arrears). Then
  `CONTEXT_ROWS` — `overflow_context` fields as a `.pop-context` term/value
  grid, **`site_name`/`waterbody`/`overflow_type`/`cause` only**; `treatment`
  is fetched and stored the same as the rest (`scripts/fetch-context.js`,
  `monitors.treatment`) but deliberately left off this list — it reads like
  Wessex's own framing of the discharge rather than a neutral fact, and costs
  more popup space than the others. Still in the database and `data.json` —
  add it back to `CONTEXT_ROWS` if you ever want it on screen again. The grid,
  plus a **Share** button (`buildShareButton` — copies `location.href` to the
  clipboard, which by then already carries this item's own `#id` from
  `openPopup`/`openSwimPopup` below), sit together inside `.pop-more`,
  collapsed behind `.pop-more-toggle`, "+ More"/"− Less" — a plain button and
  click listener, **not** a native `<details>` (its content has to render
  full popup width, not squeezed into `.pop-foot`'s row). The toggle itself
  always exists, even with no `CONTEXT_ROWS` to show, since Share needs
  somewhere to live regardless. `swimPopup` has no equivalent — a swim spot
  has no context-row data to hide behind a toggle, so a "+ More" there would
  exist purely to reveal Share and nothing else; Share sits straight in its
  `.pop-foot` instead, always visible, no toggle at all. Since toggling
  popup()'s own version can change the popup's own height after `showPopup`
  already measured and positioned it — and `pop` sits inside `host`'s own
  `overflow: hidden` — a second listener on the same toggle re-measures and
  calls `placePopup()` again, or an expanded box could get silently clipped
  rather than just repositioned. Rows and boxes with no value are skipped, so
  an unfetched monitor just shows the feed half plus Share, and a monitor
  with no annual-return match just skips the box.
  `dayCells`
  turns a monitor's events *and its offline spells* into one cell per day for the
  last 90 — `nodata`/`spill`/`recent`/`offline`/`dry`, **checked in that order**:
  a day before the monitor's `since` is unknown and stays unknown, whatever the
  feed claims about it. `offlineMs` totals a monitor's offline time; `rankByTotal`
  clips each spill to `since`, so a total never counts time the record doesn't
  cover. **`windowPhrase` is permanent, not a launch-window patch** — while a
  monitor's *own* record is shallower than `window_days` the copy says
  "(watching since 30.08.26)" instead of "in the last 90 days". The "watching
  since" wording isn't a claim about history — a bare "since 30.08.26" sounds
  like ordinary English for "that's when it last happened", which may not be
  true (Wessex's own history can reach further back than what this page
  publishes); saying it's when *we* started watching is true regardless of what,
  if anything, happened before it, so it applies uniformly, on every card and
  popup in its "since" form, not just ones with no discharge. It's parenthesised
  — a trailing aside on the count, not a claim baked into the sentence — rather
  than inline ("3 discharges since watching began …"). It reads
  per-monitor `since`, so a monitor added later (a new Wessex outfall, or an
  extended `PIN_TO_IDS`) gets the same honesty for its first 90 days and
  switches over by itself. `fmtDate` is `DD.MM.YY` (numeric,
  zero-padded — "01.09.26"), chosen for brevity on the card's meta line;
  `fmtWhen`'s day branch matches it, "4d ago" not "4 days ago".
- **`docs/lib/cards.js`** — `renderCards(container, data, onSeeOnMap)`: the
  per-monitor list. One card each (ranked by total discharge time) with a
  `statusOf` badge, a summary line, and a GitHub-status-style 90-day strip — one
  bar per day from `dayCells` (`.o-day--spill` red / `--recent` amber /
  `--offline` mid-grey / `--nodata` **hatched** / plain `.o-day` green), capped at
  450px wide, shrinking below that. The card's own left border follows
  whichever view is on screen, not always the live status: `.is-discharging`/
  `.is-dry`/`.is-offline` (from `statusOf`) in 90-Day view, or `.is-dry`/
  `.is-amber`/`.is-oxide` (from `monitorSeverity` — this monitor's *most
  recent* annual-return year's tier, same threshold as `yearSeverity` below)
  in History — `applyView` swaps the class using `card.dataset.liveState`/
  `histState`, set once at render time; a monitor with no annual-return data
  just keeps its live colour in both views. The History legend's swatches
  (`.o-history-swatch--spills`/`--duration`) are tinted the same way, so a
  card's border, legend and top (most recent) row's own bars all agree. When
  `offlineMs` is non-zero the summary line
  appends "offline for …" — "no discharge recorded" means less when part of the
  record is missing. The "watching since" wording lives entirely in
  `windowPhrase` (see above) — the summary line just interpolates it, whether
  or not there were discharges, so "3 discharges (watching since 30.08.26)"
  and "0 discharge (watching since 30.08.26)" read the same way.
  **`docs/lib/map.js`'s popup uses the same `windowPhrase`** for its own
  no-discharge line, so the card and the pin never disagree about the same
  monitor. "Watch"/"watching" is the vocabulary
  throughout — this project is Overflow *Watch* — never "record[ing]" for the
  live-monitoring sense (`overflows.db`/"record" is fine for the *data*, e.g.
  "keeps its own history"). Each bar carries the structured `data-tip-*`
  attributes, not `title`. `onSeeOnMap` backs each card's "View on map"
  button; `map.js`'s popup has the reverse, `onSeeInTimeline` (its "View
  Timeline" link), which opens the Timeline tab and scrolls straight to
  the matching card via `[data-monitor-id]` — set here on every card for
  exactly that lookup.
- **`docs/lib/tooltip.js`** — `initTooltips()`: one shared `.tip` element for
  anything with a `data-tip*` attribute, delegated from `document`. Two forms:
  `data-tip="…"` is one plain line; `data-tip-date` / `data-tip-status`
  (+ `data-tip-state` for a colour dot) / `data-tip-note` render as up to three
  separately styled rows (`.tip-date` / `.tip-status` + `.tip-dot--{state}` /
  `.tip-note`), any subset. Replaces the native `title`, which is slow to appear,
  unstyleable and invisible on touch. Positions `fixed` and clamps to the
  viewport, which matters because the 90-day bars are ~4px wide and sit against
  both edges of a 500px panel; flips below the target when there is no room
  above, and hides on scroll rather than tracking.
- **`docs/lib/map.js`** — `buildMap(host, data, { initialZoom, onSeeInTimeline })`
  + `renderLegend`.
  **No library, no tile service.** Fetches `basemap.json` and draws roads/
  waterways as one SVG whose `viewBox` is the camera; pins/labels/popups are an
  HTML overlay repositioned each frame. The camera is clamped to **`CROP_KM`**
  (in map.js) — an asymmetric rectangle on the town (`bm.centre`), km offsets
  `{n,s,e,w}`, shaped to the Frome catchment: long N–S, reaching WSW down the
  Mells, barely east. This is a *tighter* box than the basemap. Pan/wheel/pinch
  can't leave it: at `MAX_ZOOM_OUT` (1) the crop *covers* the viewport
  (`VW_OUT = min(CW, CH*a)`) so a wide screen shows the full crop width and pans
  up/down, a tall screen the full height — on a wide screen this means a point
  well north or south of the town (Farleigh Hungerford is ~10 km N) isn't in
  the default view even fully zoomed out; panning is required, by design, not
  a bug. `MAX_ZOOM_IN` (40) sets the tightest zoom. `initialZoom` (live page:
  `0.28`) opens centred on the town, ~6 km across. Monitor pins coloured by
  `mapStatusOf` (`.mappin--*`: red / amber / bright green / grey), which also
  drives the legend. A pin outside the crop (or panned off-screen) is hidden;
  flip `SHOW_EDGE_MARKERS` to stick it to the edge instead. Web Mercator
  projection in `drawMap` **must match `scripts/build-basemap.js`**.

  **Swim spots** (`swimPins`, built from `data.swim_spots`) are a second,
  parallel pin set on the same `pinLayer` — `.swimpin`, a rotated square
  (`.mappin` with `border-radius:0` + a 45° `transform`) filled `--water`,
  deliberately not another traffic-light colour. Popup state is unified across
  both: `openItem` holds whichever monitor or swim spot is currently open
  (both carry `{lon, lat}`, so `placePopup()` doesn't need to know which),
  `showPopup(content, item, pinEl)` is the shared open/measure/ring/place
  logic, and `openPopup(m)` / `openSwimPopup(s)` just supply the
  kind-appropriate content (`popup()` vs `swimPopup()`) and pin element to
  ring. A swim spot's popup is genuinely different content, not a branch of
  the monitor one: name, a recognised/not-recognised line (reusing
  `.pop-state.is-dry`/`.is-offline` for the colour, not their original
  meaning), the latest water-quality reading in its own `.pop-annual`-styled
  box (`fmtWaterQuality`) — every determinand sampled on the latest date, not
  just one, and Wessex's own status sentence shown verbatim rather than a
  word guessed out of it — the latest river-flow reading (`fmtFlow`), a plain
  `.pop-note` description with no divider above it (see `popup()`'s own
  comment on why), and a `.pop-foot` row with Share always visible (no
  "+ More" toggle — see the `.pop-more` paragraph above) plus a link to
  Wessex's dashboard if there is one (Tellisford Weir has none — not an
  EA-recognised bathing water, so nothing to link to).

  Labels: `bm.labels.places` carry a `kind` (`town`/`village`/`suburb`/
  `hamlet`), `bm.labels.roads` are all `road`, `bm.labels.waterways` are all
  `waterway` (named brooks/streams from `build-basemap.js`'s OS Open Rivers
  pull — gate this off with **`SHOW_WATERWAY_LABELS`** if it reads as
  clutter, nothing else depends on it). All styled and zoom-gated by
  `LABEL_ZOOM` — towns/villages always (orientation), roads/waterways from
  mid-zoom in, hamlets/suburbs later, hamlets only close up. A per-frame
  greedy box-overlap cull thins them; `RANK` sets the priority (town, village,
  road, waterway, suburb, hamlet — a street or brook name locates an outfall
  better than a district). The host is `#overflow-map`, *not* `id="map"`.
- **`docs/index.html`** + **`docs/styles.css`** — the page: a full-viewport
  `#overflow-map`. One floating button (top-right) opens a right-hand slide-in
  drawer (`.panel`, 500px / 100% on mobile, deep-water-blue with white text)
  with a tab strip — **Timeline** (the `cards.js` list), **Info** (what this is,
  how to read the map and strip, Friends of the River Frome), **Safety** (leads
  with the water-quality disclaimer, then the interpretation caveats), **Sources**
  (just Data + Map — provenance and the CC BY attribution). Opens to Timeline;
  tabs are `role="tab"` with arrow-key nav; the active tab is the URL hash
  (`#timeline` / `#info` / `#safety` / `#sources`). The Timeline tab leads with
  the "N monitors · last checked …" stamp, then `.overflows-controls` — a sort
  `<select>` (`SORTS` in cards.js: 90-day total / EA long-term avg spills / this
  project's own avg annual duration) and a panel-wide 90-Day/History toggle
  (`setCardsView`, cards.js) that flips every card at once — then the `cards.js`
  list itself.
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
  Three sources, fetched in parallel, for the **`EDGE_KM`** box on `CENTRE` — an
  asymmetric rectangle (`{n,s,e,w}` km) that must contain map.js's `CROP_KM` with
  ~1 km margin: an Overpass query for roads/places/standing water, and two
  ArcGIS FeatureServer queries (`arcgisQuery`) for the rivers — the EA's
  **Statutory Main River Map** (`river` bucket, the legally-designated
  watercourses) and Ordnance Survey's **OS Open Rivers** (`stream` bucket,
  everything else it names — brooks, gutters, minor tributaries). Waterways used
  to come from OSM's own `waterway` tag, dropped in favour of these two: that tag
  is a size guess by whoever mapped it, not the Main River/ordinary-watercourse
  line the EA actually draws, and its small-watercourse coverage near Frome was
  thin (a handful of unnamed `ditch` fragments, and `ditch` wasn't even in the
  old fetch). The swap isn't just a like-for-like fix either — total
  river+stream line length is ~21% longer than the old OSM-only version, despite
  fewer raw segments, because Esri's `WatercourseLink` segments run the length of
  a named reach rather than breaking at every OSM way boundary. Esri hands back
  `paths` as `[lon, lat]` pairs, not Overpass's `{lat, lon}` objects — `toGeom`
  adapts them before `addLine`. An OS `form: 'lake'` entry is skipped (it
  duplicates OSM's own `natural=water` outline); `form: 'canal'` goes to `river`
  (visually major, same as OSM's canal tag used to), everything else to `stream`.
  Projects to a `GRID = (e+w)*1000` integer grid (~1 unit/m), Douglas–Peucker
  simplifies, writes `docs/basemap.json` (`centre`, `box`, `size`, `layers`,
  `labels`). Roads named at `major`/`mid` class and > `MIN_ROAD_LEN` become road
  labels, nearest-Frome-first then longest (top 110); `place=town|village|hamlet|
  suburb` nodes become place labels tagged with `kind`, also nearest-first and
  capped per kind (`PLACE_CAP`) because the box reaches the Radstock/Mendip
  fringe. OS Open Rivers' own `name1` (unlike OSM, it names essentially every
  watercourse) feeds `labels.waterways` the same way — `waterwayRuns` mirrors
  `roadRuns`, aggregated by name, longest run's midpoint as the anchor,
  `MIN_WATERWAY_LEN`-filtered, nearest-Frome-first then longest — uncapped,
  since there are far fewer named watercourses in the box than roads. The page
  trusts `basemap.json`'s own `centre`/`box`/`size`, so a rebuild with different
  bounds just works. Overpass 504s on a box this size when busy — the script
  tries three instances, twice each; the two Esri sources are far more stable, so
  `arcgisQuery` just retries the one URL. Output is ~420 KB (bump `SIMPLIFY` if
  that needs to come down); attribution is credited three ways now — see
  `map.js`'s `.map-attr` and the Sources tab's Map section, both of which need
  updating if a source here ever changes.
- **[scripts/audit-ids.js](scripts/audit-ids.js)** — zero-dep. Imports
  `fetchAll` + `matchesRule` from `poll.js` (which only runs `main()` when
  executed directly), fetches the feed, and prints a diff between the fallback
  rule and the hand-curated `PIN_TO_IDS`. Run every few months to catch new or
  retagged Wessex monitors; nothing is written.
- **[scripts/fetch-context.js](scripts/fetch-context.js)** — zero-dep, hand-run.
  The activity feed publishes only 11 fields and **no site name or waterbody**;
  Wessex put those on a separate public layer, `overflow_context`, in the same
  ArcGIS org. Joins on **`National_Unique_Id_2025`** (the same `WXW…` ids;
  `National_Unique_Id` is the older `WSX…` scheme — check there first if a rename
  ever breaks the join) and fills `site_name`, `waterbody`, `overflow_type`,
  `treatment`, `cause`, `context_at` on `monitors`. **Never writes `label`.**
  Static data, so deliberately not part of the poll. `--dry` to preview. That
  layer holds much more than we take — permit reference, regulator-verified
  annual spill counts, `Perc_of_reporting_period_monito` (Wessex's own monitor
  uptime figure), improvement plans — if you ever want more, add to `FIELDS`.
- **[scripts/fetch-annual-returns.js](scripts/fetch-annual-returns.js)** —
  zero-dep, hand-run. Pulls each monitor's official annual spill figures from
  the Environment Agency's own public FeatureServer
  (`edm_annual_returns_all_years_public`) — the same data behind their Storm
  Overflow Explorer. Joins on **`unique_id`**, which holds the same `WXW…` ids
  the activity feed uses, but **only from the 2024 annual return on**: 2021–2023
  used the older `WSX####` scheme instead, has no `unique_id` on those rows,
  and there's no published crosswalk, so those years are skipped rather than
  matched by guessing at site names. Fills `spill_count`, `duration_hours`,
  `long_term_avg_spills`, `data_start_year` on `annual_returns`, one row per
  `(monitor, year)`. This is deliberately the *other* number from everything
  `poll.js` tracks — see "Known undercount" below — so it's kept in its own
  table rather than merged into `monitors`. Static data, not part of the poll;
  `--dry` to preview.
- **[scripts/fetch-swim-spots.js](scripts/fetch-swim-spots.js)** — zero-dep.
  Run automatically (see `poll.yml`'s "Refresh swim spots" below) as well as
  by hand. **`SWIM_SPOTS`** is the whole list of points of interest — hand-
  curated like `PIN_TO_IDS`, edit it by hand to add another. Coordinates are
  the spot as people actually find it, not necessarily the FeatureServer's own
  sampling-point coordinates (Farleigh Hungerford's is ~400m off the crossing
  people swim at). The readings come from a public FeatureServer found by
  digging into the config behind Wessex's own **Farleigh Hungerford
  Dashboard** — not linked from the dashboard UI itself, only reachable by
  fetching the dashboard item's data, following its `itemId` to the web map it
  embeds, and reading that map's `tables` (not `operationalLayers` — the
  actual sampling results are dashboard-only tables, invisible on the map
  layer itself): `FeatureServer/2` (`FH_WATER_QUALITY`, weekly E. coli /
  Intestinal Enterococci sampling with a plain-English `Latest_Status`
  sentence) and `FeatureServer/1` (`EA_FLOW_DATA`, a daily river-flow reading
  from the EA's hydrology API at the Tellisford gauge). The flow reading isn't
  spot-specific — both spots are the same short reach — so it's written to
  every spot in `SWIM_SPOTS`, not just whichever is nearest the gauge; a spot
  with no reading for a layer (Tellisford Weir has no water-quality sampling —
  it isn't an EA-recognised bathing water) just keeps whatever it already had,
  via `COALESCE` in the upsert, rather than the read clearing a good value.
  Water-quality readings go in their own table, `swim_spot_readings` — a
  sampling visit reports more than one determinand, and there's no reason to
  keep only one. Diffs against what's already there before writing, same as
  `fetch-context.js`/`fetch-annual-returns.js` — both tables are keyed upserts
  regardless, so this doesn't protect the database from growing, only makes
  the console output honest about whether anything's actually new. `--dry` to
  preview.
- **[.github/workflows/poll.yml](.github/workflows/poll.yml)** — GitHub Action.
  **`overflows.db` is NOT on `main`** — it lives on the orphan **`db` branch**,
  restored at the start of each run (`git show FETCH_HEAD:overflows.db`) and
  force-pushed back as a single commit at the end, built in a temp dir so the
  checkout is never disturbed. That keeps `.git` from growing without bound;
  committing a ~1 MB binary 100×/day was adding hundreds of MB a year. `main`
  gets only `docs/data.json` and, once a week, `archive/YYYY-Www.sql.gz` — a
  gzipped dump of `monitors` + `events` + `offline` + `annual_returns` +
  `swim_spots` + `swim_spot_readings` (~3 KB) that is the public,
  forkable, permanent record *and* the recovery path if a force-push to `db` ever
  writes something broken. To get the database locally:
  `git fetch origin db && git show origin/db:overflows.db > overflows.db`.
  GitHub Pages serves `docs/`.
  Cadence: the `schedule:` cron is `7,22,37,52 * * * *` (off the hour on purpose)
  but is only a fallback — GitHub skips most ticks on a low-traffic repo. An
  external cron (cron-job.org) hits the `workflow_dispatch` API every 15 min for
  the real cadence; see [SETUP.md](SETUP.md). `concurrency: poll` absorbs any
  double-trigger. **"Refresh swim spots"** runs `scripts/fetch-swim-spots.js`
  on that same 15-min cadence but only *does* anything roughly daily — it's
  gated on `swim_spots.fetched_at` (already in the restored db, so no separate
  sentinel file), not a fixed hour, so a missed tick just means the next one
  catches up rather than a day being silently skipped. A failure here logs a
  `::warning::` and the job carries on; a swim-spot source outage shouldn't
  block the actual overflow poll.

### Layout

```
poll.js                 fetch + store + export    (root)
serve.js                zero-dep static server for docs/
scripts/build-basemap.js one-off: OSM streets → docs/basemap.json
scripts/audit-ids.js    one-off: diff the fallback rule against PIN_TO_IDS
scripts/fetch-context.js one-off: site names + waterbody etc → monitors table
scripts/fetch-annual-returns.js one-off: EA annual returns → annual_returns table
scripts/fetch-swim-spots.js one-off: swim spot readings → swim_spots table
docs/index.html         the page — full-screen map + slide-in panels
docs/styles.css         its stylesheet
docs/lib/format.js      shared maths, imported by poll.js and the page modules
docs/lib/cards.js       renderCards() — the per-monitor list + 90-day strip
docs/lib/tooltip.js     initTooltips() — one shared [data-tip] tooltip
docs/lib/map.js         buildMap() — the no-library SVG map
docs/data.json          generated by poll.js (git-committed; absent in a fresh
                        checkout until the first poll)
docs/basemap.json       generated by build-basemap.js (git-committed)
archive/*.sql.gz        weekly dump of monitors+events+offline+annual_returns+swim_spots (git-committed)
overflows.db            node:sqlite file — on the orphan `db` branch, NOT main
```

## Data model & domain rules

Seven tables (schema in [poll.js](poll.js) `SCHEMA`):

- **`monitors`** — one row per outfall, with three kinds of column:
  - `label` is **human-owned; nothing automated writes it** — not the poller, not
    `fetch-context.js` (`UPDATE monitors SET label=... WHERE id=...`).
  - `latitude`/`longitude`/`watercourse`/`last_seen` come from the activity feed
    and are refreshed on every poll.
  - `site_name`/`waterbody`/`overflow_type`/`treatment`/`cause`/`context_at` are
    static reference data, written only by `npm run context`. The poller's
    `upsertMonitor` lists its columns explicitly, so a poll can't clobber them.

  `exportJson` publishes the heading as **`label ?? id`** — the Wessex Id is the
  title on both card types, exactly as the activity feed gives it, and `label` is
  a hand-set escape hatch that is normally NULL. `site_name` is published
  *separately* and appears in the popup's context block, not as the title.
- **`events`** — keyed on `(monitor_id, start_ms)`. Wessex give us only the latest
  event's start/end, so: a start we've seen before just fills in `end_ms`
  (`COALESCE`, never overwritten); an unseen start is a new spill. **`exportJson`
  publishes only events that reach into the monitor's own record** (`end_ms IS
  NULL OR end_ms >= first_seen`). The first reading hands over Wessex's latest
  event, which can be months old — 33 of 37 were, at cutover — and drawing those
  put a lone red bar in a field of hatching, implying we had covered the whole
  stretch. They stay in the table, just off the page.
- **`offline`** — offline spells as `{monitor_id, start_ms, end_ms}`, shaped
  exactly like `events` and maintained by `store` from `StatusStart`. **This is
  the permanent record of when a monitor was dark** — it used to be re-derived
  from `snapshots` on every export, which is why snapshots could never be pruned.
- **`snapshots`** — the raw poll log, kept only as a **30-day recovery buffer**
  (`SNAPSHOT_DAYS`) so a recent stretch can be re-read with better logic.
  `pruneSnapshots` drops the rest on every poll. Deliberately no `VACUUM`: the
  freed pages are reused by the next inserts, so the file settles at a steady
  ~11 MB instead of being rewritten (which would also destroy git delta
  compression). Columns added after the first release need a one-off
  `ALTER TABLE` in `migrate()` — `CREATE TABLE IF NOT EXISTS` will not add them
  to an existing `overflows.db`.
- **`annual_returns`** — keyed on `(monitor_id, year)`, written only by
  `npm run annual-returns`. Holds the Environment Agency's own regulator-verified
  figures for that monitor's year: `spill_count`, `duration_hours`,
  `long_term_avg_spills` and the `data_start_year` that average runs from.
  **This is not `poll.js`'s own count under another name** — the "Known
  undercount" below describes a live-tracked floor that can miss a spill
  between two polls; this is Wessex's official return, counted by EA's own
  12–24h method, published roughly a year in arrears. The two are expected to
  disagree, and both are worth showing rather than picking one. Only reaches
  back to 2024 — see the script's header comment for why 2021–2023 is skipped
  rather than guessed at.
- **`swim_spots`** / **`swim_spot_readings`** — not overflow monitors at all;
  points of interest shown on the map with their own pin and popup. The set of
  spots is hand-curated (`SWIM_SPOTS` in `scripts/fetch-swim-spots.js`, the
  same pattern as `PIN_TO_IDS`), and only that script ever writes either
  table. `swim_spots` holds identity (`name`, `latitude`/`longitude`,
  `recognised`, `description`, `dashboard_url`) plus the single latest
  river-flow reading (`flow_value`/`flow_measured_at` — shared across every
  spot on the reach, not specific to one); `swim_spot_readings` holds every
  determinand from the latest water-quality sample, keyed on
  `(spot_id, determinand, sampled_at)` since one sampling visit reports more
  than one (E. coli and Intestinal Enterococci). A spot with no water-quality
  sampling (Tellisford Weir isn't an EA-recognised bathing water) simply has
  no rows here.

**Retention is split by purpose.** `monitors`, `events`, `offline`,
`annual_returns` and `swim_spots`/`swim_spot_readings` are the permanent
record and are *never* pruned — together a few hundred KB a year.
`snapshots` is ~99% of the file (3,876 rows/day at 91 bytes each) and holds
almost no information, because nearly every row is identical to the one before
it. Keeping the raw log for a year would be ~123 MB, over GitHub's 100 MB file
limit; this split gives unlimited history of everything the page can show, at
~11 MB flat.

Rules baked into `store` / `exportJson`:

- **Status codes:** `1` = discharging, `-1` = offline/no signal, anything else = dry.
- While `Status === 1` the event's `end_ms` is left `NULL` — the end Wessex report
  during an active spill belongs to the *previous* event.
- **Offline is a status, not an event.** Wessex only ever describe *discharges* in
  `LatestEventStart`/`LatestEventEnd`; those stay frozen on the last spill while a
  monitor is dark. `store` therefore tracks it from `StatusStart`: a `-1` reading
  opens a row in `offline`, and the *next* status's `StatusStart` closes it. If a
  recovery is missed between polls, the open spell is closed at the new one's
  start. `backfillOffline` is the one-off that seeded the table from the old
  snapshot log (splitting runs on `OFFLINE_GAP_MS`, 90 min, for rows written
  before `status_start_ms` existed); it will not re-run once the table is
  non-empty.
- **An offline day is not a discharge.** Other trackers (Surfers Against Sewage)
  treat a dark sensor as suspicious and colour it like a spill. This project does
  not — it reports the gap as a gap (mid-grey day, "offline for …" on the card),
  which is consistent with the caveat that an activation *indicates* rather than
  *confirms* a discharge. Keep that distinction in any user-facing copy.
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
