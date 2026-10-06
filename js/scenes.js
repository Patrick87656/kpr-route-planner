/**
 * scenes.js — tag stretches of the drawn route as evaluation scenes
 * (NVH, Handling, Braking, etc.).
 *
 * Flow in "Tag Scene" mode: user clicks a point near the route (start of the
 * stretch), then clicks a second point (end of the stretch). We snap both
 * clicks to the nearest point along the already-computed route polyline, so
 * a scene is always defined as a sub-range of the real road-snapped route,
 * not an arbitrary line.
 *
 * Mapbox GL port: route coordinates from routing.js are `{lat, lng}`
 * objects. Scene segments are drawn as GL sources/layers (one per scene,
 * mirroring Leaflet's one-polyline-per-scene model) instead of individual
 * polyline objects, since Mapbox GL draws vector data via
 * `addSource`/`addLayer` rather than per-feature draw calls. Pin markers
 * reuse `mapboxgl.Marker` with the SAME HTML/CSS badge Leaflet used
 * (Marker accepts an arbitrary DOM element). Notes popups use
 * `mapboxgl.Popup` instead of Leaflet's `bindPopup`.
 */
window.KPR = window.KPR || {};

KPR.scenes = (function () {
  // Default colors per scene type/category. These are overridable by the
  // user per-category via the color picker in the scene dialog (see
  // `_applyTypeColor`/`setTypeColor`); `typeColors` below starts as a copy of
  // this and is what's actually used to render scenes and the legend.
  const DEFAULT_SCENE_COLORS = {
    NVH: "#f59e0b",
    Handling: "#8b5cf6",
    Braking: "#ef4444",
    "Ride Comfort": "#10b981",
    Powertrain: "#0ea5e9",
    Visibility: "#64748b",
    Custom: "#c3002f",
  };

  // The live color for each category, keyed by `typeLabel` (so each custom
  // type name gets its own remembered color too, not just the 6 presets).
  // Loaded from localStorage on init so color choices persist between
  // sessions; saved back on every change.
  //
  // Keys are user-controlled (custom type names, names from shared links), so
  // this has no prototype: a key like "constructor" or "__proto__" is then
  // just an ordinary (missing) entry instead of a function or the prototype.
  let typeColors = Object.assign(Object.create(null), DEFAULT_SCENE_COLORS);
  const COLOR_STORAGE_KEY = "kpr.sceneTypeColors";
  const FALLBACK_COLOR = "#c3002f";

  function _hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** Only a plain #rrggbb color is ever used in a style attribute, paint
   * property or color input; anything else gets `fallback`. */
  function safeColor(value, fallback = FALLBACK_COLOR) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  /** Color for a scene category: the live (user-chosen) color, else the
   * preset default for that type, else the Custom default. */
  function _colorFor(type, typeLabel) {
    const key = type === "Custom" ? typeLabel : type;
    const preset = _hasOwn(DEFAULT_SCENE_COLORS, type) ? DEFAULT_SCENE_COLORS[type] : DEFAULT_SCENE_COLORS.Custom;
    return safeColor(_hasOwn(typeColors, key) ? typeColors[key] : null, preset);
  }

  let currentRouteCoords = null; // [{lat, lng}, ...] from routing.js
  let scenes = []; // { id, type, label, notes, startIdx, endIdx, sourceId, layerId, pinMarker, popup }
  let nextId = 1;
  let pendingStartIdx = null; // set after first click in scene mode
  let onChangeCallback = null;

  function init(onChange) {
    onChangeCallback = onChange;
    _loadTypeColors();
    const map = KPR.map.getMap();

    map.on("click", (e) => {
      if (KPR.app.getMode() !== "scene") return;
      _handleSceneClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    document.getElementById("scene-type").addEventListener("change", (e) => {
      const wrap = document.getElementById("scene-custom-type-wrap");
      wrap.classList.toggle("hidden", e.target.value !== "Custom");
      _syncColorFieldToType();
    });

    document.getElementById("scene-custom-type").addEventListener("input", _syncColorFieldToType);

    document.getElementById("scene-color-reset").addEventListener("click", () => {
      const key = _currentDialogTypeKey();
      const colorInput = document.getElementById("scene-color");
      colorInput.value = _hasOwn(DEFAULT_SCENE_COLORS, key) ? DEFAULT_SCENE_COLORS[key] : DEFAULT_SCENE_COLORS.Custom;
    });

    document.getElementById("scene-cancel").addEventListener("click", _closeDialog);
    document.getElementById("scene-confirm").addEventListener("click", _confirmScene);

    // Style changes (street/satellite toggle) wipe custom GL sources/layers
    // -- re-add every scene segment's source/layer after a style reload.
    // Pin markers/popups are DOM overlays and survive on their own.
    KPR.map.onStyleReload(() => {
      scenes.forEach((s) => _addSceneLayer(s));
    });
  }

  function _loadTypeColors() {
    try {
      const raw = localStorage.getItem(COLOR_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        const merged = Object.assign(Object.create(null), DEFAULT_SCENE_COLORS);
        if (saved && typeof saved === "object") {
          Object.keys(saved).forEach((k) => {
            if (typeof saved[k] === "string" && safeColor(saved[k], null)) merged[k] = saved[k];
          });
        }
        typeColors = merged;
      }
    } catch (err) {
      console.warn("Could not load saved scene colors, using defaults.", err);
    }
  }

  function _saveTypeColors() {
    try {
      localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(typeColors));
    } catch (err) {
      console.warn("Could not persist scene colors.", err);
    }
  }

  /** The key used to look up/store a color: the preset type, or the custom
   * type's own name (so "Infotainment" gets its own remembered color
   * distinct from the generic "Custom" default). */
  function _currentDialogTypeKey() {
    const typeSel = document.getElementById("scene-type");
    if (typeSel.value !== "Custom") return typeSel.value;
    const customName = document.getElementById("scene-custom-type").value.trim();
    return customName || "Custom";
  }

  function _syncColorFieldToType() {
    const key = _currentDialogTypeKey();
    const colorInput = document.getElementById("scene-color");
    const fallback = _hasOwn(DEFAULT_SCENE_COLORS, key) ? DEFAULT_SCENE_COLORS[key] : DEFAULT_SCENE_COLORS.Custom;
    colorInput.value = safeColor(_hasOwn(typeColors, key) ? typeColors[key] : null, fallback);
  }

  /** Set and persist the color for a scene category, and recolor any
   * existing scenes of that category already on the map. Anything that
   * isn't a #rrggbb color is ignored. */
  function setTypeColor(key, color) {
    if (!safeColor(color, null)) return;
    typeColors[key] = color;
    _saveTypeColors();
    scenes
      .filter((s) => s.typeLabel === key || (key === s.type && s.type !== "Custom"))
      .forEach((s) => _recolorScene(s, color));
    _notifyChange();
  }

  function _recolorScene(scene, color) {
    color = safeColor(color, scene.color);
    scene.color = color;
    const map = KPR.map.getMap();
    if (map.getLayer(scene.layerId)) {
      map.setPaintProperty(scene.layerId, "line-color", color);
    }
    const pin = scene.pinMarker.getElement().querySelector(".scene-pin-marker");
    if (pin) pin.style.background = color;
  }

  function getTypeColors() {
    return Object.assign(Object.create(null), typeColors);
  }

  function onRouteUpdated(routeCoords) {
    currentRouteCoords = routeCoords;
    pendingStartIdx = null;
    // routing.js just wrote a fresh status; don't restore an older one later.
    savedStatus = null;
  }

  function onRouteCleared() {
    currentRouteCoords = null;
    pendingStartIdx = null;
    savedStatus = null;
    clearAll();
  }

  function _handleSceneClick(latlng) {
    if (!currentRouteCoords) {
      alert("Calculate a route first (add at least 2 waypoints), then tag scenes along it.");
      return;
    }
    const idx = _nearestRouteIndex(latlng);

    if (pendingStartIdx === null) {
      pendingStartIdx = idx;
      // Temporarily use the route status banner as a prompt; the real route
      // status is put back once the scene is added or cancelled.
      const statusEl = document.getElementById("route-status");
      savedStatus = { text: statusEl.textContent, className: statusEl.className };
      statusEl.textContent = "Scene start marked. Click the end point along the route.";
      statusEl.className = "status-box";
      return;
    }

    const startIdx = Math.min(pendingStartIdx, idx);
    const endIdx = Math.max(pendingStartIdx, idx);
    pendingStartIdx = null;

    if (startIdx === endIdx) {
      _restoreStatus();
      alert("Start and end points are the same — pick two distinct points along the route.");
      return;
    }

    _openDialog(startIdx, endIdx);
  }

  function _nearestRouteIndex(latlng) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < currentRouteCoords.length; i++) {
      const { lat, lng } = currentRouteCoords[i];
      const d = (lat - latlng.lat) ** 2 + (lng - latlng.lng) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  let dialogContext = null;

  function _openDialog(startIdx, endIdx, prefill) {
    dialogContext = { startIdx, endIdx };
    const dialog = document.getElementById("scene-dialog");
    const typeSel = document.getElementById("scene-type");
    const customWrap = document.getElementById("scene-custom-type-wrap");
    const customInput = document.getElementById("scene-custom-type");
    const labelInput = document.getElementById("scene-label");
    const notesInput = document.getElementById("scene-notes");

    typeSel.value = (prefill && _hasOwn(DEFAULT_SCENE_COLORS, prefill.type)) ? prefill.type : "NVH";
    customWrap.classList.toggle("hidden", typeSel.value !== "Custom");
    customInput.value = prefill && prefill.type === "Custom" ? prefill.typeLabel || "" : "";
    labelInput.value = prefill ? prefill.label || "" : "";
    notesInput.value = prefill ? prefill.notes || "" : "";
    _syncColorFieldToType();

    dialog.classList.remove("hidden");
    labelInput.focus();
  }

  function _closeDialog() {
    dialogContext = null;
    document.getElementById("scene-dialog").classList.add("hidden");
    _restoreStatus();
  }

  // Route status that was showing before the "Scene start marked" prompt.
  let savedStatus = null;

  function _restoreStatus() {
    if (!savedStatus) return;
    const statusEl = document.getElementById("route-status");
    statusEl.textContent = savedStatus.text;
    statusEl.className = savedStatus.className;
    savedStatus = null;
  }

  function _confirmScene() {
    if (!dialogContext) return;
    const typeSel = document.getElementById("scene-type");
    const customInput = document.getElementById("scene-custom-type");
    const labelInput = document.getElementById("scene-label");
    const notesInput = document.getElementById("scene-notes");
    const colorInput = document.getElementById("scene-color");

    const type = typeSel.value;
    const typeLabel = type === "Custom" ? (customInput.value.trim() || "Custom") : type;
    const label = labelInput.value.trim() || typeLabel;
    const notes = notesInput.value.trim();
    const colorKey = type === "Custom" ? typeLabel : type;

    // Picking a color here sets it for the whole category going forward
    // (persisted), not just this one scene — that's the point of a
    // per-category color picker rather than a per-scene one.
    setTypeColor(colorKey, colorInput.value);

    addScene(dialogContext.startIdx, dialogContext.endIdx, type, typeLabel, label, notes);
    _closeDialog();
  }

  function _addSceneLayer(scene) {
    const map = KPR.map.getMap();
    const geojson = {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: scene.segment.map((c) => [c.lng, c.lat]),
      },
    };

    if (map.getSource(scene.sourceId)) {
      map.getSource(scene.sourceId).setData(geojson);
      return;
    }
    // Mid style switch: Mapbox refuses new layers until the new style has
    // loaded. The scene is already in `scenes`, so the onStyleReload callback
    // in init() adds its layer as soon as the style is ready.
    if (!KPR.map.isStyleReady()) return;
    map.addSource(scene.sourceId, { type: "geojson", data: geojson });
    map.addLayer({
      id: scene.layerId,
      type: "line",
      source: scene.sourceId,
      layout: { "line-join": "round", "line-cap": "round" },
      // emissive-strength 1: full brightness under Standard night lighting.
      paint: { "line-color": scene.color, "line-width": 8, "line-opacity": 0.9, "line-emissive-strength": 1 },
    });
    // Layer-scoped listeners stay registered on the map across style
    // switches, but this function runs again after every switch to re-add
    // the layer. Bind them only once per scene so clicks don't stack up.
    if (scene.listenersBound) return;
    scene.listenersBound = true;
    map.on("click", scene.layerId, (e) => {
      scene.popup.setLngLat(e.lngLat).addTo(map);
    });
    map.on("mouseenter", scene.layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", scene.layerId, () => {
      // Back to the mode's cursor (crosshair while tagging scenes).
      map.getCanvas().style.cursor = KPR.app.getMode() === "scene" ? "crosshair" : "";
    });
  }

  function addScene(startIdx, endIdx, type, typeLabel, label, notes) {
    const id = nextId++;
    const color = _colorFor(type, typeLabel);
    const segment = currentRouteCoords.slice(startIdx, endIdx + 1);

    const map = KPR.map.getMap();
    const popup = new mapboxgl.Popup({ offset: 12, closeButton: true }).setDOMContent(
      buildPopupContent(typeLabel, label, notes)
    );

    const sourceId = `kpr-scene-src-${id}`;
    const layerId = `kpr-scene-layer-${id}`;
    const scene = {
      id,
      type,
      typeLabel,
      label,
      notes,
      startIdx,
      endIdx,
      color,
      segment,
      sourceId,
      layerId,
      popup,
    };

    // The notes a user types when tagging a scene need somewhere visible on
    // the map, not just a browser hover tooltip in the sidebar (see
    // scene-list rendering in app.js). Both the colored route segment and
    // its label pin open the SAME popup.
    _addSceneLayer(scene);

    const midpoint = segment[Math.floor(segment.length / 2)];
    const pinEl = buildPinElement(label, color);
    // Anchored at its bottom edge and nudged up, so the label sits just above
    // the colored segment instead of covering the road (or a stop) under it.
    const pinMarker = new mapboxgl.Marker({ element: pinEl, anchor: "bottom", offset: [0, -6] })
      .setLngLat([midpoint.lng, midpoint.lat])
      .addTo(map);
    pinEl.addEventListener("click", () => {
      popup.setLngLat([midpoint.lng, midpoint.lat]).addTo(map);
    });

    scene.pinMarker = pinMarker;
    scenes.push(scene);
    _notifyChange();
    return scene;
  }

  // Scene text can come from a shared link, so the popup and the map pin are
  // built with DOM APIs (textContent / style properties), never as HTML
  // strings: nothing the text contains can turn into markup or attributes.

  function _text(value) {
    return value == null ? "" : String(value);
  }

  function _div(className, text) {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    return el;
  }

  /** The notes popup shown when a scene segment or its pin is clicked. */
  function buildPopupContent(typeLabel, label, notes) {
    const root = document.createElement("div");
    root.className = "scene-popup";
    root.appendChild(_div("scene-popup-type", _text(typeLabel)));
    root.appendChild(_div("scene-popup-label", _text(label)));
    const p = document.createElement("p");
    if (notes) {
      p.className = "scene-popup-notes";
      p.textContent = _text(notes);
    } else {
      p.className = "scene-popup-notes scene-popup-notes-empty";
      p.textContent = "No notes added.";
    }
    root.appendChild(p);
    return root;
  }

  /** The label pin drawn on the map at the middle of a scene. */
  function buildPinElement(label, color) {
    const wrap = document.createElement("div");
    wrap.className = "scene-pin-marker-wrap";
    const pin = _div("scene-pin-marker", _text(label));
    pin.style.background = safeColor(color);
    wrap.appendChild(pin);
    return wrap;
  }

  // ---- rating badge on the map pin ------------------------------------
  //
  // A small circle at the pin's top-right corner: thumb up (good), thumb
  // down (bad) or a dash (not rated). Built from DOM/SVG calls only; the
  // only input is a kind looked up in a fixed table, so nothing a link or
  // file contains can reach the markup or a class name.

  const SVG_NS = "http://www.w3.org/2000/svg";
  const THUMB_PATH =
    "M2 21h4V9H2v12zm20-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13.17 1 6.59 7.59C6.22 7.95 6 8.45 6 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z";

  // No prototype, so "constructor" / "__proto__" are simply not kinds.
  const BADGE_KINDS = Object.assign(Object.create(null), {
    good: { cls: "good", label: "Rated good" },
    bad: { cls: "bad", label: "Rated bad" },
    none: { cls: "none", label: "Not rated" },
  });

  /** The badge element for "good" | "bad" | "none", or null for anything
   * else. */
  function buildRatingBadge(kind) {
    if (typeof kind !== "string" || !(kind in BADGE_KINDS)) return null;
    const def = BADGE_KINDS[kind];
    const badge = document.createElement("span");
    badge.className = "rating-badge " + def.cls;
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", def.label);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (kind === "none") {
      const bar = document.createElementNS(SVG_NS, "rect");
      bar.setAttribute("x", "4");
      bar.setAttribute("y", "10.5");
      bar.setAttribute("width", "16");
      bar.setAttribute("height", "3");
      svg.appendChild(bar);
    } else {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", THUMB_PATH);
      // Thumb down is the thumb up turned over.
      if (kind === "bad") path.setAttribute("transform", "rotate(180 12 12)");
      svg.appendChild(path);
    }
    badge.appendChild(svg);
    return badge;
  }

  /** Put a badge on a scene's pin: "good" | "bad" | "none". null/undefined
   * removes it. An existing badge is replaced; an unknown kind changes
   * nothing. */
  function setRatingBadge(sceneId, kind) {
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene || !scene.pinMarker) return;
    const host = scene.pinMarker.getElement();
    if (!host) return;
    const remove = () => host.querySelectorAll(".rating-badge").forEach((el) => el.remove());
    if (kind === null || kind === undefined) {
      remove();
      return;
    }
    const badge = buildRatingBadge(kind);
    if (!badge) return;
    remove();
    host.appendChild(badge);
  }

  function _removeSceneLayer(scene) {
    const map = KPR.map.getMap();
    if (map.getLayer(scene.layerId)) map.removeLayer(scene.layerId);
    if (map.getSource(scene.sourceId)) map.removeSource(scene.sourceId);
  }

  function removeScene(id) {
    const idx = scenes.findIndex((s) => s.id === id);
    if (idx === -1) return;
    _removeSceneLayer(scenes[idx]);
    scenes[idx].pinMarker.remove();
    scenes[idx].popup.remove();
    scenes.splice(idx, 1);
    _notifyChange();
  }

  function clearAll() {
    scenes.forEach((s) => {
      _removeSceneLayer(s);
      s.pinMarker.remove();
      s.popup.remove();
    });
    scenes = [];
    _notifyChange();
  }

  function getAll() {
    return scenes;
  }

  function count() {
    return scenes.length;
  }

  function _notifyChange() {
    if (onChangeCallback) onChangeCallback(scenes);
  }

  // ---- saving / loading by coordinates -----------------------------------
  //
  // A scene is held as indices into the route polyline, but the number of
  // points in that polyline changes whenever the route is recalculated (a
  // different Mapbox response, a moved stop, a map data update). Index 40 of
  // the old line can be a different road on the new one. So saved files also
  // carry the start/end coordinates, and loading snaps those back onto the
  // freshly calculated route. Files saved before this (format v1) have only
  // indices and keep loading exactly as they always did.

  const SWAP_TOLERANCE_METERS = 50;

  function _isPoint(p) {
    return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
  }

  function _isLatLng(lat, lng) {
    return (
      typeof lat === "number" && typeof lng === "number" &&
      Number.isFinite(lat) && Number.isFinite(lng) &&
      Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    );
  }

  /** Approximate ground distance in meters (fine over the short distances
   * involved in snapping a point to a route). */
  function _distMeters(aLat, aLng, bLat, bLng) {
    const dLat = (bLat - aLat) * 111320;
    const dLng = (bLng - aLng) * 111320 * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }

  /** Index of the route point nearest to (lat, lng), searching from index
   * `from` onward. Ties go to the earliest index. -1 if nothing to search. */
  function nearestIndex(route, lat, lng, from = 0) {
    if (!Array.isArray(route) || !Number.isFinite(lat) || !Number.isFinite(lng)) return -1;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = Math.max(0, from); i < route.length; i++) {
      if (!_isPoint(route[i])) continue;
      const d = _distMeters(lat, lng, route[i].lat, route[i].lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /**
   * Snap a saved scene's start/end coordinates onto `route`. Returns
   * {startIdx, endIdx} with startIdx < endIdx and both inside the route, or
   * null when that isn't possible (fewer than 2 points, bad coordinates).
   * Never throws.
   */
  function snapToRoute(route, rec) {
    if (!Array.isArray(route) || route.length < 2 || !rec) return null;
    const { startLat, startLng, endLat, endLng } = rec;
    if (![startLat, startLng, endLat, endLng].every(Number.isFinite)) return null;

    const last = route.length - 1;
    let start = nearestIndex(route, startLat, startLng);
    let end = nearestIndex(route, endLat, endLng, Math.max(start, 0));
    const endAny = nearestIndex(route, endLat, endLng);
    if (start < 0 || end < 0 || endAny < 0) return null;

    // Scene order follows the direction of travel. If the end only matches
    // well BEHIND the start, the scene was saved reversed: swap the roles.
    const dist = (i, lat, lng) => _distMeters(lat, lng, route[i].lat, route[i].lng);
    if (dist(end, endLat, endLng) - dist(endAny, endLat, endLng) > SWAP_TOLERANCE_METERS) {
      start = endAny;
      end = nearestIndex(route, startLat, startLng, start);
      if (end < 0) return null;
    }

    if (end <= start) {
      if (start + 1 <= last) {
        end = start + 1;
      } else {
        start = last - 1;
        end = last;
      }
    }
    return { startIdx: start, endIdx: end };
  }

  /**
   * Work out where a saved scene record sits on `route`. Uses the saved
   * coordinates when the record has them (format v2), otherwise the saved
   * indices clamped to the route length, as before. Returns
   * {startIdx, endIdx} or null if the record can't be placed.
   */
  function resolveSceneRange(route, rec) {
    if (!Array.isArray(route) || route.length < 1 || !rec) return null;

    if (_isLatLng(rec.startLat, rec.startLng) && _isLatLng(rec.endLat, rec.endLng)) {
      return snapToRoute(route, rec);
    }

    if (!Number.isInteger(rec.startIdx) || !Number.isInteger(rec.endIdx)) return null;
    const clamp = (i) => Math.max(0, Math.min(i, route.length - 1));
    let startIdx = clamp(rec.startIdx);
    let endIdx = clamp(rec.endIdx);
    if (startIdx > endIdx) [startIdx, endIdx] = [endIdx, startIdx];
    return { startIdx, endIdx };
  }

  /** One scene as written to a saved file: the fields it always had, plus
   * the start/end coordinates. Prefers the scene's own drawn segment so the
   * coordinates match what is on the map even if the route was recalculated
   * since the scene was tagged. */
  function buildSaveRecord(scene, route) {
    const n = Array.isArray(route) ? route.length : 0;
    const clamp = (i) => (n > 0 ? Math.max(0, Math.min(i, n - 1)) : i);
    const rec = {
      type: scene.type,
      typeLabel: scene.typeLabel,
      label: scene.label,
      notes: scene.notes,
      startIdx: clamp(scene.startIdx),
      endIdx: clamp(scene.endIdx),
    };
    const seg = Array.isArray(scene.segment) && scene.segment.length > 0 ? scene.segment : null;
    const from = seg ? seg[0] : n > 0 ? route[rec.startIdx] : null;
    const to = seg ? seg[seg.length - 1] : n > 0 ? route[rec.endIdx] : null;
    if (_isPoint(from) && _isPoint(to)) {
      rec.startLat = from.lat;
      rec.startLng = from.lng;
      rec.endLat = to.lat;
      rec.endLng = to.lng;
    }
    return rec;
  }

  /** Scenes in the shape written to a saved file. */
  function getSaveData() {
    return scenes.map((s) => buildSaveRecord(s, currentRouteCoords));
  }

  /** Rebuild scenes from saved data once the route has been recalculated.
   * Returns how many were placed and how many had to be skipped. */
  function loadFrom(savedScenes) {
    clearAll();
    const list = Array.isArray(savedScenes) ? savedScenes : [];
    let loaded = 0;
    let skipped = 0;
    list.forEach((s, i) => {
      try {
        const range = resolveSceneRange(currentRouteCoords, s);
        if (!range) {
          skipped++;
          return;
        }
        const scene = addScene(range.startIdx, range.endIdx, s.type, s.typeLabel, s.label, s.notes);
        // Remember where this scene sat in the input list. Scenes that could
        // not be placed are skipped above, so getAll() can be shorter than
        // the list; anything indexed by the ORIGINAL order (a results link's
        // ratings) must go through srcIndex, never through getAll() position.
        scene.srcIndex = i;
        loaded++;
      } catch (err) {
        console.warn("Skipped a scene that could not be loaded.", err);
        skipped++;
      }
    });
    return { loaded, skipped };
  }

  return {
    init,
    onRouteUpdated,
    onRouteCleared,
    addScene,
    removeScene,
    clearAll,
    getAll,
    count,
    loadFrom,
    getSaveData,
    nearestIndex,
    snapToRoute,
    resolveSceneRange,
    buildSaveRecord,
    setTypeColor,
    getTypeColors,
    safeColor,
    buildPopupContent,
    buildPinElement,
    buildRatingBadge,
    setRatingBadge,
    DEFAULT_SCENE_COLORS,
  };
})();
