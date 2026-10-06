/**
 * ratings.js — the on-device record of scene ratings, plus the small pure
 * rules around it. No DOM and no Mapbox: it only talks to localStorage, and
 * tests can swap that for a fake with useStorage().
 *
 * One "session" is one drive: which route, which vehicle, who drove, and a
 * Good/Bad rating per scene. It is written to localStorage after EVERY tap,
 * so closing the tab mid-drive loses nothing, and the results can be sent
 * at any later time (even after a reload, when the route is no longer on the
 * map), which is why a session also keeps a snapshot of the route it was
 * driven on (`routePayload`, the same compact shape a share link uses).
 *
 * Keys in localStorage (all read defensively; localStorage is same-origin
 * but is still treated as untrusted and rebuilt into fresh objects):
 *   kprSessions      array of sessions, oldest first, at most 20
 *   kprEvaluator     the evaluator's name, last used (<= 60)
 *   kprLastVehicle   last vehicle picked per route fingerprint, at most 50
 *                    (stored as [[fingerprint, vehicle], ...] so the
 *                    "oldest dropped" order is exact)
 *   kprVehicles      the last vehicle list typed in the planner
 *
 * Storage can fail (private mode, quota). Nothing here ever throws because
 * of that: a write that fails first drops the oldest finished sessions and
 * retries, and if it still fails the data stays in memory for this page and
 * the call reports {ok:false} so the UI can say so quietly.
 */
window.KPR = window.KPR || {};

