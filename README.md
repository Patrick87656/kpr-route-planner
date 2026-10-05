# KPR Route Planner — Mapbox edition

This is the **Mapbox GL JS** variant of the KPR Route Planner. Same tool,
same features as the free Leaflet/OpenStreetMap version in the sibling
`KPR Route Planner` folder, but rendered with Mapbox's GPU vector-tile maps:

- Mapbox GL JS for the map (vector tiles, smooth zoom, polished default
  styles — Streets / Satellite Streets toggle)
- Mapbox **Directions API** for road-snapped routing, in fixed waypoint
  order (there's no "optimize my stops" option on this endpoint at all —
  coordinates are always visited in the order given)
- Mapbox **Geocoding API** (v5, includes POI data) for place/business/
  landmark search — finds named places the OSM-based geocoders miss

The free Leaflet version and the parked Google Maps version are both kept
intact in their own folders.

## Requirements

A Mapbox access token. Get one free at
https://account.mapbox.com/access-tokens/ — **the free tier (50,000 map
loads/month, generous geocoding/directions allotment) does not require a
credit card to start.**

## Setup

1. Copy `config.local.js.example` to `config.local.js`.
2. Paste your token into it: `window.KPR_MAPBOX_TOKEN = "pk.…";`
3. `config.local.js` is gitignored and never committed.

If no token is present, the app shows a message in the map area instead of
letting Mapbox fail silently.

## Running it

Serve the folder locally (Mapbox GL won't run from a `file://` page):

```powershell
python -m http.server 8000
# then open http://localhost:8000
```

## Sharing a route

Tap **Share** (between **Save** and **Load**, needs at least 2 stops) to get
a QR code and a link for the current route. Share is on PC and iPad screens;
it is hidden on phone-sized screens, where the footer is just **Save** and
**Load** (routes are planned on a PC, and opening a shared link works fine on
a phone). Scan the QR code with a phone
camera, or use **Copy link** / **Send…** (the system share sheet, where the
device has one). Opening the link starts the app with the route, stops and
scenes already loaded; if stops are already on the map it asks before
replacing them.

**Save** and **Load** (the JSON file) still work exactly as before and stay
the easiest way to move routes onto the in-car iPads. On iPhone and iPad a
link opens in Safari, not in the installed home-screen app.

The route travels inside the link itself (the part after `#`), so no server
ever receives it, and the QR code is drawn on the device. See the privacy
note in [DEPLOY.md](DEPLOY.md#sharing-a-route).

The QR code is made by a vendored copy of Project Nayuki's QR Code
generator (no CDN): `js/vendor/qrcodegen-v1.8.0-es5.js`, from
https://github.com/nayuki/QR-Code-generator/releases/tag/v1.8.0 (v1.8.0,
commit `720f62bddb7226106071d4728c292cb1df519ceb`), MIT License.

## Phones, iPads, and hosting

The app is an installable PWA (`manifest.webmanifest`, `service-worker.js`,
`icons/`). It has a bottom-sheet layout on phones and works with touch in
Drive mode. Live GPS needs `https://`, so for in-vehicle use it's hosted on
GitHub Pages: see **[DEPLOY.md](DEPLOY.md)**. The workflow in
`.github/workflows/deploy-pages.yml` publishes it on every push to `main`.

## Project layout

Same as the Leaflet version. The map-library-specific logic lives in
`js/map.js`, `js/waypoints.js`, `js/routing.js`, `js/scenes.js`, and
`js/search.js`; `js/storage.js` and `js/app.js` are essentially shared
logic (with Mapbox-specific init timing in `app.js`/`index.html`).

Sharing lives in `js/route-codec.js` (builds and strictly validates the link
payload) and `js/share.js` (Share button, dialog, opening links). The
vendored QR library is in `js/vendor/`. Automated tests are in `tests/`.

Scene route segments are rendered as individual GL sources/layers (one pair
per scene) rather than Leaflet polyline objects — Mapbox GL draws vector
data via `addSource`/`addLayer`, not per-feature draw calls. These are
automatically rebuilt after a style change (the street/satellite toggle
wipes custom layers — see `KPR.map.onStyleReload` in `map.js`).

## Running the tests

No install needed. From this folder:

```powershell
powershell -NoProfile -File tests\run-tests.ps1
```

It opens tests/run.html in headless Edge (or Chrome) and prints
RESULT: PASS or RESULT: FAIL. The tests don't use Mapbox or the network.
You can also open tests/run.html in a browser to see the report.
