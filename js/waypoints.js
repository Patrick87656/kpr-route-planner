/**
 * waypoints.js — ordered waypoint placement and management.
 *
 * The core guarantee this whole app exists for: waypoints are stored and
 * routed in EXACTLY the order the user placed them. Nothing in this module
 * (or routing.js) ever sorts, nearest-neighbors, or "optimizes" that order.
 * Reordering only ever happens via explicit user action (drag-to-reposition
 * is a position edit, not a resequence; there is no resequence feature in
 * v1).
 *
 * Mapbox GL port: `mapboxgl.Marker` accepts an arbitrary DOM element (same
 * as Leaflet's `L.divIcon`), so the numbered-badge HTML/CSS is reused as-is.
 * Click/drag coordinates come through as `lngLat` (not `latlng`), and
 * right-click is wired directly on the marker's DOM element since
 * `mapboxgl.Marker` has no built-in `contextmenu` event of its own.
 *
 * Stop names: each waypoint gets a human-readable `name` (e.g. "West 12 Mile
 * Road") and `detail` (e.g. "Farmington Hills, Michigan") for the itinerary.
 * Waypoints added from a search result already have them; clicked or
 * dragged waypoints are looked up with the Search Box API `/reverse`
 * endpoint. Lookups run one at a time with a short gap, so loading a saved
 * route with many unnamed stops stays under Mapbox's 10 requests/second
 * limit.
 */
window.KPR = window.KPR || {};