KPR.ratings = (function () {
  const KEY_SESSIONS = "kprSessions";
  const KEY_EVALUATOR = "kprEvaluator";
  const KEY_LAST_VEHICLE = "kprLastVehicle";
  const KEY_VEHICLES = "kprVehicles";

  const MAX_SESSIONS = 20;
  const MAX_LAST_VEHICLE = 50;
  const MAX_EVALUATOR = 60;
  const MAX_VEHICLE = 80;
  const MAX_TEXT = 200;
  const MAX_SCENES = 100;
  const MAX_START_MS = 4102444800000;

  // After the vehicle leaves a scene, the rating buttons stay available for
  // this long so a rating can still be given just after passing it.
  const RATE_GRACE_SECONDS = 15;

  // ---------------------------------------------------------------------
  // Storage access (with a test seam)
  // ---------------------------------------------------------------------

  let store = null; // null = use window.localStorage
  let sessions = null; // in-memory copy, loaded lazily from storage
  let activeId = null; // the drive in progress (never evicted)
  let seq = 0;

  function _store() {
    if (store) return store;
    try {
      return window.localStorage;
    } catch (err) {
      return null; // even touching localStorage can throw (blocked storage)
    }
  }

  function _read(key) {
    try {
      const s = _store();
      return s ? s.getItem(key) : null;
    } catch (err) {
      return null;
    }
  }

  function _write(key, value) {
    try {
      const s = _store();
      if (!s) return false;
      s.setItem(key, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  function _remove(key) {
    try {
      const s = _store();
      if (s) s.removeItem(key);
    } catch (err) {
      /* nothing to do */
    }
  }

  /** Test seam: use `obj` (getItem/setItem/removeItem) instead of
   * localStorage. Pass null to go back. Forgets everything held in memory. */
  function useStorage(obj) {
    store = obj || null;
    sessions = null;
    activeId = null;
  }

  // ---------------------------------------------------------------------
  // Route fingerprint
  // ---------------------------------------------------------------------

  /** 53-bit string hash (cyrb53); no dependencies. */
  function _cyrb53(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  // 4 decimals is about 11 m, so a Directions re-snap of a few metres gives
  // the same key.
  function _r4(n) {
    return (Math.round(Number(n) * 1e4) / 1e4).toFixed(4);
  }

  /**
   * A short stable key for a route: the stops in order and each scene's
   * start/end, rounded to 4 decimals, hashed. Same route -> same key across
   * reloads and machines. It only drives the soft "remember the last vehicle
   * for this route" feature; a coordinate sitting exactly on a rounding
   * boundary can flip it, which is acceptable for that use.
   */
  function routeFingerprint(waypoints, scenes) {
    const w = (Array.isArray(waypoints) ? waypoints : []).map((p) => (p ? _r4(p.lat) + "," + _r4(p.lng) : "?"));
    const s = (Array.isArray(scenes) ? scenes : []).map((sc) =>
      sc ? [_r4(sc.startLat), _r4(sc.startLng), _r4(sc.endLat), _r4(sc.endLng)].join(",") : "?"
    );
    return _cyrb53("w" + w.join(" ") + "|s" + s.join(" ")).toString(36);
  }

  // ---------------------------------------------------------------------
  // Validation of stored data (always into fresh objects)
  // ---------------------------------------------------------------------

  const _isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const _isStr = (v, max) => typeof v === "string" && v.length <= max;
  const _isTime = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_START_MS;
  const _numOrNull = (v, limit) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit ? v : null);

  function _cleanRating(r, sceneCount) {
    if (!_isObj(r)) return null;
    if (!Number.isInteger(r.sceneIndex) || r.sceneIndex < 0 || r.sceneIndex >= sceneCount) return null;
    if (r.rating !== "good" && r.rating !== "bad") return null;
    return {
      sceneIndex: r.sceneIndex,
      label: _isStr(r.label, MAX_TEXT) ? r.label : "",
      type: _isStr(r.type, MAX_TEXT) ? r.type : "",
      rating: r.rating,
      at: _isTime(r.at) ? r.at : 0,
      lat: _numOrNull(r.lat, 90),
      lng: _numOrNull(r.lng, 180),
    };
  }

  /** A stored session -> a fresh, checked copy, or null to drop it. The
   * route snapshot is only shape-checked here (the full check happens when a
   * results link is built from it). */
  function _cleanSession(s) {
    if (!_isObj(s)) return null;
    if (!_isStr(s.id, 64) || s.id === "") return null;
    if (!_isStr(s.routeFingerprint, 64)) return null;
    if (!_isStr(s.routeName, MAX_TEXT)) return null;
    if (!_isStr(s.vehicle, MAX_VEHICLE)) return null;
    if (!_isStr(s.evaluator, MAX_EVALUATOR)) return null;
    if (!_isTime(s.startedAt)) return null;
    if (s.endedAt !== null && !_isTime(s.endedAt)) return null;
    if (typeof s.simulated !== "boolean") return null;

    const rp = s.routePayload;
    if (!_isObj(rp) || rp.v !== 1 || !Array.isArray(rp.w) || rp.w.length > 50) return null;
    if (rp.s !== undefined && (!Array.isArray(rp.s) || rp.s.length > MAX_SCENES)) return null;
    let routePayload;
    try {
      routePayload = JSON.parse(JSON.stringify(rp)); // detach from the parsed input
    } catch (err) {
      return null;
    }
    const sceneCount = Array.isArray(routePayload.s) ? routePayload.s.length : 0;

    // One rating per scene: a repeated sceneIndex keeps the later entry.
    const bySlot = new Map();
    (Array.isArray(s.ratings) ? s.ratings : []).forEach((r) => {
      const c = _cleanRating(r, sceneCount);
      if (c) bySlot.set(c.sceneIndex, c);
    });

    return {
      id: s.id,
      routeFingerprint: s.routeFingerprint,
      routeName: s.routeName,
      vehicle: s.vehicle,
      evaluator: s.evaluator,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      simulated: s.simulated,
      routePayload,
      ratings: Array.from(bySlot.values()),
    };
  }

  function _load() {
    if (sessions) return sessions;
    sessions = [];
    const raw = _read(KEY_SESSIONS);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const seen = new Set();
          parsed.forEach((p) => {
            const c = _cleanSession(p);
            if (c && !seen.has(c.id)) {
              seen.add(c.id);
              sessions.push(c);
            }
          });
          if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(sessions.length - MAX_SESSIONS);
        }
      } catch (err) {
        sessions = [];
      }
    }
    return sessions;
  }

  // ---------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------

  function _dropOldestFinished(keepId) {
    const i = sessions.findIndex((s) => s.id !== activeId && s.id !== keepId);
    if (i === -1) return false;
    sessions.splice(i, 1);
    return true;
  }

  /** Write every session. On failure drop the oldest non-active one (never
   * the drive in progress or `keepId`, the session being written) and try
   * again; if nothing is left to drop, give up (data stays in memory). */
  function _persist(keepId) {
    for (;;) {
      if (_write(KEY_SESSIONS, JSON.stringify(sessions))) return true;
      if (!_dropOldestFinished(keepId)) return false;
    }
  }

  function _enforceCap() {
    while (sessions.length > MAX_SESSIONS) {
      if (!_dropOldestFinished()) break;
    }
  }

  const _clone = (v) => JSON.parse(JSON.stringify(v));

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  function _newId(now) {
    seq += 1;
    return "s" + now.toString(36) + "-" + seq.toString(36) + Math.floor(Math.random() * 1679616).toString(36);
  }

  /**
   * Begin a drive. `routePayload` is the compact route snapshot
   * (KPR.codec.buildPayload of the route being driven). Returns a copy of the
   * new session, with `saved` telling whether it reached storage.
   */
  function startSession({ routeFingerprint: fp, routeName, vehicle, evaluator, routePayload, now } = {}) {
    const list = _load();
    const t = Number.isFinite(now) ? Math.floor(now) : Date.now();
    const session = _cleanSession({
      id: _newId(t),
      routeFingerprint: typeof fp === "string" ? fp : "",
      routeName: typeof routeName === "string" ? routeName.slice(0, MAX_TEXT) : "",
      vehicle: typeof vehicle === "string" ? vehicle.slice(0, MAX_VEHICLE) : "",
      evaluator: typeof evaluator === "string" ? evaluator.slice(0, MAX_EVALUATOR) : "",
      startedAt: t,
      endedAt: null,
      simulated: false,
      routePayload,
      ratings: [],
    });
    if (!session) return null; // the snapshot was not usable
    list.push(session);
    activeId = session.id;
    _enforceCap();
    const saved = _persist();
    return Object.assign(_clone(session), { saved });
  }

  function _find(id) {
    return _load().find((s) => s.id === id) || null;
  }

  /**
   * Record (or change) the rating for one scene. `meta` is optional:
   * {label, type, lat, lng, at}. A repeat rating for the same scene replaces
   * the earlier one. Saved to storage before returning.
   * Returns {ok:true} or {ok:false, reason}.
   */
  function rate(sessionId, sceneIndex, rating, meta) {
    const s = _find(sessionId);
    if (!s) return { ok: false, reason: "no-session" };
    if (rating !== "good" && rating !== "bad") return { ok: false, reason: "bad-rating" };
    const sceneCount = Array.isArray(s.routePayload.s) ? s.routePayload.s.length : 0;
    const m = _isObj(meta) ? meta : {};
    const entry = _cleanRating(
      {
        sceneIndex,
        label: m.label,
        type: m.type,
        rating,
        at: Number.isFinite(m.at) ? Math.floor(m.at) : Date.now(),
        lat: m.lat,
        lng: m.lng,
      },
      sceneCount
    );
    if (!entry) return { ok: false, reason: "bad-scene" };

    const i = s.ratings.findIndex((r) => r.sceneIndex === entry.sceneIndex);
    if (i === -1) s.ratings.push(entry);
    else s.ratings[i] = entry;
    return _persist(s.id) ? { ok: true } : { ok: false, reason: "not-saved" };
  }

  function endSession(sessionId, now) {
    const s = _find(sessionId);
    if (!s) return { ok: false, reason: "no-session" };
    s.endedAt = Number.isFinite(now) ? Math.floor(now) : Date.now();
    if (s.endedAt < s.startedAt) s.endedAt = s.startedAt;
    if (activeId === sessionId) activeId = null;
    return _persist(s.id) ? { ok: true } : { ok: false, reason: "not-saved" };
  }

  /** Latches: once a drive used the simulator it stays "simulated". */
  function markSimulated(sessionId) {
    const s = _find(sessionId);
    if (!s) return { ok: false, reason: "no-session" };
    if (s.simulated) return { ok: true };
    s.simulated = true;
    return _persist(s.id) ? { ok: true } : { ok: false, reason: "not-saved" };
  }

  /** Copies of all sessions, oldest first. */
  function listSessions() {
    return _clone(_load());
  }

  function getSession(sessionId) {
    const s = _find(sessionId);
    return s ? _clone(s) : null;
  }

  /** The most recent session with at least one rating, leaving out the drive
   * in progress (so a tab that was killed mid-drive is still recoverable
   * after a reload, when nothing is "in progress" any more). */
  function lastNonEmpty() {
    const list = _load();
    let best = null;
    list.forEach((s) => {
      if (s.id === activeId || s.ratings.length === 0) return;
      if (!best || s.startedAt >= best.startedAt) best = s;
    });
    return best ? _clone(best) : null;
  }

  function deleteSession(sessionId) {
    const list = _load();
    const i = list.findIndex((s) => s.id === sessionId);
    if (i === -1) return { ok: false, reason: "no-session" };
    list.splice(i, 1);
    if (activeId === sessionId) activeId = null;
    return _persist() ? { ok: true } : { ok: false, reason: "not-saved" };
  }

  // ---------------------------------------------------------------------
  // Small remembered values
  // ---------------------------------------------------------------------

  function getEvaluator() {
    const v = _read(KEY_EVALUATOR);
    return typeof v === "string" && v.length <= MAX_EVALUATOR ? v : "";
  }

  function setEvaluator(name) {
    const v = typeof name === "string" ? name.replace(/[\u0000-\u001F]/g, "").trim().slice(0, MAX_EVALUATOR) : "";
    return _write(KEY_EVALUATOR, v);
  }

  function _readLastVehicles() {
    const out = [];
    const raw = _read(KEY_LAST_VEHICLE);
    if (!raw) return out;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return out;
      parsed.forEach((p) => {
        if (!Array.isArray(p) || p.length !== 2 || !_isStr(p[0], 64) || !_isStr(p[1], MAX_VEHICLE)) return;
        if (p[0] === "" || out.some((e) => e[0] === p[0])) return;
        out.push([p[0], p[1]]);
      });
    } catch (err) {
      return [];
    }
    return out.slice(Math.max(0, out.length - MAX_LAST_VEHICLE));
  }

  /** The vehicle last used on the route with this fingerprint, or "". */
  function getLastVehicle(fingerprint) {
    const hit = _readLastVehicles().find((e) => e[0] === fingerprint);
    return hit ? hit[1] : "";
  }

  function setLastVehicle(fingerprint, vehicle) {
    if (!_isStr(fingerprint, 64) || fingerprint === "" || !_isStr(vehicle, MAX_VEHICLE)) return false;
    const list = _readLastVehicles().filter((e) => e[0] !== fingerprint);
    list.push([fingerprint, vehicle]);
    while (list.length > MAX_LAST_VEHICLE) list.shift();
    return _write(KEY_LAST_VEHICLE, JSON.stringify(list));
  }

  /** The last vehicle list typed in the planner (for "Use my last list"). */
  function getVehicleList() {
    const raw = _read(KEY_VEHICLES);
    if (!raw) return [];
    try {
      return KPR.codec.normalizeVehicles(JSON.parse(raw));
    } catch (err) {
      return [];
    }
  }

  function setVehicleList(list) {
    const clean = KPR.codec.normalizeVehicles(list);
    if (clean.length === 0) return false;
    return _write(KEY_VEHICLES, JSON.stringify(clean));
  }

  // ---------------------------------------------------------------------
  // Pure rules
  // ---------------------------------------------------------------------

  /** One character per scene of the session's route snapshot, in snapshot
   * order: g = good, b = bad, - = not rated. This is the `g` of a results
   * link. */
  function buildG(session) {
    const rp = session && session.routePayload;
    const n = rp && Array.isArray(rp.s) ? rp.s.length : 0;
    const chars = new Array(n).fill("-");
    (session && Array.isArray(session.ratings) ? session.ratings : []).forEach((r) => {
      if (!r || !Number.isInteger(r.sceneIndex) || r.sceneIndex < 0 || r.sceneIndex >= n) return;
      if (r.rating === "good") chars[r.sceneIndex] = "g";
      else if (r.rating === "bad") chars[r.sceneIndex] = "b";
    });
    return chars.join("");
  }

  /** {good, bad, rated, total, notRated} for a session. */
  function countRatings(session) {
    const g = buildG(session);
    let good = 0;
    let bad = 0;
    for (let i = 0; i < g.length; i++) {
      if (g[i] === "g") good++;
      else if (g[i] === "b") bad++;
    }
    return { good, bad, rated: good + bad, total: g.length, notRated: g.length - good - bad };
  }

  /**
   * Which scene the rating buttons apply to right now.
   *
   *   state  a plain object the caller keeps between calls ({} to start)
   *   scenes [{startDist, endDist}, ...] in meters along the route
   *   along  meters travelled along the route, or null when unknown
   *   now    ms clock
   *
   * Returns {index, grace:false} while inside a scene, {index, grace:true}
   * for RATE_GRACE_SECONDS after leaving it, else null.
   *   - Inside beats grace. When several scenes contain the point (they
   *     touch at a shared end/start, or overlap) the one that started most
   *     recently wins, so entering the next scene takes over at once.
   *   - Leaving a scene starts the grace for that scene; entering another
   *     scene drops the old grace.
   *   - With no position (along null) nothing changes: a scene we were in
   *     stays current, and a running grace keeps counting down.
   */
  function pickRateTarget(state, scenes, along, now) {
    const graceMs = RATE_GRACE_SECONDS * 1000;
    if (!_isObj(state)) return null;
    if (state.inside === undefined) state.inside = null;
    if (state.graceIndex === undefined) state.graceIndex = null;
    if (state.graceUntil === undefined) state.graceUntil = null;

    const list = Array.isArray(scenes) ? scenes : [];

    if (Number.isFinite(along)) {
      let hit = -1;
      list.forEach((sc, i) => {
        if (!sc || !Number.isFinite(sc.startDist) || !Number.isFinite(sc.endDist)) return;
        if (along < sc.startDist || along > sc.endDist) return;
        if (hit === -1 || sc.startDist >= list[hit].startDist) hit = i;
      });
      if (hit !== -1) {
        state.inside = hit;
        state.graceIndex = null;
        state.graceUntil = null;
        return { index: hit, grace: false };
      }
      if (state.inside !== null) {
        // Just left the scene we were in: start its grace period.
        state.graceIndex = state.inside;
        state.graceUntil = now + graceMs;
        state.inside = null;
      }
    } else if (state.inside !== null) {
      return { index: state.inside, grace: false };
    }

    if (state.graceIndex !== null) {
      if (now <= state.graceUntil) return { index: state.graceIndex, grace: true };
      state.graceIndex = null;
      state.graceUntil = null;
    }
    return null;
  }

  return {
    RATE_GRACE_SECONDS,
    MAX_SESSIONS,
    MAX_LAST_VEHICLE,
    useStorage,
    routeFingerprint,
    startSession,
    rate,
    endSession,
    markSimulated,
    listSessions,
    getSession,
    lastNonEmpty,
    deleteSession,
    getEvaluator,
    setEvaluator,
    getLastVehicle,
    setLastVehicle,
    getVehicleList,
    setVehicleList,
    buildG,
    countRatings,
    pickRateTarget,
  };
})();
