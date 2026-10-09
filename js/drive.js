/**
 * drive.js — Drive mode: follow the planned route from the vehicle.
 *
 * Shows where you are on the route (live GPS, or a simulated drive for
 * demos/testing), turn-by-turn guidance from the Directions API steps,
 * upcoming/current evaluation scene alerts, and remaining time/distance.
 * Layout follows Mapbox's in-car navigation UI: blue next-turn card top
 * left, round controls down the left side, ETA card with a progress bar
 * bottom left, tilted heading-up map that follows the vehicle.
 *
 * The route is NEVER recalculated here. KPR routes are fixed on purpose, so
 * leaving the route shows an "off route" warning instead of a reroute.
 *
 * GPS note: browsers only allow location access on secure pages (https://,
 * or http://localhost on the same computer). Opening this app on a phone
 * over plain http on the local network will not get GPS; it has to be
 * served over https for in-vehicle use. Simulate works anywhere.
 */
window.KPR = window.KPR || {};

KPR.drive = (function () {
  // ---- tuning ------------------------------------------------------------
  const FOLLOW_PITCH = 60;
  const DEFAULT_FOLLOW_ZOOM = 16.5;
  const OFF_ROUTE_METERS = 50;        // farther than this from the line = off route...
  const OFF_ROUTE_FIXES = 3;          // ...for this many fixes in a row
  const BACK_ON_ROUTE_METERS = 30;
  const SEARCH_BACK = 10;             // route segments to search behind the last match
  const SEARCH_AHEAD = 400;           // ...and ahead of it
  const SCENE_HEADS_UP_METERS = 800;  // ~0.5 mi
  const FAR_ANNOUNCE_METERS = 800;
  const NEAR_ANNOUNCE_METERS = 120;
  const ARRIVE_METERS = 30;
  const SIM_BASE_MPS = 15;            // ~34 mph
  const SIM_SPEEDS = [1, 2, 4, 8];
  const SIM_TICK_MS = 500;
  // After the user pans the map away, follow mode comes back on its own once
  // they've stopped touching it for this long (longer after "overview",
  // which is a deliberate look at the whole route).
  const AUTO_RECENTER_MS = 10000;
  const OVERVIEW_RECENTER_MS = 15000;
  const DONE_SOURCE_ID = "kpr-route-done";
  const DONE_LAYER_ID = "kpr-route-done-layer";

  // ---- state -------------------------------------------------------------
  let active = false;
  let route = null;          // [{lat,lng}]
  let cum = [];              // cumulative meters at each route point
  let total = 0;
  let totalDuration = 0;     // seconds, from the Directions response
  let steps = [];            // maneuvers with .startDist
  let stops = [];            // [{name, dist}] waypoints along the route
  let scenes = [];           // [{scene, startDist, endDist}]
  let destName = "";

  let lastIdx = 0;
  let along = 0;
  let offRouteCount = 0;
  let offRoute = false;
  let arrived = false;
  let lastBearing = 0;

  let follow = true;
  let followZoom = DEFAULT_FOLLOW_ZOOM;
  let resumeTimer = null;
  // Last time the user zoomed by hand (scroll, trackpad, pinch), and whether
  // that zoom still needs to be adopted as the new follow zoom.
  let lastUserZoomAt = 0;
  let pendingZoomCapture = false;
  // A mouse button or finger is down on the map. The follow camera holds
  // still meanwhile: a camera move starting right as the press begins would
  // cancel the drag before it gets going.
  let pointerDown = false;
  const USER_ZOOM_SETTLE_MS = 700;
  let voiceOn = true;
  let announced = new Set();

  let watchId = null;
  let simTimer = null;
  let simAlong = 0;
  let simSpeedIdx = 0;
  let wakeLock = null;
  let puck = null;
  let prevMode = "waypoint";

  // Scene ratings (all of this stays idle unless the beta switch was on when
  // the drive started; see start()).
  let betaOn = false;        // KPR.beta.isOn(), read once per drive
  let session = null;        // the on-device rating session for this drive
  let ratingOn = false;      // rating buttons are active for this drive
  let rateState = {};        // caller-owned state for KPR.ratings.pickRateTarget
  let rateIndex = null;      // scene (index into `scenes`) the buttons apply to right now
  let rated = new Map();     // scene index -> "good" | "bad" given this drive
  let rateSaveFailed = false;
  let rateShownKey = "";     // what the status line/buttons currently show
  let graceCardShown = false;  // the alert card is showing a scene we already left
  let graceTimer = null;

  // ---- geometry helpers --------------------------------------------------

  function _hav(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function _bearing(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x =
      Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
      Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /** Nearest point on route segment i to p, in meters (flat-earth
   * approximation around p, which is plenty accurate at street scale). */
  function _projectOnSegment(p, i) {
    const a = route[i];
    const b = route[i + 1];
    const kx = 111320 * Math.cos((p.lat * Math.PI) / 180);
    const ky = 110540;
    const ax = (a.lng - p.lng) * kx;
    const ay = (a.lat - p.lat) * ky;
    const dx = (b.lng - a.lng) * kx;
    const dy = (b.lat - a.lat) * ky;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    return { t, dist: Math.hypot(px, py) };
  }

  /** Snap a GPS fix onto the route. Searches near the last match first, so
   * routes that loop back past themselves don't jump ahead or behind. */
  function _snap(p) {
    const n = route.length - 1;
    const scan = (from, to) => {
      let best = null;
      for (let i = from; i < to; i++) {
        const r = _projectOnSegment(p, i);
        if (!best || r.dist < best.dist) best = { i, t: r.t, dist: r.dist };
      }
      return best;
    };
    let best = scan(Math.max(0, lastIdx - SEARCH_BACK), Math.min(n, lastIdx + SEARCH_AHEAD));
    // Lost the route entirely (e.g. GPS jumped or the drive started far
    // from the start): search the whole thing.
    if (!best || best.dist > 200) {
      const full = scan(0, n);
      if (full && (!best || full.dist < best.dist)) best = full;
    }
    const a = route[best.i];
    const b = route[best.i + 1];
    return {
      idx: best.i,
      dist: best.dist,
      along: cum[best.i] + best.t * (cum[best.i + 1] - cum[best.i]),
      point: { lat: a.lat + (b.lat - a.lat) * best.t, lng: a.lng + (b.lng - a.lng) * best.t },
      bearing: _bearing(a, b),
    };
  }

  /** Point and heading at a given distance along the route (simulation). */
  function _pointAt(d) {
    d = Math.max(0, Math.min(total, d));
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi] - cum[lo] || 1;
    const t = (d - cum[lo]) / segLen;
    const a = route[lo];
    const b = route[hi];
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, bearing: _bearing(a, b) };
  }

  /** Index of the route point nearest p, searching forward from `from`. */
  function _nearestIdxFrom(p, from) {
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < route.length; i++) {
      const d = (route[i].lat - p.lat) ** 2 + (route[i].lng - p.lng) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // ---- formatting --------------------------------------------------------

  function _fmtDist(m) {
    const ft = m * 3.28084;
    if (ft < 1000) return { value: String(Math.max(0, Math.round(ft / 50) * 50)), unit: "ft" };
    const mi = m / 1609.34;
    return { value: mi < 10 ? mi.toFixed(1) : String(Math.round(mi)), unit: "mi" };
  }

  function _spokenDist(m) {
    const d = _fmtDist(m);
    if (d.unit === "ft") return `${d.value} feet`;
    if (d.value === "0.5") return "half a mile";
    if (d.value === "1.0") return "1 mile";
    return `${d.value} miles`;
  }

  function _fmtClock(date) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "\u202f");
  }

  function _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // ---- maneuver icons ----------------------------------------------------

  const ICON_PATHS = {
    straight: '<path d="M12 21V4"/><path d="M6 10l6-6 6 6"/>',
    right: '<path d="M7 21v-8a4 4 0 0 1 4-4h9"/><path d="M15 4l5 5-5 5"/>',
    "slight right": '<path d="M9 21v-7l8-8"/><path d="M10 5h7v7"/>',
    "sharp right": '<path d="M8 21V6"/><path d="M8 6l10 10"/><path d="M18 9v7h-7"/>',
    uturn: '<path d="M16 21V10a4 4 0 0 0-8 0v5"/><path d="M4 11l4 4 4-4"/>',
    arrive: '<path d="M6 21V4"/><path d="M6 4h12l-3 4 3 4H6"/>',
    roundabout: '<circle cx="12" cy="9" r="4"/><path d="M12 21v-8"/><path d="M15 5l2-2v4h-4"/>',
  };

  function _iconFor(maneuver) {
    const type = (maneuver && maneuver.type) || "";
    const mod = (maneuver && maneuver.modifier) || "straight";
    let key;
    let mirror = false;
    if (type === "arrive") key = "arrive";
    else if (type === "roundabout" || type === "rotary" || type === "roundabout turn") key = "roundabout";
    else if (mod === "uturn") key = "uturn";
    else if (mod.endsWith("left")) {
      key = mod.replace("left", "right");
      mirror = true;
    } else key = ICON_PATHS[mod] ? mod : "straight";
    return (
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ` +
      `stroke-linecap="round" stroke-linejoin="round"${mirror ? ' style="transform:scaleX(-1)"' : ""}>` +
      `${ICON_PATHS[key]}</svg>`
    );
  }

  /** Short label for where a maneuver takes you. */
  function _stepLabel(step) {
    if (step.maneuver.type === "arrive") {
      const stop = stops[step.legIndex + 1];
      const isFinal = step.legIndex === stops.length - 2;
      const name = stop && stop.name ? stop.name : "";
      return isFinal ? `Arrive · ${name || "Final stop"}` : `Stop ${step.legIndex + 2}${name ? " · " + name : ""}`;
    }
    return step.name || step.ref || step.maneuver.instruction || "Continue";
  }

  // ---- route data --------------------------------------------------------

  function _prepare() {
    route = KPR.routing.getRouteCoords();
    cum = [0];
    for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + _hav(route[i - 1], route[i]));
    total = cum[cum.length - 1];
    totalDuration = KPR.routing.getSummary().durationSeconds || total / 13;

    // Stops, positioned along the route.
    const wps = KPR.waypoints.getAll();
    let from = 0;
    stops = wps.map((wp, i) => {
      const idx = i === 0 ? 0 : _nearestIdxFrom(wp, from);
      from = idx;
      return { name: wp.name || "", dist: cum[idx] };
    });
    destName = stops.length ? stops[stops.length - 1].name || "Final stop" : "";

    // Maneuvers. "depart" steps right after reaching an intermediate stop
    // just repeat that stop, so they're dropped from the guidance list.
    from = 0;
    steps = [];
    KPR.routing.getSteps().forEach((s, k) => {
      const loc = s.maneuver && s.maneuver.location;
      const idx = loc ? _nearestIdxFrom({ lng: loc[0], lat: loc[1] }, from) : from;
      from = idx;
      if (s.maneuver.type === "depart" && k > 0) return;
      steps.push(Object.assign({}, s, { startDist: cum[idx], key: `step-${k}` }));
    });

    scenes = KPR.scenes.getAll().map((sc) => ({
      scene: sc,
      startDist: cum[Math.min(sc.startIdx, cum.length - 1)],
      endDist: cum[Math.min(sc.endIdx, cum.length - 1)],
    }));
  }

  // ---- start / stop ------------------------------------------------------

  function canStart() {
    const coords = KPR.routing.getRouteCoords();
    return !!(coords && coords.length > 1);
  }

  function start() {
    if (active) return;
    if (!canStart()) {
      alert("Build a route first (at least 2 stops), then start the drive.");
      return;
    }
    if (KPR.results && KPR.results.isActive()) return;

    // Read once: the switch can't change during a drive.
    const beta = KPR.beta.isOn();
    if (beta) {
      const vehicles = KPR.evaluation.getVehicles();
      if (vehicles.length >= 1) {
        // Ask which vehicle first; the drive begins when Start is pressed
        // (Cancel/Escape leave everything as it was).
        if (KPR.evaluation.isVehicleDialogOpen()) return;
        KPR.evaluation.openVehicleDialog(
          { vehicles, fingerprint: _routeFingerprint(), routeName: _routeName() },
          (choice) => _begin({ beta: true, vehicle: choice.vehicle, evaluator: choice.evaluator })
        );
        return;
      }
    }
    _begin({ beta });
  }

  function _routeName() {
    const el = document.getElementById("route-name");
    return (el && el.value.trim()) || "Untitled route";
  }

  function _routeFingerprint() {
    return KPR.ratings.routeFingerprint(KPR.waypoints.getSaveData(), KPR.scenes.getSaveData());
  }

  /** The drive itself. `ctx.beta` says whether the evaluation features are
   * on; `ctx.vehicle` / `ctx.evaluator` come from the vehicle dialog. */
  function _begin(ctx) {
    if (active) return;
    if (!canStart()) return;
    _prepare();
    active = true;
    lastIdx = 0;
    along = 0;
    offRoute = false;
    offRouteCount = 0;
    arrived = false;
    announced = new Set();
    follow = true;
    followZoom = DEFAULT_FOLLOW_ZOOM;

    prevMode = KPR.app.getMode();
    KPR.app.setMode("drive");
    KPR.waypoints.setLocked(true);
    // The planner's own "locate me" (if the user had it tracking) and this
    // mode both want the only GPS watch and the only say over the camera;
    // hand it off cleanly instead of running both at once.
    KPR.map.stopLocate();
    document.body.classList.add("driving");
    document.getElementById("drive-ui").classList.remove("hidden");
    document.getElementById("drive-arrived").classList.add("hidden");
    document.getElementById("drive-offroute").classList.add("hidden");
    KPR.map.applyPanelPadding();

    _createPuck();
    _ensureDoneLayer();
    _requestWakeLock();
    _setFollowUi();
    _setVoiceUi();
    if (ctx.beta) _beginEvaluation(ctx);

    // Start at the beginning of the route until the first GPS fix arrives.
    const p0 = _pointAt(0);
    _update({ lat: p0.lat, lng: p0.lng, accuracy: null, speed: null, heading: null }, { initial: true });

    _say(`Starting route to ${destName}. ${steps[0] ? steps[0].maneuver.instruction : ""}`);
    _startGps();
  }

  function stop() {
    if (!active) return;
    active = false;
    _stopSim();
    _stopGps();
    _clearResume();
    document.getElementById("drive-recenter-pill").classList.add("hidden");
    _releaseWakeLock();
    if (betaOn) {
      _endEvaluation();
      // The drive just saved is now the newest stored one: show it in the
      // planner's "Last drive results" card.
      KPR.evaluation.refreshLastResults();
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (puck) {
      puck.remove();
      puck = null;
    }
    _removeDoneLayer();

    document.body.classList.remove("driving");
    document.getElementById("drive-ui").classList.add("hidden");
    KPR.waypoints.setLocked(false);
    KPR.app.setMode(prevMode === "drive" ? "waypoint" : prevMode);

    const map = KPR.map.getMap();
    map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    KPR.map.applyPanelPadding();
    _fitRoute();
  }

  function isActive() {
    return active;
  }

  // ---- scene ratings (beta) ---------------------------------------------
  // Everything in this section is reached only when the beta switch was on
  // at start(); with it off none of it runs.

  /** Set up the vehicle label and the rating session for this drive. */
  function _beginEvaluation(ctx) {
    betaOn = true;
    session = null;
    ratingOn = false;
    rateState = {};
    rateIndex = null;
    rated = new Map();
    rateSaveFailed = false;
    rateShownKey = "";
    graceCardShown = false;

    const vehicle = ctx.vehicle || "";
    const name = _routeName();
    const wps = KPR.waypoints.getSaveData();
    const savedScenes = KPR.scenes.getSaveData();
    const fingerprint = KPR.ratings.routeFingerprint(wps, savedScenes);

    if (vehicle) {
      KPR.ratings.setLastVehicle(fingerprint, vehicle);
      const chip = document.getElementById("drive-vehicle");
      chip.textContent = vehicle;
      chip.title = vehicle;
      chip.classList.remove("hidden");
    }

    // The session keeps a snapshot of the route it was driven on. Ratings
    // are stored by scene position, so the snapshot must hold exactly the
    // scenes this drive has, in the same order; if it does not (a scene
    // without usable coordinates), rating is left off rather than risk
    // filing a rating under the wrong scene.
    if (scenes.length === 0) return;
    const snapshot = KPR.codec.buildPayload({ name, waypoints: wps, scenes: savedScenes });
    if (!Array.isArray(snapshot.s) || snapshot.s.length !== scenes.length) return;
    session = KPR.ratings.startSession({
      routeFingerprint: fingerprint,
      routeName: name,
      vehicle,
      evaluator: ctx.evaluator || "",
      routePayload: snapshot,
    });
    if (!session) return;
    rateSaveFailed = !session.saved;
    ratingOn = true;
  }

  /** Close the session and put the screen back (badges, labels, timers). */
  function _endEvaluation() {
    clearTimeout(graceTimer);
    graceTimer = null;
    if (ratingOn) scenes.forEach((s) => KPR.scenes.setRatingBadge(s.scene.id, null));
    if (session) KPR.ratings.endSession(session.id);
    _hideRate();
    _hideSendUi();
    graceCardShown = false;
    document.getElementById("drive-vehicle").classList.add("hidden");
    session = null;
    ratingOn = false;
    betaOn = false;
    rateState = {};
    rated = new Map();
  }

  // ---- sending results (beta) -------------------------------------------

  /** The stored copy of this drive's session (the one in `session` is only the
   * snapshot from when the drive began), or null. */
  function _freshSession() {
    return session ? KPR.ratings.getSession(session.id) : null;
  }

  /** The stored session when it has at least one rating, else null. */
  function _ratedSession() {
    if (!ratingOn) return null;
    const s = _freshSession();
    return s && KPR.ratings.countRatings(s).rated >= 1 ? s : null;
  }

  /** Build the link ahead of the tap (see KPR.evaluation.sendResults). */
  function _prewarmLink() {
    const s = _ratedSession();
    if (s) KPR.evaluation.prepareLink(s).catch(() => {});
  }

  function _setArrivedSendUi() {
    const show = arrived && _ratedSession() !== null;
    document.getElementById("arrived-send").classList.toggle("hidden", !show);
    document.getElementById("arrived-done").classList.toggle("arrived-secondary", show);
    if (!show) document.getElementById("arrived-send-status").classList.add("hidden");
    if (show) _prewarmLink();
  }

  function _hideSendUi() {
    document.getElementById("arrived-send").classList.add("hidden");
    document.getElementById("arrived-done").classList.remove("arrived-secondary");
    const st = document.getElementById("arrived-send-status");
    st.textContent = "";
    st.classList.add("hidden");
    _hideExitPrompt();
  }

  function _hideExitPrompt() {
    document.getElementById("drive-exit-prompt").classList.add("hidden");
    const st = document.getElementById("exit-send-status");
    st.textContent = "";
    st.classList.add("hidden");
  }

  /** The × button. With the beta on and at least one rating (and the drive
   * not yet finished) it asks about sending first; every other case ends the
   * drive straight away, as it always did. */
  function requestExit() {
    if (!active) return;
    if (!arrived && _ratedSession()) {
      document.getElementById("drive-exit-prompt").classList.remove("hidden");
      _prewarmLink();
      document.getElementById("exit-send").focus();
      return;
    }
    stop();
  }

  // Tap handlers: sendResults runs synchronously up to navigator.share.
  function _onArrivedSend() {
    const s = _ratedSession();
    if (s) KPR.evaluation.sendResults(s, document.getElementById("arrived-send-status"));
  }

  function _onExitSend() {
    const s = _ratedSession();
    if (!s) {
      stop();
      return;
    }
    KPR.evaluation.sendResults(s, document.getElementById("exit-send-status")).then(() => {
      if (active) stop();
    });
  }

  function _hideRate() {
    document.getElementById("scene-rate").classList.add("hidden");
    document.getElementById("scene-rate-status").classList.add("hidden");
    document.getElementById("drive-scene").classList.remove("has-rate");
    rateIndex = null;
    rateShownKey = "";
  }

  /** Write a scene into the alert card (used for a scene we just left, or when
   * two scenes overlap and the card is showing the other one). */
  function _fillSceneCard(entry, kicker, distText) {
    const sc = entry.scene;
    const card = document.getElementById("drive-scene");
    card.classList.remove("hidden");
    card.style.setProperty("--scene-color", sc.color);
    document.getElementById("scene-alert-kicker").textContent = kicker;
    document.getElementById("scene-alert-dist").textContent = distText;
    document.getElementById("scene-alert-label").textContent = sc.label;
    const notesEl = document.getElementById("scene-alert-notes");
    notesEl.textContent = sc.notes || "";
    notesEl.classList.toggle("hidden", !sc.notes);
  }

  /** Make the buttons and status line match what is stored for the scene
   * they currently apply to. Only touches the DOM when something changed, so
   * the status line (a live region) isn't re-read on every GPS fix. */
  function _reflectRating() {
    const r = rateIndex === null ? null : rated.get(rateIndex) || null;
    const key = `${rateIndex}:${r}:${rateSaveFailed}`;
    if (key === rateShownKey) return;
    rateShownKey = key;
    document.getElementById("rate-good").setAttribute("aria-pressed", r === "good" ? "true" : "false");
    document.getElementById("rate-bad").setAttribute("aria-pressed", r === "bad" ? "true" : "false");
    let text = "Tap to rate this scene";
    if (rateSaveFailed) text = "Could not save ratings on this device";
    else if (r === "good") text = "Saved: Good - tap to change";
    else if (r === "bad") text = "Saved: Bad - tap to change";
    document.getElementById("scene-rate-status").textContent = text;
  }

  /**
   * Decide which scene the Good/Bad buttons apply to and show them. Runs
   * after _updateScenes, so the alert card (and the voice announcements)
   * are exactly what they are without ratings; this only adds the buttons
   * and, for the 15 s after leaving a scene, puts that scene back in the card.
   * `fromTimer` is the grace timer firing with no new GPS fix.
   */
  function _updateRating(fromTimer) {
    if (!ratingOn) return;
    const now = Date.now();
    const target = KPR.ratings.pickRateTarget(rateState, scenes, along, now);
    clearTimeout(graceTimer);
    graceTimer = null;

    const card = document.getElementById("drive-scene");
    if (!target) {
      _hideRate();
      // Grace ran out with no new fix: nothing else will hide the card we
      // put the finished scene in. (On a fix, _updateScenes has already
      // decided what the card shows, so leave it alone.)
      if (fromTimer && graceCardShown) card.classList.add("hidden");
      graceCardShown = false;
      return;
    }

    const entry = scenes[target.index];
    if (target.grace) {
      _fillSceneCard(entry, `Just finished - ${entry.scene.typeLabel} scene`, "");
      graceCardShown = true;
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (active) _updateRating(true);
      }, Math.max(0, rateState.graceUntil - now) + 50);
    } else {
      graceCardShown = false;
      // Overlapping scenes: _updateScenes shows the first one; the buttons
      // belong to the one that started last, so the card must show that one.
      const shown = scenes.find((s) => along >= s.startDist && along <= s.endDist);
      if (shown !== entry) {
        const left = _fmtDist(Math.max(0, entry.endDist - along));
        _fillSceneCard(entry, `Now · ${entry.scene.typeLabel} scene`, `${left.value} ${left.unit} left`);
      }
    }

    rateIndex = target.index;
    document.getElementById("scene-rate").classList.remove("hidden");
    document.getElementById("scene-rate-status").classList.remove("hidden");
    card.classList.add("has-rate");
    _reflectRating();
  }

  function _onRate(rating) {
    if (!ratingOn || !session || rateIndex === null) return;
    const entry = scenes[rateIndex];
    if (!entry) return;
    const p = puck ? puck.getLngLat() : null;
    const res = KPR.ratings.rate(session.id, rateIndex, rating, {
      label: entry.scene.label,
      type: entry.scene.typeLabel,
      lat: p ? p.lat : null,
      lng: p ? p.lng : null,
      at: Date.now(),
    });
    // "not-saved" means the rating is held in memory for this page but could
    // not be written to the device; everything else means it was not taken.
    if (res.ok || res.reason === "not-saved") {
      rated.set(rateIndex, rating);
      KPR.scenes.setRatingBadge(entry.scene.id, rating);
      // The stored session changed, so the link built earlier is stale.
      _prewarmLink();
      if (arrived) _setArrivedSendUi();
    }
    rateSaveFailed = !res.ok;
    _reflectRating();
  }

  function _fitRoute() {
    const map = KPR.map.getMap();
    if (!route || route.length < 2) return;
    const first = [route[0].lng, route[0].lat];
    const bounds = route.reduce((b, c) => b.extend([c.lng, c.lat]), new mapboxgl.LngLatBounds(first, first));
    map.fitBounds(bounds, { padding: KPR.map.getFitPadding(), pitch: 0, bearing: 0, duration: 800 });
  }

  // ---- position sources --------------------------------------------------

  function _startGps() {
    if (!("geolocation" in navigator)) {
      _setGps("No GPS on this device · use ▶ to simulate", "warn");
      return;
    }
    if (!window.isSecureContext) {
      _setGps("GPS needs an https:// page · use ▶ to simulate", "warn");
      return;
    }
    _setGps("Waiting for GPS…", "");
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (simTimer) return; // simulation is driving the position
        const c = pos.coords;
        _update({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, speed: c.speed, heading: c.heading });
      },
      (err) => {
        if (simTimer) return;
        if (err.code === err.PERMISSION_DENIED) {
          // Tell people where the switch actually lives on their device.
          const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
          _setGps(
            ios
              ? "Location blocked · Settings › Privacy › Location Services › Safari Websites"
              : "Location blocked · allow it in the browser's site settings · ▶ to simulate",
            "warn"
          );
        } else if (err.code === err.TIMEOUT) {
          // Common in parking garages or right after launch; watchPosition
          // keeps trying, so don't make it sound fatal.
          _setGps("Still searching for GPS… · ▶ to simulate", "warn");
        } else {
          _setGps("GPS unavailable · use ▶ to simulate", "warn");
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  function _stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function toggleSim() {
    if (simTimer) {
      _stopSim();
      _setGps(watchId !== null ? "Simulation paused · waiting for GPS…" : "Simulation paused", "");
      return;
    }
    if (arrived) {
      // Replay from the start.
      arrived = false;
      lastIdx = 0;
      along = 0;
      offRoute = false;
      offRouteCount = 0;
      announced = new Set();
      document.getElementById("drive-arrived").classList.add("hidden");
      if (ratingOn) _hideSendUi();
      document.getElementById("drive-offroute").classList.add("hidden");
      simAlong = 0;
      // Back at the start: a scene left at the end of the last run is not
      // "just finished" any more.
      if (ratingOn) rateState = {};
    } else {
      simAlong = along;
    }
    // A simulated run must never pass for a real evaluation.
    if (session) KPR.ratings.markSimulated(session.id);
    simTimer = setInterval(_simTick, SIM_TICK_MS);
    _setSimUi();
  }

  function _simTick() {
    const mps = SIM_BASE_MPS * SIM_SPEEDS[simSpeedIdx];
    simAlong += mps * (SIM_TICK_MS / 1000);
    const p = _pointAt(simAlong);
    _update({ lat: p.lat, lng: p.lng, accuracy: 5, speed: mps, heading: p.bearing }, { sim: true });
    if (simAlong >= total) _stopSim();
  }

  function _stopSim() {
    if (simTimer) clearInterval(simTimer);
    simTimer = null;
    _setSimUi();
  }

  function cycleSimSpeed() {
    simSpeedIdx = (simSpeedIdx + 1) % SIM_SPEEDS.length;
    _setSimUi();
  }

  // ---- the per-fix update ------------------------------------------------

  function _update(fix, opts = {}) {
    if (!active) return;
    const snap = _snap(fix);
    lastIdx = snap.idx;

    // Off-route check, with a little allowance for poor GPS accuracy.
    const limit = Math.max(OFF_ROUTE_METERS, (fix.accuracy || 0) * 1.5);
    if (!opts.initial) {
      if (snap.dist > limit) offRouteCount++;
      else if (snap.dist < BACK_ON_ROUTE_METERS) offRouteCount = 0;
      const nowOff = offRouteCount >= OFF_ROUTE_FIXES;
      if (nowOff !== offRoute) {
        offRoute = nowOff;
        document.getElementById("drive-offroute").classList.toggle("hidden", !offRoute);
        if (offRoute) _say("You are off the planned route. Head back to the highlighted route.");
      }
    }

    // Progress only moves forward while on route (GPS jitter shouldn't
    // make the remaining distance tick back up).
    if (!offRoute) along = opts.initial ? snap.along : Math.max(along - 20, snap.along);

    const onLine = !offRoute;
    const pos = onLine ? snap.point : { lat: fix.lat, lng: fix.lng };
    let bearing = lastBearing;
    if (onLine) bearing = snap.bearing;
    else if (fix.heading != null && !Number.isNaN(fix.heading) && (fix.speed || 0) > 1) bearing = fix.heading;
    lastBearing = bearing;

    puck.setLngLat([pos.lng, pos.lat]).setRotation(bearing);
    _updateDoneLine(snap, onLine);

    // While the user is mid-zoom (scroll/trackpad/pinch), hold the camera:
    // starting an easeTo would cancel their zoom halfway. Once they've
    // stopped for USER_ZOOM_SETTLE_MS, adopt whatever zoom they landed on
    // and keep following at that level.
    const zoomingNow = Date.now() - lastUserZoomAt < USER_ZOOM_SETTLE_MS;
    if (follow && !zoomingNow && pendingZoomCapture) {
      followZoom = Math.max(12, Math.min(19, KPR.map.getMap().getZoom()));
      pendingZoomCapture = false;
    }
    if (follow && !zoomingNow && !pointerDown) {
      const map = KPR.map.getMap();
      map.easeTo({
        center: [pos.lng, pos.lat],
        bearing,
        pitch: FOLLOW_PITCH,
        zoom: followZoom,
        // Puts the vehicle in the lower part of the screen, so more of the
        // road ahead is visible (like in-car navigation).
        padding: { top: Math.round(window.innerHeight * 0.4), bottom: 0, left: 0, right: 0 },
        duration: opts.initial ? 1200 : opts.sim ? SIM_TICK_MS : 900,
        easing: (t) => t,
        essential: true,
      });
    }

    _updateGuidance();
    _updateScenes();
    if (ratingOn) _updateRating(false);
    _updateEta();
    _updateSpeed(fix.speed);
    if (!opts.initial && !simTimer) {
      const acc = fix.accuracy != null ? ` · ±${Math.round(fix.accuracy)} m` : "";
      _setGps(`GPS${acc}`, "ok");
    }

    // Arrival at the final stop.
    if (!arrived && along >= total - ARRIVE_METERS) {
      arrived = true;
      _stopSim();
      document.getElementById("drive-arrived").classList.remove("hidden");
      document.getElementById("arrived-name").textContent = destName;
      if (ratingOn) {
        _hideExitPrompt();
        _setArrivedSendUi();
      }
      _say(`You have arrived at ${destName}.`);
    }
  }

  function _updateGuidance() {
    // Next maneuver = first step that starts ahead of us.
    let j = steps.findIndex((s) => s.startDist > along + 5);
    if (j === -1) j = steps.length - 1;
    const step = steps[j];
    const card = document.getElementById("drive-maneuver");
    if (!step) {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");
    const toGo = Math.max(0, step.startDist - along);
    const d = _fmtDist(toGo);
    document.getElementById("mv-icon").innerHTML = _iconFor(step.maneuver);
    document.getElementById("mv-dist").innerHTML = `${d.value}<span class="mv-unit">${d.unit}</span>`;
    document.getElementById("mv-street").textContent = _stepLabel(step);

    // "Then" chip when the following maneuver comes up quickly afterwards.
    const after = steps[j + 1];
    const thenEl = document.getElementById("mv-then");
    if (after && after.startDist - step.startDist < 400) {
      thenEl.classList.remove("hidden");
      document.getElementById("mv-then-icon").innerHTML = _iconFor(after.maneuver);
      document.getElementById("mv-then-street").textContent = _stepLabel(after);
    } else {
      thenEl.classList.add("hidden");
    }

    // Voice: a heads-up far out, then the instruction itself close in.
    const legLen = step.startDist - (steps[j - 1] ? steps[j - 1].startDist : 0);
    const what = step.maneuver.type === "arrive" ? `you'll reach ${_stepLabel(step).replace("·", ",")}` : step.maneuver.instruction;
    if (toGo <= NEAR_ANNOUNCE_METERS && !announced.has(step.key + ":near")) {
      announced.add(step.key + ":near");
      announced.add(step.key + ":far");
      _say(step.maneuver.type === "arrive" ? _stepLabel(step).replace("·", ",") : step.maneuver.instruction);
    } else if (
      toGo <= FAR_ANNOUNCE_METERS &&
      toGo > NEAR_ANNOUNCE_METERS * 2 &&
      legLen > FAR_ANNOUNCE_METERS &&
      !announced.has(step.key + ":far")
    ) {
      announced.add(step.key + ":far");
      _say(`In ${_spokenDist(toGo)}, ${what}`);
    }
  }

  function _updateScenes() {
    const card = document.getElementById("drive-scene");
    const inside = scenes.find((s) => along >= s.startDist && along <= s.endDist);
    const upcoming = scenes
      .filter((s) => s.startDist > along && s.startDist - along <= SCENE_HEADS_UP_METERS)
      .sort((a, b) => a.startDist - b.startDist)[0];

    // Exits get announced once.
    scenes.forEach((s) => {
      if (along > s.endDist && announced.has(s.scene.id + ":in") && !announced.has(s.scene.id + ":out")) {
        announced.add(s.scene.id + ":out");
        _say(`End of ${s.scene.label}.`);
      }
    });

    const show = inside || upcoming;
    if (!show) {
      card.classList.add("hidden");
      return;
    }
    const sc = show.scene;
    card.classList.remove("hidden");
    card.style.setProperty("--scene-color", sc.color);
    if (inside) {
      const left = _fmtDist(inside.endDist - along);
      document.getElementById("scene-alert-kicker").textContent = `Now · ${sc.typeLabel} scene`;
      document.getElementById("scene-alert-dist").textContent = `${left.value} ${left.unit} left`;
      if (!announced.has(sc.id + ":in")) {
        announced.add(sc.id + ":in");
        announced.add(sc.id + ":soon");
        _say(`Starting ${sc.typeLabel} scene: ${sc.label}. ${sc.notes || ""}`);
      }
    } else {
      const d = _fmtDist(upcoming.startDist - along);
      document.getElementById("scene-alert-kicker").textContent = `${sc.typeLabel} scene ahead`;
      document.getElementById("scene-alert-dist").textContent = `in ${d.value} ${d.unit}`;
      if (!announced.has(sc.id + ":soon")) {
        announced.add(sc.id + ":soon");
        _say(`${sc.typeLabel} scene in ${_spokenDist(upcoming.startDist - along)}: ${sc.label}.`);
      }
    }
    document.getElementById("scene-alert-label").textContent = sc.label;
    const notesEl = document.getElementById("scene-alert-notes");
    notesEl.textContent = sc.notes || "";
    notesEl.classList.toggle("hidden", !sc.notes);
  }

  function _updateEta() {
    const remaining = Math.max(0, total - along);
    const secs = total > 0 ? totalDuration * (remaining / total) : 0;
    const eta = new Date(Date.now() + secs * 1000);
    const mi = remaining / 1609.34;
    document.getElementById("eta-time").textContent = _fmtClock(eta);
    document.getElementById("eta-sub").textContent =
      `${Math.max(0, Math.round(secs / 60))} min · ${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
    document.getElementById("eta-dest").textContent = destName;

    const pct = total > 0 ? Math.min(100, (along / total) * 100) : 0;
    document.getElementById("eta-fill").style.width = `${pct}%`;
    document.getElementById("eta-thumb").style.left = `${pct}%`;

    const nextStopIdx = stops.findIndex((s, i) => i > 0 && s.dist > along + 20);
    document.getElementById("eta-next-stop").textContent =
      nextStopIdx === -1 ? `${stops.length} stops` : `Next: stop ${nextStopIdx + 1} of ${stops.length}`;
  }

  function _updateSpeed(mps) {
    const el = document.getElementById("drive-speed");
    if (mps == null || Number.isNaN(mps)) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    document.getElementById("drive-speed-val").textContent = String(Math.round(mps * 2.23694));
  }

  // ---- map pieces --------------------------------------------------------

  function _createPuck() {
    const el = document.createElement("div");
    el.className = "drive-puck";
    el.innerHTML =
      '<svg viewBox="0 0 48 48"><path d="M24 5 L39 40 L24 32 L9 40 Z" ' +
      'fill="#38e0ff" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/></svg>';
    puck = new mapboxgl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" })
      .setLngLat([route[0].lng, route[0].lat])
      .addTo(KPR.map.getMap());
  }

  /** Grey line over the part of the route already driven. */
  function _ensureDoneLayer() {
    const map = KPR.map.getMap();
    if (!KPR.map.isStyleReady() || map.getSource(DONE_SOURCE_ID)) return;
    map.addSource(DONE_SOURCE_ID, {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
    });
    const layers = (map.getStyle() && map.getStyle().layers) || [];
    const sceneLayer = layers.find((l) => l.id.startsWith("kpr-scene-layer-"));
    map.addLayer(
      {
        id: DONE_LAYER_ID,
        type: "line",
        source: DONE_SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#8a93a3", "line-width": 6, "line-opacity": 0.9, "line-emissive-strength": 1 },
      },
      sceneLayer ? sceneLayer.id : undefined
    );
  }

  function _removeDoneLayer() {
    const map = KPR.map.getMap();
    if (map.getLayer(DONE_LAYER_ID)) map.removeLayer(DONE_LAYER_ID);
    if (map.getSource(DONE_SOURCE_ID)) map.removeSource(DONE_SOURCE_ID);
  }

  function _updateDoneLine(snap, onLine) {
    const src = KPR.map.getMap().getSource(DONE_SOURCE_ID);
    if (!src || !onLine) return;
    const coords = route.slice(0, snap.idx + 1).map((c) => [c.lng, c.lat]);
    coords.push([snap.point.lng, snap.point.lat]);
    src.setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
  }

  // Style switches wipe GL layers; put the driven-portion line back.
  KPR.map.onStyleReload(() => {
    if (active) _ensureDoneLayer();
  });

  // ---- camera controls ---------------------------------------------------

  function _clearResume() {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
  }

  /** Pause following and schedule the automatic re-center. Called again on
   * every bit of map handling, so the countdown starts from the user's LAST
   * touch, not the first. */
  function _pauseFollow(ms) {
    if (!active) return;
    if (follow) setFollow(false);
    _clearResume();
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (active) setFollow(true);
    }, ms);
  }

  function setFollow(on) {
    follow = on;
    if (on) _clearResume();
    _setFollowUi();
    if (on && puck) {
      const p = puck.getLngLat();
      KPR.map.getMap().easeTo({
        center: [p.lng, p.lat],
        bearing: lastBearing,
        pitch: FOLLOW_PITCH,
        zoom: followZoom,
        padding: { top: Math.round(window.innerHeight * 0.4), bottom: 0, left: 0, right: 0 },
        duration: 700,
      });
    }
  }

  function overview() {
    _pauseFollow(OVERVIEW_RECENTER_MS);
    const map = KPR.map.getMap();
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    const first = [route[0].lng, route[0].lat];
    const bounds = route.reduce((b, c) => b.extend([c.lng, c.lat]), new mapboxgl.LngLatBounds(first, first));
    map.fitBounds(bounds, { padding: { top: 140, bottom: 220, left: 80, right: 80 }, pitch: 0, bearing: 0, duration: 800 });
  }

  function zoom(delta) {
    if (follow) {
      followZoom = Math.max(12, Math.min(19, followZoom + delta));
      setFollow(true);
    } else {
      KPR.map.getMap().easeTo({ zoom: KPR.map.getMap().getZoom() + delta, duration: 300 });
    }
  }

  // ---- voice / wake lock -------------------------------------------------

  function _say(text) {
    if (!voiceOn || !window.speechSynthesis || !text) return;
    const u = new SpeechSynthesisUtterance(text.replace(/\s+/g, " ").trim());
    u.rate = 1;
    window.speechSynthesis.speak(u);
  }

  function toggleVoice() {
    voiceOn = !voiceOn;
    if (!voiceOn && window.speechSynthesis) window.speechSynthesis.cancel();
    _setVoiceUi();
  }

  async function _requestWakeLock() {
    // Keeps the screen on while driving, where supported (https only;
    // iOS/iPadOS Safari 16.4+, Chrome/Edge/Android).
    if (!active || wakeLock || !("wakeLock" in navigator)) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!active) {
        lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      // The OS can drop the lock (low battery, tab hidden, lock screen).
      // Forget it so the next tap / return to the page takes it back.
      lock.addEventListener("release", () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } catch (err) {
      console.info("Screen wake lock not available:", err && err.message);
    }
  }

  // Some browsers (notably iOS) only grant the lock during a user gesture,
  // so any tap while driving retries if we don't currently hold it.
  document.addEventListener("pointerdown", () => {
    if (active && !wakeLock) _requestWakeLock();
  }, { passive: true });

  function _releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  document.addEventListener("visibilitychange", () => {
    // Browsers drop the wake lock when the tab is hidden; take it back.
    if (active && document.visibilityState === "visible") _requestWakeLock();
  });

  // ---- UI state ----------------------------------------------------------

  function _setGps(text, kind) {
    const el = document.getElementById("drive-gps");
    el.textContent = text;
    el.className = `drive-pill${kind ? " " + kind : ""}`;
  }

  function _setFollowUi() {
    document.getElementById("drive-recenter").classList.toggle("active", follow);
    // The small top-left arrow is easy to miss in a car; when follow is off,
    // also show a big "Re-center" button where the eye naturally goes.
    document.getElementById("drive-recenter-pill").classList.toggle("hidden", follow || !active);
  }

  function _setVoiceUi() {
    const btn = document.getElementById("drive-voice");
    btn.classList.toggle("muted", !voiceOn);
    btn.title = voiceOn ? "Mute voice guidance" : "Unmute voice guidance";
  }

  function _setSimUi() {
    const btn = document.getElementById("drive-sim");
    btn.classList.toggle("active", !!simTimer);
    btn.innerHTML = simTimer ? "&#10073;&#10073;" : "&#9654;";
    btn.title = simTimer ? "Pause simulated drive" : "Simulate the drive";
    const speedBtn = document.getElementById("drive-sim-speed");
    speedBtn.textContent = `${SIM_SPEEDS[simSpeedIdx]}×`;
    if (simTimer) _setGps(`Simulating · ${SIM_SPEEDS[simSpeedIdx]}× speed`, "sim");
  }

  // ---- wiring ------------------------------------------------------------

  function init() {
    document.getElementById("start-drive").addEventListener("click", start);
    document.getElementById("drive-exit").addEventListener("click", requestExit);
    document.getElementById("arrived-done").addEventListener("click", stop);
    document.getElementById("arrived-send").addEventListener("click", _onArrivedSend);
    document.getElementById("exit-send").addEventListener("click", _onExitSend);
    document.getElementById("exit-skip").addEventListener("click", stop);
    // Keyboard only: keep Tab inside the exit prompt while it is open, so focus
    // can't wander onto the map controls behind it (the prompt is role=dialog).
    document.getElementById("drive-exit-prompt").addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const btns = [document.getElementById("exit-send"), document.getElementById("exit-skip")].filter(
        (b) => b && !b.disabled
      );
      if (btns.length === 0) return;
      const first = btns[0];
      const last = btns[btns.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    document.getElementById("drive-sim").addEventListener("click", toggleSim);
    document.getElementById("drive-sim-speed").addEventListener("click", cycleSimSpeed);
    document.getElementById("drive-recenter").addEventListener("click", () => setFollow(true));
    document.getElementById("drive-overview").addEventListener("click", overview);
    document.getElementById("drive-voice").addEventListener("click", toggleVoice);
    document.getElementById("drive-zoom-in").addEventListener("click", () => zoom(1));
    document.getElementById("drive-zoom-out").addEventListener("click", () => zoom(-1));

    document.getElementById("drive-recenter-pill").addEventListener("click", () => setFollow(true));

    // On phones the scene alert docks under the turn card (see the phone
    // rules in style.css). That card changes height, so publish its bottom
    // edge as --mv-bottom whenever it resizes.
    const mvCard = document.getElementById("drive-maneuver");
    const driveUi = document.getElementById("drive-ui");
    const publishMvBottom = () => {
      const r = mvCard.getBoundingClientRect();
      if (r.height > 0) driveUi.style.setProperty("--mv-bottom", `${Math.round(r.bottom)}px`);
    };
    if ("ResizeObserver" in window) new ResizeObserver(publishMvBottom).observe(mvCard);
    window.addEventListener("resize", publishMvBottom);

    // Same idea for the ETA card's height (--eta-h): the vehicle label sits
    // just above that card on phones.
    const etaCard = document.getElementById("drive-eta");
    const publishEtaHeight = () => {
      const h = etaCard.getBoundingClientRect().height;
      if (h > 0) driveUi.style.setProperty("--eta-h", `${Math.round(h)}px`);
    };
    if ("ResizeObserver" in window) new ResizeObserver(publishEtaHeight).observe(etaCard);
    window.addEventListener("resize", publishEtaHeight);

    document.getElementById("rate-good").addEventListener("click", () => _onRate("good"));
    document.getElementById("rate-bad").addEventListener("click", () => _onRate("bad"));

    // Panning/rotating/tilting the map by hand pauses follow mode (so you
    // can look around); it resumes automatically after AUTO_RECENTER_MS of
    // no handling, or right away via Re-center. `originalEvent` is only set
    // for real user input, never for our own easeTo camera moves.
    //
    // Zooming does NOT pause it: one stray scroll or trackpad touch used to
    // switch following off for good, leaving the arrow to drive off screen.
    // Now a zoom just becomes the new follow zoom level.
    const map = KPR.map.getMap();
    // A two-finger pinch on a phone/iPad also nudges the map center, which
    // Mapbox reports as a drag. Treat any gesture that went multi-touch as a
    // zoom (keeps following) rather than a pan. The flag resets when the
    // next gesture begins with a single finger.
    let multiTouch = false;
    const canvas = map.getCanvasContainer();
    canvas.addEventListener("touchstart", (e) => {
      if (e.touches.length >= 2) multiTouch = true;
      else if (e.touches.length === 1) multiTouch = false;
    }, { passive: true });
    canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length >= 2) multiTouch = true;
    }, { passive: true });

    ["dragstart", "drag", "dragend"].forEach((ev) =>
      map.on(ev, (e) => {
        if (!active || !e.originalEvent) return;
        if (multiTouch) markUserZoom(e);
        else _pauseFollow(AUTO_RECENTER_MS);
      })
    );
    ["rotatestart", "rotateend", "pitchstart", "pitchend"].forEach((ev) =>
      map.on(ev, (e) => {
        if (active && e.originalEvent) _pauseFollow(AUTO_RECENTER_MS);
      })
    );
    // Every step of a hand zoom fires "zoom" with originalEvent set; our own
    // camera moves never do. The zoom level is read later, once the gesture
    // has settled (see _update), which is more reliable than zoomend: our
    // next follow move can interrupt the gesture's own zoomend.
    const markUserZoom = (e) => {
      if (active && e.originalEvent) {
        lastUserZoomAt = Date.now();
        pendingZoomCapture = true;
      }
    };
    map.on("zoomstart", markUserZoom);
    map.on("zoom", markUserZoom);
    map.on("wheel", markUserZoom);

    map.on("mousedown", () => { pointerDown = true; });
    map.on("touchstart", () => { pointerDown = true; });
    // With touch, only count the gesture as over once the LAST finger lifts
    // (lifting one finger of a pinch shouldn't let the camera jump).
    const release = (e) => {
      if (e && e.touches && e.touches.length > 0) return;
      pointerDown = false;
    };
    ["mouseup", "touchend", "touchcancel", "blur"].forEach((ev) => window.addEventListener(ev, release));
  }

  return { init, start, stop, isActive, canStart, toggleSim };
})();
