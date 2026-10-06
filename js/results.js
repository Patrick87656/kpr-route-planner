/**
 * results.js — opening a results link (#res=...) and the read-only Results
 * view it leads to.
 *
 * What an evaluator sends from the car is a link that carries the route and a
 * Good / Bad mark per scene (see route-codec.js). Opening it here loads the
 * route through the same path as a shared route link (KPR.storage.applyRoute),
 * then switches the planner into "results mode":
 *   - every scene segment is drawn green (good), red (bad) or grey (not
 *     rated) by an OVERLAY of two GL layers above the scene layers,
 *   - every scene pin gets a thumbs badge,
 *   - the planner panel contents are replaced by the Results panel (route,
 *     vehicle, evaluator, date, counts, scene list) with Export CSV, Open as
 *     editable route and Close results.
 *
 * Nothing here depends on the beta switch: anyone can open a results link.
 *
 * The overlay is purely additive. It has its own source and layers, never
 * touches the scene layers' paint, and is removed on exit, so the normal
 * scene colors are simply visible again afterwards. A style switch
 * (Satellite) wipes all GL layers, so the overlay is rebuilt by a style-reload
 * callback registered when this file loads.
 *
 * Ratings line up with scenes by `scene.srcIndex` (the scene's position in
 * the link), never by its position in KPR.scenes.getAll(): scenes that could
 * not be placed on the route are skipped there.
 *
 * Everything that comes out of the link is attacker-controlled text. It only
 * reaches the page through textContent / createElement; no HTML strings are
 * built here, and colors come from fixed constants.
 */
window.KPR = window.KPR || {};

