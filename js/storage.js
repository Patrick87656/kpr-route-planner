/**
 * storage.js — save/load a route (waypoints + scene tags) to/from a local
 * JSON file. No backend: uses a Blob download for save, and a file input
 * + FileReader for load.
 *
 * Format versions: v1 saved scenes as indices into the route polyline only.
 * v2 also saves each scene's start/end coordinates, because the
 * polyline's point count changes when the route is recalculated and an index
 * alone can then point at the wrong road. v1 files still load. Nothing from
 * the v1 layout was removed (routeCoords, savedAt, routeSummary stay).
 * v3 (current) adds an optional `vehicles` list (names an evaluator can pick
 * from in the car). The key is written only when the list is non-empty, so a
 * route without vehicles is the same as a v2 file apart from formatVersion.
 * v1 and v2 files still load.
 */
window.KPR = window.KPR || {};

KPR.storage = (function () {
  const FORMAT_VERSION = 3;

  function init() {
    document.getElementById("save-route").addEventListener("click", saveRoute);

    const loadBtn = document.getElementById("load-route");
    const loadInput = document.getElementById("load-route-input");
    loadBtn.addEventListener("click", () => loadInput.click());
    loadInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) loadRoute(file);
      loadInput.value = ""; // allow re-selecting the same file later
    });
  }

  /** The object written to a saved file. Pure: everything it needs is passed
   * in. `now` (Date or ms) is optional and only there to make tests stable. */
  function buildSaveData({ name, waypoints, scenes, routeCoords, routeSummary, vehicles, now }) {
    const data = {
      formatVersion: FORMAT_VERSION,
      name,
      savedAt: new Date(now === undefined ? Date.now() : now).toISOString(),
      waypoints,
      routeCoords,
      routeSummary,
      scenes,
    };
    // Only written when there is something to write (same rule as share links).
    const list = KPR.codec.normalizeVehicles(vehicles);
    if (list.length > 0) data.vehicles = list;
    return data;
  }

  /** File-name-safe version of a route name. */
  function safeName(name) {
    const cleaned = String(name == null ? "" : name)
      .replace(/[^a-z0-9\-_ ]/gi, "")
      .trim()
      .slice(0, 80)
      .trim();
    return cleaned || "route";
  }

  function saveRoute() {
    const name = document.getElementById("route-name").value.trim() || "Untitled route";
    // Includes each stop's display name/detail so a reloaded route shows the
    // itinerary right away without repeating the name lookups. Files saved
    // before names existed still load fine (names get looked up then).
    const waypoints = KPR.waypoints.getSaveData();

    if (waypoints.length === 0) {
      alert("Nothing to save yet — add some waypoints first.");
      return;
    }

    const payload = buildSaveData({
      name,
      waypoints,
      scenes: KPR.scenes.getSaveData(),
      routeCoords: KPR.routing.getRouteCoords() || [],
      routeSummary: KPR.routing.getSummary(),
      vehicles: KPR.evaluation.getVehicles(),
    });

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName(name)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const _str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const _inRange = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  /**
   * Turn parsed file data (format v1, v2 or v3) into a clean
   * {name, waypoints, scenes} that is safe to hand to applyRoute. Throws an
   * Error with a user-facing message if it isn't a KPR route at all. Bad
   * stops and scenes are dropped rather than failing the whole load.
   */
  function normalizeFileData(data) {
    const notARoute = () => new Error("File doesn't look like a KPR route (missing waypoints).");
    if (!data || typeof data !== "object" || !Array.isArray(data.waypoints)) throw notARoute();

    const waypoints = data.waypoints
      .filter((w) => w && typeof w === "object" && Number.isFinite(w.lat) && Number.isFinite(w.lng))
      .map((w) => ({ lat: w.lat, lng: w.lng, name: _str(w.name), detail: _str(w.detail) }));
    if (waypoints.length === 0) throw notARoute();

    const rawScenes = Array.isArray(data.scenes) ? data.scenes : [];
    const scenes = rawScenes
      .filter((s) => s && typeof s === "object")
      .map((s) => {
        const known = Object.prototype.hasOwnProperty.call(KPR.scenes.DEFAULT_SCENE_COLORS, s.type);
        const type = known ? s.type : "Custom";
        const rec = {
          type,
          typeLabel: type === "Custom" ? _str(s.typeLabel) : type,
          label: _str(s.label),
          notes: _str(s.notes),
        };
        if (Number.isFinite(s.startIdx)) rec.startIdx = s.startIdx;
        if (Number.isFinite(s.endIdx)) rec.endIdx = s.endIdx;
        if (_inRange(s.startLat, s.startLng) && _inRange(s.endLat, s.endLng)) {
          rec.startLat = s.startLat;
          rec.startLng = s.startLng;
          rec.endLat = s.endLat;
          rec.endLng = s.endLng;
        }
        return rec;
      });

    const route = { name: _str(data.name), waypoints, scenes };
    // Optional (format v3). Anything that is not a usable list is ignored.
    const vehicles = KPR.codec.normalizeVehicles(data.vehicles);
    if (vehicles.length > 0) route.vehicles = vehicles;
    return route;
  }

  /**
   * Put a normalized route (see normalizeFileData) on the map: stops, then
   * ONE route calculation, then scenes snapped onto that fresh route. Shared
   * by file Load and share links. Returns {ok:true, scenesLoaded,
   * scenesSkipped}, or {ok:false, reason:"route"} when the stops are placed
   * but no route could be calculated.
   */
  async function applyRoute(route) {
    document.getElementById("route-name").value = route.name || "Untitled route";
    // The vehicle list belongs to the route: a route without one clears the
    // box (it must not keep the previous route's vehicles).
    KPR.evaluation.setVehicles(route.vehicles || []);
    // quiet: don't recalculate once per stop; we do it once below.
    KPR.waypoints.loadFrom(route.waypoints, { quiet: true });
    await KPR.routing.recalculate();

    const coords = KPR.routing.getRouteCoords();
    if (!coords) {
      KPR.app.refreshLists();
      return { ok: false, reason: "route" };
    }

    let scenesLoaded = 0;
    let scenesSkipped = 0;
    if (route.scenes && route.scenes.length > 0) {
      const result = KPR.scenes.loadFrom(route.scenes);
      scenesLoaded = result.loaded;
      scenesSkipped = result.skipped;
    }
    KPR.app.refreshLists();

    // Bounds seeded with the first point as both corners (see routing.js
    // _drawLine for why a single-array LngLatBounds argument breaks).
    const first = [coords[0].lng, coords[0].lat];
    const bounds = coords.reduce(
      (b, c) => b.extend([c.lng, c.lat]),
      new mapboxgl.LngLatBounds(first, first)
    );
    KPR.map.getMap().fitBounds(bounds, { padding: KPR.map.getFitPadding() });

    return { ok: true, scenesLoaded, scenesSkipped };
  }

  function loadRoute(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        const route = normalizeFileData(data);
        const result = await applyRoute(route);
        if (!result.ok) {
          alert("The stops loaded, but the route could not be calculated. Check your connection and try Recalculate.");
        }
      } catch (err) {
        console.error("Failed to load route:", err);
        alert(`Could not load route file: ${err.message}`);
      }
    };
    reader.onerror = () => alert("Could not read that file.");
    reader.readAsText(file);
  }

  return { init, saveRoute, loadRoute, buildSaveData, normalizeFileData, applyRoute, safeName };
})();
