/**
 * browse-routes.js — "Browse saved routes": list the published route library
 * (routes/index.json) and load a chosen route straight into the planner.
 *
 * Part 2 of the shared-route-library feature. Routes are published as static
 * files on the same origin: a manifest at routes/index.json and one full
 * planner route (minus routeCoords) per entry at routes/<file>. This module
 * only fetches those files and hands a parsed route to the SAME pipeline a
 * file-upload load uses — KPR.storage.normalizeFileData(data) then
 * KPR.storage.applyRoute(route) — so a library load behaves identically to a
 * file Load: stops placed, geometry recalculated via Mapbox Directions,
 * scenes snapped, vehicles populated. It does not reimplement any of that.
 *
 * Every value from the fetched JSON reaches the DOM only through textContent
 * / createElement, never innerHTML, so a hostile manifest can't inject markup.
 *
 * fetch is read through an overridable seam (KPR.browseRoutes._fetch) so the
 * no-network test harness can stub it; the live app uses window.fetch.
 */
window.KPR = window.KPR || {};

KPR.browseRoutes = (function () {
  const MANIFEST_URL = "routes/index.json";
  const EMPTY_MSG = "Saved routes aren't available yet.";
  const ERROR_MSG = "Couldn't load the route library.";
  const LOAD_ERROR_MSG = "Couldn't load that route. Please try another.";
  const LOAD_ROUTE_MSG = "The stops loaded, but the route couldn't be calculated. Check your connection and try Recalculate.";

  const $ = (id) => document.getElementById(id);
  let lastFocus = null;

  // fetch seam: default to the platform fetch, bound so `this` stays valid;
  // tests replace this with a stub (the harness has no network).
  let _fetch = (typeof window !== "undefined" && window.fetch)
    ? window.fetch.bind(window)
    : null;
  function _setFetch(fn) {
    _fetch = fn;
  }

  /** meters -> miles string, matching routing.js _setStats (e.g. "10.8"). */
  function formatMiles(meters) {
    return (Number(meters) / 1609.34).toFixed(1);
  }

  /** seconds -> whole-minutes string, matching routing.js _setStats. */
  function formatMinutes(seconds) {
    return String(Math.round(Number(seconds) / 60));
  }

  function _setMessage(text) {
    const el = $("browse-msg");
    el.textContent = text || "";
    el.classList.toggle("hidden", !text);
  }

  /** The muted meta line for one route, e.g. "10.8 mi · 23 min · 8 scenes · 10 stops · Nissan Rogue Hybrid, Toyota RAV4 Hybrid". */
  function _metaText(entry) {
    const parts = [
      formatMiles(entry.distanceMeters) + " mi",
      formatMinutes(entry.durationSeconds) + " min",
      String(entry.sceneCount || 0) + " scenes",
      String(entry.waypointCount || 0) + " stops",
    ];
    const vehicles = Array.isArray(entry.vehicles) ? entry.vehicles.filter(Boolean) : [];
    if (vehicles.length > 0) parts.push(vehicles.join(", "));
    return parts.join(" \u00B7 ");
  }

  /**
   * Render the route list into `container`. Every field goes in via
   * textContent, never innerHTML, so hostile manifest strings stay inert.
   * An empty/missing array shows the friendly empty message.
   */
  function renderList(container, routes) {
    container.textContent = "";
    const list = Array.isArray(routes) ? routes : [];
    if (list.length === 0) {
      _setMessage(EMPTY_MSG);
      return;
    }
    list.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const li = document.createElement("li");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "browse-item";

      const name = document.createElement("span");
      name.className = "browse-item-name";
      name.textContent = String(entry.name || "Untitled route");

      const meta = document.createElement("span");
      meta.className = "browse-item-meta";
      meta.textContent = _metaText(entry);

      btn.appendChild(name);
      btn.appendChild(meta);
      btn.addEventListener("click", () => selectRoute(entry));

      li.appendChild(btn);
      container.appendChild(li);
    });
  }

  /** Fetch the selected route file and load it through the existing pipeline. */
  async function selectRoute(entry) {
    if (!entry || !entry.file) {
      _setMessage(LOAD_ERROR_MSG);
      return;
    }
    _setMessage("");
    try {
      const res = await _fetch("routes/" + entry.file);
      if (!res || !res.ok) throw new Error("fetch failed");
      const data = await res.json();
      const route = KPR.storage.normalizeFileData(data);
      const result = await KPR.storage.applyRoute(route);
      if (result && result.ok) {
        close();
      } else {
        // Stops placed but geometry could not be calculated: keep the dialog
        // open so the person can pick another, and explain what happened.
        _setMessage(LOAD_ROUTE_MSG);
      }
    } catch (err) {
      console.error("Failed to load library route:", err);
      _setMessage(LOAD_ERROR_MSG);
    }
  }

  async function open() {
    lastFocus = document.activeElement;
    _setMessage("");
    const container = $("browse-list");
    container.textContent = "";
    $("browse-dialog").classList.remove("hidden");
    $("browse-close").focus();

    try {
      const res = await _fetch(MANIFEST_URL);
      if (!res || !res.ok) throw new Error("manifest fetch failed");
      const data = await res.json();
      const routes = data && Array.isArray(data.routes) ? data.routes : [];
      renderList(container, routes);
    } catch (err) {
      // Folder not published yet, or a transient fetch error: a friendly
      // state, never a throw.
      console.error("Failed to load route library:", err);
      container.textContent = "";
      _setMessage(ERROR_MSG);
    }
  }

  function close() {
    $("browse-dialog").classList.add("hidden");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    lastFocus = null;
  }

  function isOpen() {
    return !$("browse-dialog").classList.contains("hidden");
  }

  function _trapTab(e) {
    const focusable = Array.from(
      $("browse-dialog").querySelectorAll("button, textarea, input")
    ).filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function init() {
    // The dialog is opened both from the start chooser (KPR.browseRoutes.open())
    // and, when present, a trigger button. The close/backdrop/Escape handlers
    // must bind regardless of whether a trigger element exists, or the dialog
    // can be opened but never closed.
    const trigger = $("browse-routes");
    if (trigger) trigger.addEventListener("click", open);
    $("browse-close").addEventListener("click", close);
    $("browse-dialog").addEventListener("click", (e) => {
      if (e.target === $("browse-dialog")) close(); // backdrop, not the box
    });
    document.addEventListener("keydown", (e) => {
      if (!isOpen()) return;
      if (e.key === "Escape") close();
      else if (e.key === "Tab") _trapTab(e);
    });
  }

  return {
    init,
    open,
    close,
    isOpen,
    formatMiles,
    formatMinutes,
    renderList,
    selectRoute,
    _setFetch,
  };
})();
