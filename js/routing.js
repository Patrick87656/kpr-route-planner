/**
 * routing.js — road-snapped routing between waypoints, in fixed order.
 *
 * Mapbox GL port: uses the Mapbox Directions API instead of the public OSRM
 * demo server. Mapbox's Directions API is itself OSRM-based, so the request
 * shape is nearly identical -- coordinates are a semicolon-separated list of
 * `{lng},{lat}` pairs visited IN THE GIVEN ORDER (there is no "optimize my
 * stops" flag on this endpoint at all, unlike Google's Directions API where
 * `optimizeWaypoints` has to be deliberately left false). That is still the
 * whole reason this app exists instead of pointing people at a stock map
 * product: a fixed KPR evaluation route must stay in the order it was built.
 *
 * The `bearings` parameter and overall response shape (routes[].geometry,
 * routes[].legs[].distance, etc.) match OSRM closely enough that the
 * two-pass "try unconstrained, retry with bearing hints only if a backtrack
 * is detected" strategy from the free Leaflet/OSRM version carries over
 * essentially unchanged -- see that version's history for why bearings must
 * be a targeted retry, not a default applied to every request (it caused a
 * parking-lot cut-through bug the first time it was tried unconditionally).
 *
 * Needs a Mapbox access token (window.KPR_MAPBOX_TOKEN from config.local.js,
 * same token map.js uses for mapboxgl.accessToken).
 */
window.KPR = window.KPR || {};