KPR.results = (function () {
  const SOURCE_ID = "kpr-res-src";
  const CASING_ID = "kpr-res-casing";
  const LAYER_ID = "kpr-res-layer";

  // Fixed palette. Never built from link data.
  const GOOD = "#22c55e";
  const BAD = "#ef4444";
  const NONE = "#9ca3af";

  const CSV_HEADER = [
    "Route",
    "Vehicle",
    "Evaluator",
    "Drive date/time",
    "Simulated",
    "Scene #",
    "Scene type",
    "Scene label",
    "Rating",
    "Rated at",
    "Latitude",
    "Longitude",
  ];

  // Fixed messages. Link content is never echoed into an alert.
  const BAD_LINK_MSG = "That link doesn't look like KPR results. Ask the sender to share them again.";
  const UNSUPPORTED_MSG = "This browser can't open this link. Try opening it in Safari or Chrome.";
  const DRIVE_MSG = "End the drive first, then open the results link again.";
  const CONFIRM_MSG = "Open these results? They will replace the stops and scenes you have now.";
  const MAP_MSG = "The map is still loading. Reload the page and open the link again.";
  const ROUTE_MSG =
    "The route in these results couldn't be calculated. Check your connection and open the link again.";
  const FAILED_MSG = "Something went wrong while opening the results.";

  let active = false;
  let data = null; // the validated results while in results mode
  let loading = false;
  let wired = false;

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------
  // Rating lookups
  // ---------------------------------------------------------------------

  /** "good" | "bad" | null for the scene at `srcIndex` in the link. */
  function _ratingAt(srcIndex) {
    if (!data || !Number.isInteger(srcIndex) || srcIndex < 0 || srcIndex >= data.ratings.length) return null;
    const r = data.ratings[srcIndex];
    return r === "good" || r === "bad" ? r : null;
  }

  /** The live (placed) scene that came from link position `srcIndex`, or
   * undefined when it could not be placed on the route. */
  function _liveScene(srcIndex) {
    return KPR.scenes.getAll().find((s) => s.srcIndex === srcIndex);
  }

  // ---------------------------------------------------------------------
  // Map overlay
  // ---------------------------------------------------------------------

  /** One LineString per PLACED scene, with r = "g" | "b" | "n". */
  function _buildGeoJson() {
    const features = [];
    KPR.scenes.getAll().forEach((scene) => {
      if (!Array.isArray(scene.segment) || scene.segment.length < 2) return;
      const rating = _ratingAt(scene.srcIndex);
      features.push({
        type: "Feature",
        properties: { r: rating === "good" ? "g" : rating === "bad" ? "b" : "n" },
        geometry: {
          type: "LineString",
          coordinates: scene.segment.map((c) => [c.lng, c.lat]),
        },
      });
    });
    return { type: "FeatureCollection", features };
  }

  /** Add (or refresh) the overlay source and layers. Safe to call any number
   * of times, and does nothing while a style is still loading (the style
   * reload callback calls it again once it is ready). Layers are added with
   * no `beforeId`, so they draw above everything already on the map,
   * including the scene layers. */
  function _ensureLayers() {
    if (!active || !data) return;
    if (!KPR.map.isStyleReady()) return;
    const map = KPR.map.getMap();
    const geojson = _buildGeoJson();

    const source = map.getSource(SOURCE_ID);
    if (source) source.setData(geojson);
    else map.addSource(SOURCE_ID, { type: "geojson", data: geojson });

    if (!map.getLayer(CASING_ID)) {
      map.addLayer({
        id: CASING_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 13, "line-opacity": 0.9, "line-emissive-strength": 1 },
      });
    }
    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["match", ["get", "r"], "g", GOOD, "b", BAD, NONE],
          "line-width": 10,
          "line-opacity": 1,
          "line-emissive-strength": 1,
        },
      });
    }
  }

  function _removeLayers() {
    const map = KPR.map && KPR.map.getMap();
    if (!map) return;
    try {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getLayer(CASING_ID)) map.removeLayer(CASING_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    } catch (err) {
      // Mid style switch Mapbox refuses edits; the new style starts without
      // the overlay anyway, and the reload callback no longer adds it.
      console.warn("Could not remove the results overlay:", err);
    }
  }

  /** Move the overlay back to the top of the stack. */
  function _raiseLayers() {
    if (!active || !KPR.map.isStyleReady()) return;
    const map = KPR.map.getMap();
    if (map.getLayer(CASING_ID)) map.moveLayer(CASING_ID);
    if (map.getLayer(LAYER_ID)) map.moveLayer(LAYER_ID);
  }

  /** Style reload: a Satellite switch wipes every GL layer, so put the
   * overlay back. scenes.js registers its own callback later than this one
   * (in its init(), after this file has loaded), so on the same style.load
   * its scene layers are re-added AFTER ours and would end up on top. Once
   * all the callbacks have run (a microtask later), raise the overlay again. */
  function _onStyleReload() {
    if (!active) return;
    _ensureLayers();
    Promise.resolve().then(_raiseLayers);
  }

  // Registered once, when the file loads (map.js is always loaded before
  // this file; the unit tests load it without a map).
  if (KPR.map && typeof KPR.map.onStyleReload === "function") KPR.map.onStyleReload(_onStyleReload);

  // ---------------------------------------------------------------------
  // Pin badges
  // ---------------------------------------------------------------------

  function _setBadges() {
    KPR.scenes.getAll().forEach((scene) => {
      KPR.scenes.setRatingBadge(scene.id, _ratingAt(scene.srcIndex) || "none");
    });
  }

  function _clearBadges() {
    KPR.scenes.getAll().forEach((scene) => KPR.scenes.setRatingBadge(scene.id, null));
  }

  // ---------------------------------------------------------------------
  // Results panel
  // ---------------------------------------------------------------------

  function _countRatings(ratings) {
    let good = 0;
    let bad = 0;
    ratings.forEach((r) => {
      if (r === "good") good++;
      else if (r === "bad") bad++;
    });
    return { good, bad, none: ratings.length - good - bad };
  }

  function _two(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** Local "YYYY-MM-DD HH:MM" from Date getters. */
  function _formatLocal(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${_two(d.getMonth() + 1)}-${_two(d.getDate())} ${_two(d.getHours())}:${_two(d.getMinutes())}`;
  }

  function _el(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  /** One row of the scene list: a <button> so it works by keyboard too. */
  function _buildSceneRow(scene, rating, index, placed) {
    const li = document.createElement("li");
    const btn = _el("button", "results-scene");
    btn.type = "button";

    // The same thumbs badge the map pins use, static here, and hidden from
    // assistive tech because the rating is also written out as a word.
    const badge = KPR.scenes.buildRatingBadge(rating || "none");
    if (badge) {
      badge.removeAttribute("role");
      badge.removeAttribute("aria-label");
      badge.setAttribute("aria-hidden", "true");
      btn.appendChild(badge);
    }

    const text = _el("span", "rs-text");
    text.appendChild(_el("span", "rs-type", scene.typeLabel));
    text.appendChild(_el("span", "rs-label", scene.label || `Scene ${index + 1}`));
    text.appendChild(_el("span", "rs-rating", rating === "good" ? "Good" : rating === "bad" ? "Bad" : "Not rated"));
    if (!placed) text.appendChild(_el("span", "rs-unplaced", "Not shown on map"));
    btn.appendChild(text);

    btn.addEventListener("click", () => _zoomToScene(index));
    li.appendChild(btn);
    return li;
  }

  function _fillPanel() {
    const counts = _countRatings(data.ratings);
    $("results-route").textContent = data.route.name || "Untitled route";
    $("results-vehicle").textContent = data.vehicle || "Not recorded";
    $("results-evaluator").textContent = data.evaluator || "Not recorded";
    $("results-when").textContent = new Date(data.startedAt).toLocaleString();
    $("results-test-banner").classList.toggle("hidden", !data.simulated);
    $("results-count-good").textContent = `${counts.good} good`;
    $("results-count-bad").textContent = `${counts.bad} bad`;
    $("results-count-none").textContent = `${counts.none} not rated`;

    const list = $("results-scenes");
    list.replaceChildren();
    let unplaced = 0;
    data.route.scenes.forEach((scene, i) => {
      const placed = !!_liveScene(i);
      if (!placed) unplaced++;
      list.appendChild(_buildSceneRow(scene, data.ratings[i], i, placed));
    });

    const note = $("results-note");
    if (data.route.scenes.length === 0) {
      note.textContent = "This route has no scenes.";
    } else if (unplaced > 0) {
      note.textContent =
        `${unplaced} scene${unplaced === 1 ? " couldn't" : "s couldn't"} be placed on the route, ` +
        "so " + (unplaced === 1 ? "it isn't" : "they aren't") + " drawn on the map. " +
        (unplaced === 1 ? "It is" : "They are") + " still listed with the rating.";
    } else {
      note.textContent = "";
    }
    note.classList.toggle("hidden", note.textContent === "");
  }

  /** Fly to a scene: its drawn segment when it was placed, else the start
   * and end coordinates written in the link. */
  function _zoomToScene(index) {
    if (!active || !data) return;
    const map = KPR.map.getMap();
    const live = _liveScene(index);
    let points;
    if (live && Array.isArray(live.segment) && live.segment.length > 0) {
      points = live.segment.map((c) => [c.lng, c.lat]);
    } else {
      const sc = data.route.scenes[index];
      if (!sc) return;
      points = [
        [sc.startLng, sc.startLat],
        [sc.endLng, sc.endLat],
      ];
    }
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    points.forEach(([lng, lat]) => {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    });
    // On a phone a fully open sheet covers the map; bring it down first.
    if (KPR.sheet && typeof KPR.sheet.lowerForMap === "function") KPR.sheet.lowerForMap();
    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: KPR.map.getFitPadding(), maxZoom: 17 }
    );
    if (live && live.popup && live.pinMarker) live.popup.setLngLat(live.pinMarker.getLngLat()).addTo(map);
  }

  // ---------------------------------------------------------------------
  // Enter / exit
  // ---------------------------------------------------------------------

  function isActive() {
    return active;
  }

  /** Switch into results mode with validated results (see
   * KPR.codec.decodeResults). The route must already be loaded. */
  function enter(results) {
    if (active) return;
    active = true;
    data = results;
    document.body.classList.add("results-mode");
    KPR.app.setMode("results");
    KPR.waypoints.setLocked(true);
    _setBadges();
    _fillPanel();
    $("results-view").classList.remove("hidden");
    $("results-view").scrollTop = 0;
    _ensureLayers();
    // Screen readers and keyboard users land on the title.
    try {
      $("results-route").focus({ preventScroll: true });
    } catch (err) {
      // Focus is a nicety.
    }
  }

  /** Leave results mode. keepRoute (default true) leaves the loaded route in
   * the planner as an ordinary editable route; keepRoute:false also clears
   * the stops and scenes. */
  function exit(opts) {
    if (!active) return;
    const keepRoute = !opts || opts.keepRoute !== false;
    _removeLayers();
    _clearBadges();
    active = false;
    data = null;
    document.body.classList.remove("results-mode");
    $("results-view").classList.add("hidden");
    $("results-scenes").replaceChildren();
    KPR.app.setMode("waypoint");
    KPR.waypoints.setLocked(false);
    if (!keepRoute) KPR.waypoints.clearAll();
  }

  // ---------------------------------------------------------------------
  // Opening a results link
  // ---------------------------------------------------------------------

  /**
   * If the address holds a results link, decode and validate it, then load
   * the route and show the results. Order: validate first, refuse while a
   * drive is running, confirm before replacing stops, wait for the map style,
   * then applyRoute (the same path route links use). The hash is removed in
   * every outcome.
   */
  async function loadFromHash() {
    if (loading) return;
    let encoded;
    try {
      encoded = KPR.codec.parseResultsHash(location.hash);
    } catch (err) {
      KPR.share.clearHash();
      alert(BAD_LINK_MSG);
      return;
    }
    if (encoded === null) return; // some other hash, not ours

    loading = true;
    const status = $("route-status");
    const previousStatus = status.textContent;
    let applied = false;
    try {
      status.textContent = "Opening results…";

      let results;
      try {
        results = await KPR.codec.decodeResults(encoded);
      } catch (err) {
        alert(err && err.code === "unsupported" ? UNSUPPORTED_MSG : BAD_LINK_MSG);
        return;
      }

      if (KPR.drive && KPR.drive.isActive()) {
        alert(DRIVE_MSG);
        return;
      }

      if (KPR.waypoints.count() > 0 && !confirm(CONFIRM_MSG)) return;

      if (!(await KPR.map.whenStyleReady())) {
        alert(MAP_MSG);
        return;
      }

      // Already looking at other results: leave that view quietly first.
      if (active) exit({ keepRoute: true });

      applied = true;
      const result = await KPR.storage.applyRoute(results.route);
      if (!result.ok) {
        alert(ROUTE_MSG);
        return;
      }
      enter(results);
    } catch (err) {
      console.error("Failed to open results:", err);
      alert(applied ? FAILED_MSG : BAD_LINK_MSG);
      if (active) {
        try {
          exit({ keepRoute: true });
        } catch (err2) {
          // Already reported above.
        }
      }
    } finally {
      // Routing writes its own status once a route is applied; otherwise put
      // back whatever the status said before.
      if (!applied) status.textContent = previousStatus;
      KPR.share.clearHash();
      loading = false;
    }
  }

  // ---------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------

  /** A text cell: always double-quoted, inner quotes doubled, and a leading
   * = + - @ TAB or CR neutralized with a single quote so a spreadsheet can't
   * read it as a formula. */
  function _textCell(value) {
    let s = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /** A number cell: unquoted, never prefixed (a leading minus is just a
   * negative longitude). Only finite numbers from the validated link get
   * here; anything else is left empty. */
  function _numberCell(n) {
    return typeof n === "number" && Number.isFinite(n) ? String(n) : "";
  }

  /**
   * The whole CSV for validated results: BOM, header, one row per scene in
   * the link (so unplaced scenes are included), CRLF after every line.
   */
  function buildCsv(results) {
    const lines = [CSV_HEADER.join(",")];
    const when = _formatLocal(results.startedAt);
    results.route.scenes.forEach((scene, i) => {
      const rating = results.ratings[i];
      lines.push(
        [
          _textCell(results.route.name),
          _textCell(results.vehicle),
          _textCell(results.evaluator),
          _textCell(when),
          _textCell(results.simulated ? "Yes" : "No"),
          _numberCell(i + 1),
          _textCell(scene.typeLabel),
          _textCell(scene.label),
          _textCell(rating === "good" ? "Good" : rating === "bad" ? "Bad" : "Not rated"),
          "", // "Rated at": a results link carries no per-rating time
          _numberCell(scene.startLat),
          _numberCell(scene.startLng),
        ].join(",")
      );
    });
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }

  /** Download the CSV of the results on screen (same Blob + temporary
   * link approach as Save). */
  function exportCsv() {
    if (!active || !data) return;
    const blob = new Blob([buildCsv(data)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${KPR.storage.safeName(data.route.name)}-results.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  function init() {
    if (wired) return;
    wired = true;
    $("results-export").addEventListener("click", exportCsv);
    $("results-edit").addEventListener("click", () => exit({ keepRoute: true }));
    $("results-close").addEventListener("click", () => exit({ keepRoute: false }));
    window.addEventListener("hashchange", loadFromHash);
  }

  return {
    init,
    loadFromHash,
    isActive,
    enter,
    exit,
    buildCsv,
    exportCsv,
    // Exposed for the unit tests.
    handleStyleReload: _onStyleReload,
    ensureLayers: _ensureLayers,
    LAYER_IDS: { source: SOURCE_ID, casing: CASING_ID, line: LAYER_ID },
    COLORS: { good: GOOD, bad: BAD, none: NONE },
  };
})();
