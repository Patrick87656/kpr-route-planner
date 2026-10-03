/**
 * map.js — base Mapbox GL JS map setup: the map instance and the
 * Night / Day / Satellite style switcher. Exposes a small KPR.map namespace
 * other modules use.
 *
 * Mapbox GL renders vector tiles on the GPU (not raster image tiles like
 * the Leaflet/OSM version), which is the main reason this variant exists --
 * smoother zoom, crisper labels, and polished default styles. Requires a
 * Mapbox access token, set in config.local.js (gitignored) as
 * `window.KPR_MAPBOX_TOKEN`. The free tier (50k map loads/month) does not
 * require a credit card to start.
 *
 * Night and Day both use Mapbox's "Standard" style, which has 3D buildings
 * and a lighting preset (the look in Mapbox's in-car navigation). Switching
 * between them only changes the preset, so the route and scene layers stay
 * put. Satellite is a separate style and needs a full style swap.
 *
 * Layout note: the map is full-screen and the planner panel floats over its
 * left side. `setPadding` tells Mapbox that strip is covered, so fitBounds,
 * flyTo, etc. center things in the VISIBLE part of the map instead of
 * hiding the route behind the panel.
 */
window.KPR = window.KPR || {};

KPR.map = (function () {
  const DEFAULT_CENTER = [-115.1398, 36.1699]; // Mapbox/GeoJSON order is [lng, lat] — Las Vegas area, arbitrary default
  const DEFAULT_ZOOM = 11;
  const LAST_POS_ZOOM = 13;
  const LAST_POS_KEY = "kprLastPosition"; // {lat, lng, ts}; last known GPS fix, so a reload opens near the user instead of Las Vegas

  const STANDARD_URL = "mapbox://styles/mapbox/standard";
  const STYLES = {
    night: { url: STANDARD_URL, lightPreset: "night" },
    day: { url: STANDARD_URL, lightPreset: "day" },
    satellite: { url: "mapbox://styles/mapbox/satellite-streets-v12" },
  };
  const DEFAULT_STYLE = "night";

  let map = null;
  let geolocateControl = null;
  // Tracks whether the planner's locate button is actively following
  // (ACTIVE_LOCK/BACKGROUND in Mapbox's terms), so stopLocate() only has to
  // act when there's actually something to stop. Driven entirely by the
  // control's own events below -- Mapbox exposes no public "is it on" getter.
  let locateActive = false;
  let currentStyleKey = DEFAULT_STYLE;
  // Mapbox GL's `setStyle()` tears down and rebuilds the whole style,
  // including any custom `addSource`/`addLayer` calls (routing.js's route
  // line and scenes.js's scene segments both use GL layers, not DOM
  // markers, so they'd silently vanish on every style switch). Other
  // modules register a rebuild callback here; `style.load` fires again after
  // `setStyle` finishes, and we re-run every registered callback then.
  const styleReloadCallbacks = [];
  // False from the moment a style starts loading until its `style.load`
  // fires. While false, Mapbox throws "Style is not done loading" on
  // addSource/addLayer, so routing.js and scenes.js wait and let their
  // onStyleReload callbacks do the drawing instead.
  let styleReady = false;

  function init() {
    mapboxgl.accessToken = window.KPR_MAPBOX_TOKEN;

    // Open near wherever the user last was (saved from a real GPS fix, see
    // _addLocateControl below) instead of always starting in Las Vegas.
    // The Las Vegas default only shows up on a device/browser that has
    // never shared its location here before.
    const last = _getLastPosition();

    map = new mapboxgl.Map({
      container: "map",
      style: STYLES[DEFAULT_STYLE].url,
      config: { basemap: { lightPreset: STYLES[DEFAULT_STYLE].lightPreset } },
      center: last ? [last.lng, last.lat] : DEFAULT_CENTER,
      zoom: last ? LAST_POS_ZOOM : DEFAULT_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right");
    _addLocateControl();

    applyPanelPadding();
    window.addEventListener("resize", applyPanelPadding);

    map.on("style.load", () => {
      styleReady = true;
      _applyLightPreset();
      styleReloadCallbacks.forEach((cb) => cb());
    });

    _wireStyleSwitcher();

    return map;
  }

  /**
   * "Locate me" button + blue you-are-here dot for planning (like Google
   * Maps). Mapbox's GeolocateControl does both, and its button cycles the
   * same way Google's does:
   *   tap        -> find me, center on me and keep following
   *   pan by hand -> dot keeps updating, camera stays where you put it
   *   tap again  -> re-center and follow;  tap while following -> off
   * Drive mode draws its own arrow, so CSS hides this dot while driving.
   * Needs https (or localhost); on a plain-http page Mapbox hides the button.
   */
  function _addLocateControl() {
    // The control re-reads fitBoundsOptions on every camera move, and
    // fitBounds REPLACES the map's padding (see getFitPadding). A getter
    // keeps the padding current as the phone sheet is dragged or rotated, so
    // the dot centers in the part of the map you can actually see instead of
    // landing behind the sheet / side panel.
    const fitBoundsOptions = { maxZoom: 15 };
    Object.defineProperty(fitBoundsOptions, "padding", {
      enumerable: true,
      get: () => {
        const sheet = _sheetTargetHeight();
        return sheet
          ? { top: 0, left: 0, right: 0, bottom: sheet }
          : { top: 0, left: _panelInset(), right: 0, bottom: 0 };
      },
    });
    const geolocate = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
      showAccuracyCircle: true,
      fitBoundsOptions,
    });
    // Added after the zoom buttons, so it stacks ABOVE them (Mapbox puts
    // later bottom-corner controls on top), where Google puts it.
    map.addControl(geolocate, "bottom-right");
    geolocateControl = geolocate;

    // A fully open sheet covers ~90% of a phone screen, so the dot would
    // land behind it. Like Google Maps, tapping locate brings a fully open
    // sheet down to half height so you can see where you are.
    // Mapbox builds its button asynchronously (after a geolocation-support
    // check), so it doesn't exist yet here. Listen on the document instead.
    document.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest(".mapboxgl-ctrl-geolocate")) KPR.sheet.lowerForMap();
    });

    // Remember every real fix so the NEXT load can open near the user
    // immediately (see _getLastPosition/init above) instead of waiting on
    // this control to kick in, or falling back to Las Vegas.
    geolocate.on("geolocate", (pos) => {
      _saveLastPosition(pos.coords.latitude, pos.coords.longitude);
    });
    // Mapbox exposes no getter for "is this control currently tracking", so
    // track it ourselves from its own state-change events (see stopLocate).
    geolocate.on("trackuserlocationstart", () => { locateActive = true; });
    geolocate.on("trackuserlocationend", () => { locateActive = false; });

    // If location was already allowed on an earlier visit, show the dot
    // straight away instead of leaving it to a tap. Never ask for
    // permission unprompted -- that waits for a tap on the button.
    if (navigator.permissions && navigator.permissions.query && window.isSecureContext) {
      navigator.permissions
        .query({ name: "geolocation" })
        .then((status) => {
          if (status.state === "denied") {
            // Mapbox greys the button out when the browser already blocks
            // location, but says nothing about why. Explain it.
            _whenLocateButton((btn) => {
              btn.title = "Location is blocked. Allow it in your browser or device settings, then reload.";
            });
            return;
          }
          if (status.state !== "granted") return;
          // Don't yank the camera if a saved route was already loaded --
          // the map already opened centered on the user via init()'s
          // last-known-position fallback, so there's nothing to fly to.
          const startLocating = () => {
            if (!KPR.routing.getRouteCoords()) geolocate.trigger();
          };
          if (map.loaded()) startLocating();
          else map.once("load", startLocating);
        })
        .catch(() => {});
    }
  }

  /** Run cb(button) once Mapbox has created the locate button (it does so
   * asynchronously). Gives up after ~10s. */
  function _whenLocateButton(cb) {
    let tries = 0;
    const timer = setInterval(() => {
      const btn = document.querySelector(".mapboxgl-ctrl-geolocate");
      if (btn) {
        clearInterval(timer);
        cb(btn);
      } else if (++tries > 50) {
        clearInterval(timer);
      }
    }, 200);
  }

  function _getLastPosition() {
    try {
      const raw = localStorage.getItem(LAST_POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p.lat === "number" && typeof p.lng === "number") return p;
    } catch (err) {
      // Corrupt or inaccessible storage (private browsing) -- fall back
      // to the Las Vegas default, same as a first-ever visit.
    }
    return null;
  }

  function _saveLastPosition(lat, lng) {
    try {
      localStorage.setItem(LAST_POS_KEY, JSON.stringify({ lat, lng, ts: Date.now() }));
    } catch (err) {
      // Storage full or disabled; next load just falls back to Las Vegas.
    }
  }

  function _applyLightPreset() {
    const preset = STYLES[currentStyleKey].lightPreset;
    if (!preset) return;
    try {
      map.setConfigProperty("basemap", "lightPreset", preset);
    } catch (err) {
      console.warn("Could not set map light preset:", err);
    }
  }

  /** Width in px of the map strip covered by the floating panel. On narrow
   * screens the panel covers nearly everything; report 0 then, or there'd
   * be no room left to center anything in. Also 0 while the panel is hidden
   * (Drive mode). */
  function _panelInset() {
    const panel = document.getElementById("panel");
    // getClientRects() is empty when the panel is display:none (Drive
    // mode). Don't use offsetParent for this: it's always null for a
    // position:fixed element, so it would report "hidden" all the time.
    if (!panel || panel.getClientRects().length === 0) return 0;
    const right = panel.getBoundingClientRect().right;
    return right < window.innerWidth * 0.7 ? right : 0;
  }

  /** Reserve the strip of map under the floating panel (see module note).
   * Call again after showing or hiding the panel. */
  function applyPanelPadding() {
    if (!map) return;
    // Bottom stays 0 even with the phone sheet: the sheet changes height
    // constantly and a padding change jumps the camera. Fits that need to
    // clear the sheet use getFitPadding() instead.
    map.setPadding({ left: _panelInset(), top: 0, right: 0, bottom: 0 });
  }

  /** Height in px covered by the phone bottom sheet (0 on wider screens, or
   * while the panel is hidden). Capped so a fully-open sheet still leaves a
   * usable strip of map to center the route in. */
  function _sheetInset() {
    const panel = document.getElementById("panel");
    if (!panel || panel.getClientRects().length === 0) return 0;
    const r = panel.getBoundingClientRect();
    const isSheet = r.left < 4 && r.right > window.innerWidth - 4 && r.top > 0;
    if (!isSheet) return 0;
    return Math.max(0, Math.min(window.innerHeight - r.top, window.innerHeight - 220));
  }

  /** Height the phone sheet is heading TO (its --sheet-h), in px; 0 when the
   * sheet layout isn't active. Unlike _sheetInset this ignores the sheet's
   * 0.25s height animation, so a camera move started right after the sheet
   * changes still centers in the final visible area. */
  function _sheetTargetHeight() {
    if (!_sheetInset()) return 0;
    const h = parseFloat(document.documentElement.style.getPropertyValue("--sheet-h"));
    return Number.isFinite(h) ? h : _sheetInset();
  }

  /**
   * Padding for fitBounds calls. Mapbox REPLACES the map's padding with the
   * padding passed to fitBounds, so a plain `{ padding: 40 }` would wipe out
   * the panel offset and leave the route partly hidden behind the panel.
   * This includes the panel width plus `margin` on every side, and extra at
   * the bottom so the route clears the status banner.
   */
  function getFitPadding(margin = 40) {
    const sheet = _sheetInset();
    if (sheet) {
      // Phone: the route has to fit in the strip ABOVE the bottom sheet and
      // below the style toggle + status banner docked at the top.
      return { left: 24, top: 120, right: 24, bottom: sheet + 24 };
    }
    return { left: _panelInset() + margin, top: margin + 40, right: margin, bottom: margin + 50 };
  }

  /** Register a function to re-run after any style change, so GL
   * sources/layers can be rebuilt. Also runs on the FIRST style load, since
   * `style.load` fires after the initial `new mapboxgl.Map(...)` as well. */
  function onStyleReload(callback) {
    styleReloadCallbacks.push(callback);
  }

  /** Switch to one of the STYLES keys. Night <-> Day only changes the
   * lighting preset; anything involving Satellite swaps the whole style. */
  function setStyleKey(key) {
    const next = STYLES[key];
    if (!next || key === currentStyleKey) return;
    const prev = STYLES[currentStyleKey];
    currentStyleKey = key;
    if (prev.url === next.url) {
      _applyLightPreset();
    } else {
      styleReady = false;
      map.setStyle(next.url);
    }
    document.querySelectorAll("#layer-toggle .layer-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.style === key);
    });
  }

  function getStyleKey() {
    return currentStyleKey;
  }

  function _wireStyleSwitcher() {
    document.querySelectorAll("#layer-toggle .layer-btn").forEach((btn) => {
      btn.addEventListener("click", () => setStyleKey(btn.dataset.style));
    });
  }

  function getMap() {
    return map;
  }

  function isStyleReady() {
    return styleReady;
  }

  /** Turn off the planner's locate-me tracking. Drive mode calls this on
   * start: it draws its own puck/camera, and leaving the planner's
   * GeolocateControl running at the same time would mean two different
   * code paths fighting over the same GPS watch and the map camera. */
  function stopLocate() {
    if (geolocateControl && locateActive) geolocateControl.trigger();
  }

  return {
    init,
    getMap,
    onStyleReload,
    getFitPadding,
    isStyleReady,
    applyPanelPadding,
    setStyleKey,
    getStyleKey,
    stopLocate,
  };
})();
