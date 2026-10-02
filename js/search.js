/**
 * search.js — place/address/business search to quickly jump the map and
 * start (or continue) building a route.
 *
 * Uses the Mapbox Search Box API's interactive flow:
 *   1. `/suggest` returns a ranked list of matches (no coordinates).
 *   2. `/retrieve/{mapbox_id}` returns full details + coordinates for the
 *      one the user picks.
 * Both calls share a `session_token`, which Mapbox bills as one session.
 *
 * Why this and not the other Mapbox endpoints (all tried, all verified
 * against the live API with the query "nissan tech center", looking for
 * the Nissan Technical Center North America at 39001 Sunrise Drive,
 * Farmington Hills, MI):
 *   - Geocoding v5 (`mapbox.places`): has no POI type at all. Returned a
 *     street named "Tech Center Court" in Las Vegas.
 *   - Search Box `/forward`: has POIs, but its ranking for short/abbreviated
 *     queries is poor. Without fuzzy mode it returned Nissan dealerships in
 *     Moscow; with `auto_complete=true` and `country=us` it returned only
 *     the Novi building, never the Farmington Hills one, even at limit=10
 *     and with or without proximity.
 *   - Search Box `/suggest`: built for partial, typed queries. Returns both
 *     Michigan buildings plus the other Nissan technical sites, and puts
 *     the Farmington Hills one FIRST when the map is centered on Michigan.
 *
 * Each result shows its address under the name, because "Nissan Technical
 * Center" alone is ambiguous: there are separate buildings in Novi and
 * Farmington Hills a few miles apart.
 *
 * `proximity` biases toward the current map center; `country=us` keeps out
 * international matches (KPR drives are US-based; revisit if that changes).
 */
window.KPR = window.KPR || {};

KPR.search = (function () {
  const SUGGEST_URL = "https://api.mapbox.com/search/searchbox/v1/suggest";
  const RETRIEVE_URL = "https://api.mapbox.com/search/searchbox/v1/retrieve/";
  const MIN_INTERVAL_MS = 300;
  const RESULT_LIMIT = 8;

  let lastRequestAt = 0;
  let sessionToken = _newSessionToken();
  // Coordinates already retrieved this session, keyed by mapbox_id, so
  // clicking a result twice (pan, then add) doesn't re-call /retrieve.
  let retrievedCoords = new Map();

  function init() {
    const input = document.getElementById("search-input");
    const btn = document.getElementById("search-btn");

    btn.addEventListener("click", () => _runSearch(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        _runSearch(input.value);
      }
    });
  }

  async function _runSearch(query) {
    const trimmed = (query || "").trim();
    const resultsList = document.getElementById("search-results");

    if (!trimmed) {
      resultsList.classList.add("hidden");
      resultsList.innerHTML = "";
      return;
    }

    const sinceLastMs = Date.now() - lastRequestAt;
    if (sinceLastMs < MIN_INTERVAL_MS) {
      await _sleep(MIN_INTERVAL_MS - sinceLastMs);
    }
    lastRequestAt = Date.now();

    resultsList.classList.remove("hidden");
    resultsList.innerHTML = `<li class="item-label">Searching...</li>`;
    if (KPR.sheet) KPR.sheet.expand(); // make room for results on mobile

    try {
      const center = KPR.map.getMap().getCenter();
      const url =
        `${SUGGEST_URL}?q=${encodeURIComponent(trimmed)}` +
        `&access_token=${encodeURIComponent(window.KPR_MAPBOX_TOKEN)}` +
        `&session_token=${sessionToken}` +
        `&proximity=${center.lng},${center.lat}` +
        `&country=us` +
        `&limit=${RESULT_LIMIT}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Search request failed (HTTP ${resp.status}).`);
      }
      const data = await resp.json();
      _renderResults(data.suggestions || []);
    } catch (err) {
      console.error("Place search failed:", err);
      resultsList.innerHTML = `<li class="item-label">Search failed: ${_escapeHtml(err.message)}</li>`;
    }
  }

  /** Gets coordinates for a suggestion via /retrieve (cached per session). */
  async function _getCoords(suggestion) {
    const id = suggestion.mapbox_id;
    if (retrievedCoords.has(id)) return retrievedCoords.get(id);

    const url =
      `${RETRIEVE_URL}${encodeURIComponent(id)}` +
      `?access_token=${encodeURIComponent(window.KPR_MAPBOX_TOKEN)}` +
      `&session_token=${sessionToken}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Could not load that location (HTTP ${resp.status}).`);
    }
    const data = await resp.json();
    const feature = data.features && data.features[0];
    if (!feature) {
      throw new Error("Could not load that location.");
    }
    // GeoJSON order is [lng, lat].
    const [lng, lat] = feature.geometry.coordinates;
    const coords = { lat, lng };
    retrievedCoords.set(id, coords);
    return coords;
  }

  /** A /retrieve call closes the billing session; start a fresh one for
   * the next search so sessions don't get reused across searches. */
  function _resetSession() {
    sessionToken = _newSessionToken();
    retrievedCoords = new Map();
  }

  function _renderResults(suggestions) {
    const resultsList = document.getElementById("search-results");
    resultsList.innerHTML = "";

    if (!suggestions || suggestions.length === 0) {
      resultsList.innerHTML = `<li class="item-label">No matches found.</li>`;
      return;
    }

    suggestions.forEach((s) => {
      const name = s.name || "Unnamed location";
      const address = s.full_address || s.place_formatted || "";

      const li = document.createElement("li");
      li.classList.add("search-result");
      li.innerHTML = `
        <span class="item-label search-result-text" title="${_escapeHtml(address || name)}">
          <span class="search-result-name">${_escapeHtml(name)}</span>
          ${address ? `<span class="search-result-addr">${_escapeHtml(address)}</span>` : ""}
        </span>
        <button class="remove-btn add-waypoint-btn" title="Add as waypoint">+</button>
      `;

      // Clicking the result text pans/zooms the map there, so the user can
      // look around before committing to adding a waypoint.
      li.querySelector(".search-result-text").addEventListener("click", async () => {
        try {
          const { lat, lng } = await _getCoords(s);
          KPR.map.getMap().flyTo({ center: [lng, lat], zoom: 15 });
        } catch (err) {
          alert(err.message);
        }
      });

      li.querySelector(".add-waypoint-btn").addEventListener("click", async () => {
        try {
          const { lat, lng } = await _getCoords(s);
          // The search result already names the place, so the itinerary
          // shows "Nissan Technical Center North America" rather than
          // whichever street the point happens to sit on.
          KPR.waypoints.addWaypoint(lat, lng, {
            name,
            detail: (s.full_address || s.place_formatted || "").replace(/,?\s*United States$/, ""),
          });
          KPR.map.getMap().flyTo({ center: [lng, lat], zoom: 15 });
          _resetSession();
        } catch (err) {
          alert(err.message);
        }
      });

      resultsList.appendChild(li);
    });
  }

  function _newSessionToken() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    // Fallback UUIDv4 for older browsers.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return { init };
})();