KPR.routing = (function () {
  const MAPBOX_DIRECTIONS_BASE = "https://api.mapbox.com/directions/v5/mapbox/driving/";

  let routeLine = null;
  let routeCoords = null; // [{lat, lng}, ...] the actual road-snapped path, in order
  let routeDistanceMeters = 0;
  let routeDurationSeconds = 0;
  let routeLegs = []; // one entry per consecutive waypoint pair, each with .distance (meters)

  // Every recalculation gets a sequence number. Adding waypoints quickly (or
  // loading a saved route, which adds them one by one) fires several
  // overlapping requests; only the newest one is allowed to update the map
  // and panel, so a slow older response can't overwrite a newer route.
  let requestSeq = 0;

  async function recalculate() {
    const seq = ++requestSeq;
    const points = KPR.waypoints.getOrderedLatLngs();

    if (points.length < 2) {
      _clearLine();
      routeCoords = null;
      routeLegs = [];
      _setStats(null, points.length);
      _setStatus("No route yet. Add at least 2 waypoints.", "");
      KPR.scenes.onRouteCleared();
      _refreshPanel();
      return;
    }

    _setStatus("Calculating route…", "");

    try {
      let route = await _requestRoute(points, { useBearings: false });
      if (!route) {
        throw new Error("No route could be found between these points.");
      }
      let backtrackWarning = _detectLikelyBacktrack(points, route);

      if (backtrackWarning) {
        console.warn("Unconstrained route looked like a backtrack; retrying with bearing hints.", backtrackWarning);
        const bearingRoute = await _requestRoute(points, { useBearings: true });
        if (bearingRoute) {
          const bearingWarning = _detectLikelyBacktrack(points, bearingRoute);
          if (!bearingWarning || bearingWarning.length < backtrackWarning.length) {
            route = bearingRoute;
            backtrackWarning = bearingWarning;
          }
        }
      }

      if (seq !== requestSeq) return; // a newer recalculation has started

      // GeoJSON is [lng, lat]; we store/pass {lat, lng} objects internally.
      routeCoords = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      routeDistanceMeters = route.distance;
      routeDurationSeconds = route.duration;
      routeLegs = route.legs || [];

      _drawLine(routeCoords);
      _setStats(route, points.length);

      if (backtrackWarning) {
        _setStatus(`Route OK, but heads up: ${backtrackWarning}`, "warn");
      } else {
        _setStatus("Route OK · fixed order · no backtracks", "ok");
      }

      KPR.scenes.onRouteUpdated(routeCoords);
      _refreshPanel();
    } catch (err) {
      if (seq !== requestSeq) return;
      console.error("Routing failed:", err);
      _clearLine();
      routeCoords = null;
      routeLegs = [];
      _setStats(null, points.length);
      _setStatus(`Routing failed: ${err.message}`, "error");
      KPR.scenes.onRouteCleared();
      _refreshPanel();
    }
  }

  function _setStatus(text, kind) {
    const el = document.getElementById("route-status");
    el.textContent = text;
    el.className = kind ? `status-box ${kind}` : "status-box";
  }

  /** Fills the Miles / Minutes / Stops card. `route` null = no route. */
  function _setStats(route, stopCount) {
    document.getElementById("stat-miles").textContent = route ? (route.distance / 1609.34).toFixed(1) : "–";
    document.getElementById("stat-minutes").textContent = route ? String(Math.round(route.duration / 60)) : "–";
    document.getElementById("stat-stops").textContent = String(stopCount);
  }

  /** The itinerary shows which scene starts on which leg, which depends on
   * the route geometry, so redraw the panel lists once a route lands. */
  function _refreshPanel() {
    if (KPR.app && KPR.app.refreshLists) KPR.app.refreshLists();
  }

  /**
   * Calls the Mapbox Directions API for the given points (in order).
   * Returns the best route object, or `null` if Mapbox reported no route
   * (as opposed to a hard HTTP/network failure, which throws).
   */
  async function _requestRoute(points, { useBearings }) {
    const coordStr = points.map((p) => `${p.lng},${p.lat}`).join(";");
    let url =
      `${MAPBOX_DIRECTIONS_BASE}${coordStr}` +
      // steps=true returns the turn-by-turn maneuvers Drive mode uses. It
      // doesn't change the route itself, just adds detail to the response.
      `?overview=full&geometries=geojson&steps=true&access_token=${encodeURIComponent(window.KPR_MAPBOX_TOKEN)}`;
    if (useBearings) {
      url += `&bearings=${_computeBearingHints(points)}`;
    }

    const resp = await fetch(url);
    const data = await resp.json();

    if (!resp.ok || data.code !== "Ok" || !data.routes || data.routes.length === 0) {
      if (data && data.message) {
        console.warn("Mapbox Directions:", data.message);
      }
      return null;
    }
    return data.routes[0];
  }

  /**
   * Heuristic "did this route probably backtrack/U-turn" check: for each
   * leg between two consecutive user waypoints, compare the ROAD distance
   * actually driven (`route.legs[i].distance`) against the STRAIGHT-LINE
   * distance between those two waypoints. See the free Leaflet/OSRM
   * version's history for the full story of why this exists.
   */
  function _detectLikelyBacktrack(points, route) {
    const legs = route.legs || [];
    const flaggedLegNumbers = [];

    for (let i = 0; i < legs.length && i < points.length - 1; i++) {
      const straightMeters = _haversineMeters(points[i], points[i + 1]);
      if (straightMeters < 150) continue;

      const roadMeters = legs[i].distance;
      const ratio = roadMeters / straightMeters;
      if (ratio >= 3) {
        flaggedLegNumbers.push(i + 1);
      }
    }

    if (flaggedLegNumbers.length === 0) return null;
    const legWord = flaggedLegNumbers.length === 1 ? "leg" : "legs";
    return (
      `${legWord} ${flaggedLegNumbers.join(", ")} between waypoints ${flaggedLegNumbers
        .map((n) => `${n}→${n + 1}`)
        .join(", ")} ` +
      `${flaggedLegNumbers.length === 1 ? "looks" : "look"} like they backtrack. ` +
      `Try adding a waypoint along the road you actually want there.`
    );
  }

  /** Great-circle distance in meters between two {lat,lng} points. */
  function _haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);
    const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * Builds Mapbox's `bearings` query parameter: one "degree,range" pair per
   * waypoint, semicolon-separated, matching the waypoint order -- same
   * format OSRM uses. Each waypoint's bearing points toward its NEXT
   * waypoint (the last one reuses the previous leg's direction). ±90
   * degrees rules out the wrong-direction edge of a divided road while
   * still tolerating a road's normal heading variation.
   */
  function _computeBearingHints(points) {
    const RANGE = 90;
    const bearings = [];
    for (let i = 0; i < points.length; i++) {
      let from, to;
      if (i < points.length - 1) {
        from = points[i];
        to = points[i + 1];
      } else {
        from = points[i - 1];
        to = points[i];
      }
      const degree = Math.round(_bearingBetween(from, to));
      bearings.push(`${degree},${RANGE}`);
    }
    return bearings.join(";");
  }

  /** Compass bearing (0-360, 0 = north) from point a to point b. */
  function _bearingBetween(a, b) {
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const deg = (Math.atan2(y, x) * 180) / Math.PI;
    return (deg + 360) % 360;
  }

  const ROUTE_SOURCE_ID = "kpr-route-line";
  const ROUTE_GLOW_LAYER_ID = "kpr-route-line-glow";
  const ROUTE_LAYER_ID = "kpr-route-line-layer";

  /** First scene layer currently on the map, if any. The route line is
   * inserted BELOW it so the colored scene segments always draw on top,
   * even when the route is redrawn after scenes already exist. */
  function _firstSceneLayerId(map) {
    const layers = (map.getStyle() && map.getStyle().layers) || [];
    const found = layers.find((l) => l.id.startsWith("kpr-scene-layer-"));
    return found ? found.id : undefined;
  }

  function _drawLine(coords, { fit = true } = {}) {
    const map = KPR.map.getMap();
    const geojson = {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: coords.map((c) => [c.lng, c.lat]),
      },
    };

    if (map.getSource(ROUTE_SOURCE_ID)) {
      map.getSource(ROUTE_SOURCE_ID).setData(geojson);
    } else if (!KPR.map.isStyleReady()) {
      // Mid style switch: Mapbox refuses new layers until the new style has
      // loaded. routeCoords is already set, so the onStyleReload callback
      // below draws the line as soon as the style is ready.
      return;
    } else {
      map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: geojson });
      const beforeId = _firstSceneLayerId(map);
      // Soft blurred line underneath gives the route its glow on dark maps.
      map.addLayer(
        {
          id: ROUTE_GLOW_LAYER_ID,
          type: "line",
          source: ROUTE_SOURCE_ID,
          layout: { "line-join": "round", "line-cap": "round" },
          // emissive-strength 1 keeps the line full brightness under the
          // Standard style's night lighting (otherwise it renders dimmed).
          paint: { "line-color": "#3b82f6", "line-width": 14, "line-blur": 8, "line-opacity": 0.45, "line-emissive-strength": 1 },
        },
        beforeId
      );
      map.addLayer(
        {
          id: ROUTE_LAYER_ID,
          type: "line",
          source: ROUTE_SOURCE_ID,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#3b82f6", "line-width": 5, "line-opacity": 0.95, "line-emissive-strength": 1 },
        },
        beforeId
      );
    }
    routeLine = true;

    if (!fit) return;

    // Seed the bounds with the first point as BOTH corners. Passing a single
    // [lng, lat] array to `new LngLatBounds(x)` is wrong: with one argument
    // Mapbox treats it as [sw, ne] and calls setSouthWest(x[0]) on a bare
    // number, which throws "`LngLatLike` argument must be specified..." --
    // after the line was already drawn, so the route showed up but the
    // status box reported a failure and the route data got cleared.
    if (coords.length === 0) return;
    const first = [coords[0].lng, coords[0].lat];
    const bounds = coords.reduce(
      (b, c) => b.extend([c.lng, c.lat]),
      new mapboxgl.LngLatBounds(first, first)
    );
    map.fitBounds(bounds, { padding: KPR.map.getFitPadding() });
  }

  function _clearLine() {
    const map = KPR.map.getMap();
    if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
    if (map.getLayer(ROUTE_GLOW_LAYER_ID)) map.removeLayer(ROUTE_GLOW_LAYER_ID);
    if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);
    routeLine = null;
  }

  // Style changes (Dark / Streets / Satellite) wipe custom GL
  // sources/layers -- re-add the route line after any style reload if we
  // have one to show. See map.js's `onStyleReload` for why this exists.
  // No re-zoom here: switching map style shouldn't move the camera.
  KPR.map.onStyleReload(() => {
    if (routeCoords && routeCoords.length > 0) {
      routeLine = null;
      _drawLine(routeCoords, { fit: false });
    }
  });

  function getRouteCoords() {
    return routeCoords;
  }

  function getSummary() {
    return { distanceMeters: routeDistanceMeters, durationSeconds: routeDurationSeconds };
  }

  /**
   * Turn-by-turn steps for Drive mode, flattened across legs in route
   * order. Each entry: { legIndex, name, distance, duration, maneuver }
   * where maneuver is Mapbox's { type, modifier, instruction, location }.
   * `type: "arrive"` at the end of a leg that isn't the last one means
   * "reaching stop legIndex + 2".
   */
  function getSteps() {
    const steps = [];
    routeLegs.forEach((leg, legIndex) => {
      (leg.steps || []).forEach((s) => {
        steps.push({
          legIndex,
          name: s.name || "",
          ref: s.ref || "",
          distance: s.distance,
          duration: s.duration,
          maneuver: s.maneuver,
        });
      });
    });
    return steps;
  }

  return { recalculate, getRouteCoords, getSummary, getSteps };
})();