KPR.waypoints = (function () {
  const REVERSE_URL = "https://api.mapbox.com/search/searchbox/v1/reverse";
  const LOOKUP_GAP_MS = 150;

  // Each waypoint: { id, lat, lng, name, detail, marker }
  // name === null means "lookup pending"; "" means "lookup found nothing".
  let waypoints = [];
  let nextId = 1;
  let onChangeCallback = null;
  let suppressNotify = false; // set only while loadFrom runs with { quiet: true }

  const lookupQueue = [];
  let lookupRunning = false;

  function init(onChange) {
    onChangeCallback = onChange;
    const map = KPR.map.getMap();

    map.on("click", (e) => {
      if (KPR.app.getMode() !== "waypoint") return;
      addWaypoint(e.lngLat.lat, e.lngLat.lng);
    });

    document.getElementById("clear-waypoints").addEventListener("click", () => {
      if (waypoints.length === 0) return;
      const ok = window.confirm("Remove all waypoints and the current route? This cannot be undone.");
      if (!ok) return;
      clearAll();
    });
  }

  function _buildBadgeElement(number) {
    const el = document.createElement("div");
    el.className = "waypoint-marker-wrap";
    const badge = document.createElement("div");
    badge.className = "waypoint-marker";
    badge.textContent = String(number);
    el.appendChild(badge);
    return el;
  }

  /**
   * Adds a waypoint at the end of the route. `meta` is optional; pass
   * `{ name, detail }` when the place is already known (e.g. from search or
   * a saved file) to skip the reverse lookup.
   */
  function addWaypoint(lat, lng, meta) {
    const map = KPR.map.getMap();
    const id = nextId++;

    const el = _buildBadgeElement(waypoints.length + 1);
    const marker = new mapboxgl.Marker({ element: el, draggable: true })
      .setLngLat([lng, lat])
      .addTo(map);

    const hasName = meta && typeof meta.name === "string" && meta.name !== "";
    const wp = {
      id,
      lat,
      lng,
      name: hasName ? meta.name : null,
      detail: hasName ? meta.detail || "" : "",
      marker,
    };
    waypoints.push(wp);

    marker.on("dragend", () => {
      const pos = marker.getLngLat();
      wp.lat = pos.lat;
      wp.lng = pos.lng;
      // Moved somewhere else, so the old name no longer applies.
      wp.name = null;
      wp.detail = "";
      _queueLookup(wp);
      _notifyChange();
    });

    marker.getElement().addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // Results mode is read-only: right-click must not remove a stop.
      if (KPR.app.getMode() === "results") return;
      removeWaypoint(id);
    });

    if (!hasName) _queueLookup(wp);

    _renumberMarkers();
    _notifyChange();
    return wp;
  }

  function removeWaypoint(id) {
    const idx = waypoints.findIndex((w) => w.id === id);
    if (idx === -1) return;
    waypoints[idx].marker.remove();
    waypoints.splice(idx, 1);
    _renumberMarkers();
    _notifyChange();
  }

  function clearAll() {
    waypoints.forEach((w) => w.marker.remove());
    waypoints = [];
    lookupQueue.length = 0;
    _notifyChange();
  }

  function _renumberMarkers() {
    waypoints.forEach((w, i) => {
      const badge = w.marker.getElement().querySelector(".waypoint-marker");
      if (!badge) return;
      badge.textContent = String(i + 1);
      // The final stop gets the inverted "finish" look, matching the
      // itinerary. Only when there's an actual route (2+ stops).
      badge.classList.toggle("is-last", waypoints.length > 1 && i === waypoints.length - 1);
    });
  }

  // ---- reverse lookup ----------------------------------------------------

  function _queueLookup(wp) {
    if (!lookupQueue.includes(wp)) lookupQueue.push(wp);
    if (!lookupRunning) _drainLookups();
  }

  async function _drainLookups() {
    lookupRunning = true;
    while (lookupQueue.length > 0) {
      const wp = lookupQueue.shift();
      // Skip waypoints that were deleted or already named while queued.
      if (!waypoints.includes(wp) || wp.name !== null) continue;
      const requestedAt = { lat: wp.lat, lng: wp.lng };
      const result = await _reverseLookup(requestedAt.lat, requestedAt.lng);
      // Ignore the answer if the marker was dragged again in the meantime;
      // the drag already queued a fresh lookup.
      if (wp.lat === requestedAt.lat && wp.lng === requestedAt.lng && waypoints.includes(wp)) {
        wp.name = result.name;
        wp.detail = result.detail;
        _notifyChange({ namesOnly: true });
      }
      await new Promise((r) => setTimeout(r, LOOKUP_GAP_MS));
    }
    lookupRunning = false;
  }

  async function _reverseLookup(lat, lng) {
    try {
      const url =
        `${REVERSE_URL}?longitude=${lng}&latitude=${lat}` +
        `&types=street,address&limit=1` +
        `&access_token=${encodeURIComponent(window.KPR_MAPBOX_TOKEN)}`;
      const resp = await fetch(url);
      if (!resp.ok) return { name: "", detail: "" };
      const data = await resp.json();
      const f = data.features && data.features[0];
      if (!f) return { name: "", detail: "" };
      // Mapbox often returns "37471 West 12 Mile Road" even for a street
      // lookup. For a driving itinerary the road name is what matters, so
      // drop the leading house number.
      const raw = f.properties.name || "";
      const name = raw.replace(/^\d+[A-Za-z]?\s+/, "");
      const detail = (f.properties.place_formatted || "").replace(/,?\s*United States$/, "");
      return { name, detail };
    } catch (err) {
      console.warn("Waypoint name lookup failed:", err);
      return { name: "", detail: "" };
    }
  }

  // ---- change notifications / accessors ----------------------------------

  /** `info.namesOnly` means only display names changed (no position or
   * order change), so listeners can skip recalculating the route. */
  function _notifyChange(info) {
    if (suppressNotify) return;
    if (onChangeCallback) onChangeCallback(info || {});
  }

  /** Returns waypoints in their fixed user-defined order, as plain {lat,lng}. */
  function getOrderedLatLngs() {
    return waypoints.map((w) => ({ lat: w.lat, lng: w.lng }));
  }

  function getAll() {
    return waypoints;
  }

  function count() {
    return waypoints.length;
  }

  /** Drive mode locks stops in place so a stray drag in the car can't change
   * the route mid-drive. */
  function setLocked(locked) {
    waypoints.forEach((w) => w.marker.setDraggable(!locked));
  }

  /** Data to write into a saved route file. */
  function getSaveData() {
    return waypoints.map((w) => ({ lat: w.lat, lng: w.lng, name: w.name || "", detail: w.detail || "" }));
  }

  /** Rebuild from saved data (used by storage.js on load). Replaces current
   * state. Older saved files have no names; those get looked up. */
  function loadFrom(points, opts) {
    clearAll();
    // Each addWaypoint notifies, and every notification makes the app
    // recalculate the route (one Directions request per stop). With
    // `quiet` the caller recalculates once itself after all stops are in.
    suppressNotify = !!(opts && opts.quiet);
    try {
      points.forEach((p) => addWaypoint(p.lat, p.lng, { name: p.name, detail: p.detail }));
    } finally {
      suppressNotify = false;
    }
  }

  return {
    init,
    addWaypoint,
    removeWaypoint,
    clearAll,
    getOrderedLatLngs,
    getAll,
    count,
    getSaveData,
    loadFrom,
    setLocked,
  };
})();
