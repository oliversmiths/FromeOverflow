# Frome Overflow Watch

A single-town monitor for storm overflow discharges around Frome, Somerset,
built on Wessex Water's near real-time event duration monitor (EDM) feed.

Wessex publish current status only — no history. This keeps its own.

## How it fits together

```
Wessex Water ArcGIS feed  ──▶  poll.js  ──▶  overflows.db (node:sqlite)
                                  │
                                  └──────▶  docs/data.json  ──▶  docs/index.html
```

`poll.js` pages the whole Wessex feed, keeps the overflows near Frome, writes
them to SQLite, and exports the last 90 days as JSON. The page is static and
reads that JSON.

`docs/lib/format.js` holds the duration maths and formatting. The poller and the
page both import it, so a spill is measured the same way in the console and on
the screen. `docs/lib/cards.js` and `docs/lib/map.js` are the two view
components.

The page is a **full-screen map** of Frome with every monitor as a pin on a
traffic light: red discharging now, amber discharged in the last 48h, green not
discharging, grey no data. Pan, zoom and pinch within a 10 km square; monitors
outside it are hidden (set `SHOW_EDGE_MARKERS` in `docs/lib/map.js` to pin them
to the edge instead).

- A floating **clock button** opens a panel with the **last 90 days** for each
  monitor — one card each, a GitHub-status-style strip of one bar per day (red
  discharged, amber the 48h after, green clear, grey before monitoring began).
- A floating **"i" button** opens an **About** panel.
- Panel state is remembered in the URL as `#timeline` or `#about`.

The original combined timeline-and-map layout is kept at `docs/archive.html`,
frozen, and linked from the About panel.

The map has no library and no tile service. `scripts/build-basemap.js`
(`npm run basemap`) pulls the roads, waterways, suburb names and main road names
for the square once from the OpenStreetMap Overpass API and writes
`docs/basemap.json` (~75 KB); the page draws it as SVG. Suburb labels show at any
zoom, road names once you zoom in. Re-run it whenever you want the streets
refreshed. OSM data © OpenStreetMap contributors.

## Running it

Needs Node 23.4 or newer — `node:sqlite` and `fetch` are both built in, so there
is nothing to install and no `node_modules`.

```bash
npm run poll     # fetch a reading
npm run serve    # http://localhost:8000
npm run dev      # both
npm run basemap  # rebuild docs/basemap.json (the map view's streets)
```

First poll prints how many overflows Wessex operate region-wide and how many
fall inside the Frome catchment.

`docs/data.json` currently holds placeholder data so the page renders before
you've collected anything. Your first poll overwrites it.

On Node 22 you'll need `node --experimental-sqlite poll.js`. Either way SQLite
prints an experimental-feature warning on startup; `--no-warnings` silences it.

## Setting it up

Step-by-step for your machine, GitHub and hosting: see [SETUP.md](SETUP.md).

## Running it continuously

The included GitHub Action polls every 15 minutes and commits the result, so the
repo *is* the database and GitHub Pages serves the page. Point Pages at the
`docs/` folder and there's nothing to host.

Two things to know: scheduled Actions get deprioritised when GitHub is busy, so
15 minutes is a target rather than a guarantee, and the repo grows by a few KB a
day. Neither matters at this scale.

## Naming the overflows

Wessex don't publish site names, only IDs, so the page shows raw IDs until you
label them. Once you know which is which:

```sql
UPDATE monitors SET label = 'Welshmill Lane CSO' WHERE id = 'WW-2140';
```

The `label` column is yours — the poller never overwrites it.

## How overflows get selected

The poller fetches Wessex's **entire** region-wide feed each time, then filters.
Nothing is hardcoded — the Frome IDs are discovered on every poll, so a newly
commissioned monitor appears on the page without you touching anything.

A monitor is kept if either:

1. it sits within `RADIUS_KM` (8km) of the town centre, or
2. it sits within `CATCHMENT_KM` (25km) **and** its receiving watercourse
   name contains one of `WATERCOURSES` — frome, mells, rodden.

The second rule catches upstream outfalls whose spills reach the town. It needs
the outer bound because Wessex also supply Dorset, which has its own River Frome
running through Dorchester to Poole Harbour; an unbounded name match pulls those
in sixty miles away.

Monitors with no coordinates are skipped, and a monitor that stops matching ages
off the page after a week while keeping its history in the database.

Once you know which IDs you actually want, put them in `PIN_TO_IDS` and the
geography is ignored entirely. That's the better end state — it stops the set
drifting under you — but discover them first.

## What the data is and isn't

An EDM records when an overflow starts and stops. Not volume, not water quality.
Monitors are sensitive enough that debris or vegetation can trigger one, so an
activation indicates a discharge rather than confirming it. These figures also
won't match Wessex's annual returns to the Environment Agency, which apply the
regulator's 12/24h counted-spills method to verified data.

If you want to make a public claim about a specific outfall, cross-check the
annual return before you publish.

## Known gap

An event is keyed on its start time. If an overflow spills twice between two
polls, only the second is recorded — your totals are a floor, not an exact
count. At a 15-minute interval against a 15-minute feed this is rare.

The `snapshots` table keeps every raw reading, so you can rebuild the event
history with better logic later without having lost anything.
