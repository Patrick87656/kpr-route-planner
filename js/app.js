/**
 * app.js — bootstraps the app: wires up map/waypoints/routing/scenes/storage,
 * handles mode switching (Waypoints vs Tag Scene), and keeps the floating
 * panel (itinerary timeline, scene cards, legend) in sync with state.
 */
window.KPR = window.KPR || {};

KPR.app = (function () {
  let mode = "waypoint";

  const MODE_HINTS = {
    waypoint:
      "Click the map to add stops in order. Drag a stop to move it, right-click to remove it. " +
      "If the route takes a road you don't want, add a stop on the road you do want.",
    scene: "Click two points along the route to mark the start and end of a scene.",
  };

  function getMode() {
    return mode;
  }

  /** Modes: "waypoint" and "scene" (planner), or "drive" (Drive mode, where
   * map clicks don't add stops or scenes). */
  function _setMode(newMode) {
    mode = newMode;
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === newMode);
    });
    if (MODE_HINTS[newMode]) document.getElementById("mode-hint").textContent = MODE_HINTS[newMode];
    // Crosshair cursor while tagging, so it's obvious clicks do something
    // different than adding stops.
    const canvas = KPR.map.getMap().getCanvas();
    canvas.style.cursor = newMode === "scene" ? "crosshair" : "";
  }

  function _wireModeButtons() {
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => _setMode(btn.dataset.mode));
    });
  }

  function _wireRecalcButton() {
    document.getElementById("recalc-route").addEventListener("click", () => {
      KPR.routing.recalculate();
    });
  }

  function _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  /** Light tint of a hex color, for the scene tag pills in the itinerary. */
  function _tint(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return `rgba(214, 0, 47, ${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  /**
   * For each stop, which scenes start on the leg leaving that stop. Scenes
   * are stored as index ranges into the route geometry, so we find where
   * each stop sits along the route (searching forward from the previous
   * stop, which keeps loops and out-and-back routes in the right order) and
   * bucket each scene by its start index.
   */
  function _scenesByLeg(waypoints) {
    const route = KPR.routing.getRouteCoords();
    const scenes = KPR.scenes.getAll();
    const byLeg = waypoints.map(() => []);
    if (!route || route.length === 0 || scenes.length === 0 || waypoints.length < 2) return byLeg;

    const stopIdx = [];
    let from = 0;
    waypoints.forEach((wp) => {
      let best = from;
      let bestD = Infinity;
      for (let i = from; i < route.length; i++) {
        const d = (route[i].lat - wp.lat) ** 2 + (route[i].lng - wp.lng) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      stopIdx.push(best);
      from = best;
    });

    scenes.forEach((s) => {
      for (let leg = stopIdx.length - 2; leg >= 0; leg--) {
        if (s.startIdx >= stopIdx[leg]) {
          byLeg[leg].push(s);
          return;
        }
      }
      byLeg[0].push(s);
    });
    return byLeg;
  }

  function _refreshWaypointList() {
    const list = document.getElementById("waypoint-list");
    const all = KPR.waypoints.getAll();
    document.getElementById("waypoint-count").textContent = `(${all.length})`;
    document.getElementById("stat-stops").textContent = String(all.length);
    document.getElementById("itinerary-empty").classList.toggle("hidden", all.length > 0);

    const byLeg = _scenesByLeg(all);
    list.innerHTML = "";

    all.forEach((wp, i) => {
      const isLast = all.length > 1 && i === all.length - 1;
      const pending = wp.name === null;
      const name = pending ? "Locating…" : wp.name || `${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}`;
      const detail = !pending && wp.name ? wp.detail : "";
      const tags = byLeg[i]
        .map(
          (s) =>
            `<span class="stop-tag" style="background:${_tint(s.color, 0.2)};color:${_escapeHtml(s.color)}">${_escapeHtml(s.typeLabel)}</span>`
        )
        .join("");

      const li = document.createElement("li");
      li.innerHTML = `
        <span class="stop-badge${isLast ? " is-last" : ""}">${isLast ? "&#9873;" : i + 1}</span>
        <div class="stop-text">
          <div class="stop-name${pending ? " pending" : ""}" title="${_escapeHtml(name)}">${_escapeHtml(name)}</div>
          ${detail ? `<div class="stop-detail">${_escapeHtml(detail)}</div>` : ""}
          ${tags ? `<div class="stop-tags">${tags}</div>` : ""}
        </div>
        <button class="remove-btn" title="Remove stop" aria-label="Remove stop ${i + 1}">&times;</button>
      `;
      li.querySelector(".remove-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        KPR.waypoints.removeWaypoint(wp.id);
      });
      // Clicking a stop centers the map on it.
      li.querySelector(".stop-text").addEventListener("click", () => {
        KPR.map.getMap().flyTo({ center: [wp.lng, wp.lat], zoom: Math.max(KPR.map.getMap().getZoom(), 14) });
      });
      li.querySelector(".stop-text").style.cursor = "pointer";
      list.appendChild(li);
    });
  }

  function _refreshSceneList() {
    const list = document.getElementById("scene-list");
    const all = KPR.scenes.getAll();
    document.getElementById("scene-count").textContent = `(${all.length})`;
    document.getElementById("scenes-empty").classList.toggle("hidden", all.length > 0);
    list.innerHTML = "";

    all.forEach((scene) => {
      const li = document.createElement("li");
      li.style.borderLeftColor = scene.color;
      li.innerHTML = `
        <div class="scene-card-text">
          <div class="scene-card-type" style="color:${_escapeHtml(scene.color)}">${_escapeHtml(scene.typeLabel)}</div>
          <div class="scene-card-label">${_escapeHtml(scene.label)}</div>
          ${scene.notes ? `<div class="scene-card-notes">${_escapeHtml(scene.notes)}</div>` : ""}
        </div>
        <button class="remove-btn" title="Remove scene" aria-label="Remove scene">&times;</button>
      `;
      li.querySelector(".remove-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        KPR.scenes.removeScene(scene.id);
      });
      // Clicking the card opens the same popup the map pin shows.
      li.addEventListener("click", () => {
        const lngLat = scene.pinMarker.getLngLat();
        scene.popup.setLngLat(lngLat).addTo(KPR.map.getMap());
        KPR.map.getMap().panTo(lngLat);
      });
      list.appendChild(li);
    });
  }

  function _refreshSceneLegend() {
    const legend = document.getElementById("scene-legend");
    const heading = legend.previousElementSibling;
    const all = KPR.scenes.getAll();
    const colors = KPR.scenes.getTypeColors();

    // Only categories actually in use on this route.
    const usedKeys = [...new Set(all.map((s) => (s.type === "Custom" ? s.typeLabel : s.type)))];
    heading.classList.toggle("hidden", usedKeys.length === 0);

    legend.innerHTML = "";
    usedKeys.forEach((key) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <input type="color" class="legend-swatch" value="${_escapeHtml(colors[key] || "#d6002f")}" title="Change color for ${_escapeHtml(key)}">
        <span>${_escapeHtml(key)}</span>
      `;
      li.querySelector("input").addEventListener("input", (e) => {
        KPR.scenes.setTypeColor(key, e.target.value);
      });
      legend.appendChild(li);
    });
  }

  function refreshLists() {
    _refreshWaypointList();
    _refreshSceneList();
    _refreshSceneLegend();
  }

  function init() {
    KPR.map.init();
    KPR.waypoints.init((info) => {
      _refreshWaypointList();
      // A stop's name arriving doesn't change the route; only re-route when
      // stops are added, moved, or removed.
      if (!info.namesOnly) KPR.routing.recalculate();
    });
    KPR.scenes.init(() => {
      // The itinerary shows scene tags per leg, so it changes with scenes too.
      refreshLists();
    });
    KPR.storage.init();
    KPR.search.init();
    KPR.drive.init();
    KPR.sheet.init();

    _wireModeButtons();
    _wireRecalcButton();
    _setMode("waypoint");
    refreshLists();
  }

  return { init, getMode, setMode: _setMode, refreshLists };
})();

// NOTE: unlike the Leaflet version, init() is NOT called here on
// DOMContentLoaded. Mapbox GL JS (mapboxgl) must be loaded and the token
// checked FIRST -- see index.html's inline bootstrap script, which calls
// KPR.app.init() itself once mapbox-gl.js has loaded. Calling it earlier
// would touch mapboxgl.* before it exists.
