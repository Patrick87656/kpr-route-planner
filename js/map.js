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

  const STANDARD_URL = "mapbox://styles/mapbox/standard";
  const STYLES = {
    night: { url: STANDARD_URL, lightPreset: "night" },
    day: { url: STANDARD_URL, lightPreset: "day" },
    satellite: { url: "mapbox://styles/mapbox/satellite-streets-v12" },
  };
  const DEFAULT_STYLE = "night";

  let map = null;
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

    map = new mapboxgl.Map({
      container: "map",
      style: STYLES[DEFAULT_STYLE].url,
      config: { basemap: { lightPreset: STYLES[DEFAULT_STYLE].lightPreset } },
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right");

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

  return {
    init,
    getMap,
    onStyleReload,
    getFitPadding,
    isStyleReady,
    applyPanelPadding,
    setStyleKey,
    getStyleKey,
  };
})();
