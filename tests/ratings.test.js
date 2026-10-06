/**
 * ratings.test.js — js/ratings.js: route fingerprint, the on-device session
 * store (with a fake / throwing storage), and the pure rating rules.
 */
(function () {
  const R = KPR.ratings;

  // ---- helpers -------------------------------------------------------

  /** An in-memory stand-in for localStorage. `opts.setItem` / `opts.getItem`
   * can replace the behaviour (e.g. to throw). */
  function fakeStorage(opts) {
    const data = new Map();
    const o = opts || {};
    return {
      data,
      writes: 0,
      getItem(k) {
        if (o.getItem) return o.getItem(k, data);
        return data.has(k) ? data.get(k) : null;
      },
      setItem(k, v) {
        if (o.setItem) o.setItem(k, v, data);
        else data.set(k, String(v));
        this.writes++;
      },
      removeItem(k) {
        data.delete(k);
      },
    };
  }

  function withStore(store, fn) {
    R.useStorage(store);
    try {
      return fn();
    } finally {
      R.useStorage(null);
    }
  }

  const WPS = [
    { lat: 36.1, lng: -115.1 },
    { lat: 36.2, lng: -115.2 },
  ];
  const SCS = [
    { startLat: 36.12, startLng: -115.12, endLat: 36.14, endLng: -115.14 },
    { startLat: 36.15, startLng: -115.15, endLat: 36.18, endLng: -115.18 },
  ];

  function appRoute() {
    return {
      name: "Loop A",
      waypoints: [
        { lat: 36.1, lng: -115.1, name: "Start", detail: "" },
        { lat: 36.2, lng: -115.2, name: "End", detail: "" },
      ],
      scenes: [
        { type: "NVH", typeLabel: "NVH", label: "One", notes: "", startLat: 36.12, startLng: -115.12, endLat: 36.14, endLng: -115.14 },
        { type: "Braking", typeLabel: "Braking", label: "Two", notes: "", startLat: 36.15, startLng: -115.15, endLat: 36.18, endLng: -115.18 },
        { type: "Handling", typeLabel: "Handling", label: "Three", notes: "", startLat: 36.185, startLng: -115.185, endLat: 36.19, endLng: -115.19 },
      ],
    };
  }

  let clock = 1700000000000;
  function begin(extra) {
    clock += 1000;
    return R.startSession(
      Object.assign(
        {
          routeFingerprint: "fp1",
          routeName: "Loop A",
          vehicle: "Ariya #1",
          evaluator: "Pat",
          routePayload: KPR.codec.buildPayload(appRoute()),
          now: clock,
        },
        extra
      )
    );
  }

  const stored = (store) => JSON.parse(store.data.get("kprSessions"));

  // ---- fingerprint ---------------------------------------------------

  test("fingerprint: stable across calls, a short base36 string", () => {
    const a = R.routeFingerprint(WPS, SCS);
    assert.equal(a, R.routeFingerprint(WPS, SCS));
    assert.ok(/^[0-9a-z]{4,20}$/.test(a), a);
    assert.equal(a, R.routeFingerprint(JSON.parse(JSON.stringify(WPS)), JSON.parse(JSON.stringify(SCS))), "same values, different objects");
  });

  test("fingerprint: ignores jitter below 4 decimals, notices real moves", () => {
    const base = R.routeFingerprint(WPS, SCS);
    const jitter = (list, keys) => list.map((p) => Object.assign({}, p, ...keys.map((k) => ({ [k]: p[k] + 0.00001 }))));
    assert.equal(R.routeFingerprint(jitter(WPS, ["lat", "lng"]), SCS), base, "stop jitter");
    assert.equal(R.routeFingerprint(WPS, jitter(SCS, ["startLat", "endLng"])), base, "scene jitter");
    const movedStop = WPS.map((p, i) => (i === 0 ? { lat: p.lat + 0.001, lng: p.lng } : p));
    assert.ok(R.routeFingerprint(movedStop, SCS) !== base, "moved stop");
    const movedScene = SCS.map((s, i) => (i === 1 ? Object.assign({}, s, { endLat: s.endLat + 0.001 }) : s));
    assert.ok(R.routeFingerprint(WPS, movedScene) !== base, "moved scene end");
  });

  test("fingerprint: order and content matter", () => {
    const base = R.routeFingerprint(WPS, SCS);
    assert.ok(R.routeFingerprint(WPS.slice().reverse(), SCS) !== base, "stop order");
    assert.ok(R.routeFingerprint(WPS, SCS.slice().reverse()) !== base, "scene order");
    assert.ok(R.routeFingerprint(WPS.slice(0, 1), SCS) !== base, "fewer stops");
    assert.ok(R.routeFingerprint(WPS, SCS.slice(0, 1)) !== base, "fewer scenes");
    assert.ok(R.routeFingerprint(WPS, []) !== base, "no scenes");
  });

  test("fingerprint: junk input does not throw", () => {
    [[null, null], [undefined, undefined], [[null], [null]], ["x", 5], [[{}], [{}]]].forEach(([w, s]) => {
      assert.equal(typeof R.routeFingerprint(w, s), "string");
    });
  });

  // ---- sessions: persistence ----------------------------------------

  test("session: startSession stores the snapshot and is readable from storage", () => {
    const st = fakeStorage();
    withStore(st, () => {
      const s = begin();
      assert.equal(s.saved, true);
      const raw = stored(st);
      assert.equal(raw.length, 1);
      assert.equal(raw[0].id, s.id);
      assert.equal(raw[0].vehicle, "Ariya #1");
      assert.equal(raw[0].evaluator, "Pat");
      assert.equal(raw[0].endedAt, null);
      assert.equal(raw[0].simulated, false);
      assert.equal(raw[0].routePayload.s.length, 3);
      assert.deepEqual(raw[0].ratings, []);
    });
  });

  test("session: a tap is in storage immediately (write after every rate)", () => {
    const st = fakeStorage();
    withStore(st, () => {
      const s = begin();
      const writesBefore = st.writes;
      const res = R.rate(s.id, 1, "good", { label: "Two", type: "Braking", lat: 36.16, lng: -115.16, at: 1700000005000 });
      assert.deepEqual(res, { ok: true });
      assert.equal(st.writes, writesBefore + 1, "exactly one write per tap");
      const raw = stored(st)[0];
      assert.deepEqual(raw.ratings, [
        { sceneIndex: 1, label: "Two", type: "Braking", rating: "good", at: 1700000005000, lat: 36.16, lng: -115.16 },
      ]);
      R.rate(s.id, 0, "bad");
      assert.equal(stored(st)[0].ratings.length, 2);
      assert.equal(st.writes, writesBefore + 2);
    });
  });

  test("session: a repeat rating for the same scene overwrites it", () => {
    const st = fakeStorage();
    withStore(st, () => {
      const s = begin();
      R.rate(s.id, 2, "good", { at: 1700000001000 });
      R.rate(s.id, 2, "bad", { at: 1700000002000 });
      const r = stored(st)[0].ratings;
      assert.equal(r.length, 1);
      assert.equal(r[0].rating, "bad");
      assert.equal(r[0].at, 1700000002000);
    });
  });

  test("session: rate rejects unknown sessions, ratings and scenes without throwing", () => {
    withStore(fakeStorage(), () => {
      const s = begin();
      assert.equal(R.rate("nope", 0, "good").ok, false);
      assert.equal(R.rate(s.id, 0, "great").ok, false);
      assert.equal(R.rate(s.id, 0, "GOOD").ok, false);
      assert.equal(R.rate(s.id, 3, "good").ok, false, "past the last scene");
      assert.equal(R.rate(s.id, -1, "good").ok, false);
      assert.equal(R.rate(s.id, 1.5, "good").ok, false);
      assert.equal(R.rate(s.id, "1", "good").ok, false);
      assert.equal(R.getSession(s.id).ratings.length, 0);
    });
  });

  test("session: endSession, markSimulated (latches) and reload from storage", () => {
    const st = fakeStorage();
    let id;
    withStore(st, () => {
      const s = begin();
      id = s.id;
      R.rate(id, 0, "good");
      assert.equal(R.markSimulated(id).ok, true);
      assert.equal(R.markSimulated(id).ok, true);
      assert.equal(R.getSession(id).simulated, true);
      assert.equal(R.endSession(id, clock + 60000).ok, true);
      assert.equal(R.getSession(id).simulated, true, "ending does not clear it");
    });
    // A fresh page: a new module state reads the same data back.
    R.useStorage(st);
    try {
      const back = R.getSession(id);
      assert.equal(back.simulated, true);
      assert.equal(back.endedAt, clock + 60000);
      assert.equal(back.ratings.length, 1);
    } finally {
      R.useStorage(null);
    }
  });

  test("session: 21st session evicts the oldest; the cap is 20", () => {
    const st = fakeStorage();
    withStore(st, () => {
      const ids = [];
      for (let i = 0; i < 21; i++) {
        const s = begin({ routeName: "Drive " + i });
        R.endSession(s.id, clock + 1);
        ids.push(s.id);
      }
      const list = R.listSessions();
      assert.equal(list.length, 20);
      assert.equal(list[0].id, ids[1], "the first one is gone");
      assert.equal(list[19].id, ids[20]);
      assert.equal(stored(st).length, 20);
    });
  });

  test("session: the drive in progress is never the one evicted", () => {
    withStore(fakeStorage(), () => {
      const first = begin();
      for (let i = 0; i < 25; i++) R.endSession(begin().id, clock + 1);
      const last = begin(); // active now
      const ids = R.listSessions().map((s) => s.id);
      assert.equal(ids.length, 20);
      assert.ok(ids.includes(last.id));
      assert.ok(!ids.includes(first.id));
    });
  });

  test("storage: a setItem that throws quota errors evicts old sessions, then succeeds", () => {
    // Pretend the device only has room for two sessions.
    const st = fakeStorage({
      setItem(k, v, data) {
        if (k === "kprSessions" && JSON.parse(v).length > 2) {
          const e = new Error("quota");
          e.name = "QuotaExceededError";
          throw e;
        }
        data.set(k, String(v));
      },
    });
    withStore(st, () => {
      const a = begin();
      R.endSession(a.id, clock + 1);
      const b = begin();
      R.endSession(b.id, clock + 1);
      const c = begin(); // active; the 3-session write fails until the oldest is dropped
      assert.equal(c.saved, true, "start succeeded after evicting");
      const res = R.rate(c.id, 0, "good");
      assert.equal(res.ok, true, "succeeded after eviction");
      const ids = stored(st).map((s) => s.id);
      assert.ok(ids.includes(c.id), "the active drive is kept");
      assert.ok(!ids.includes(a.id), "the oldest was evicted");
      assert.equal(stored(st).find((s) => s.id === c.id).ratings.length, 1);
    });
  });

  test("storage: setItem that always throws -> {ok:false}, never throws, rating kept in memory", () => {
    const st = fakeStorage({
      setItem() {
        throw new Error("QuotaExceededError");
      },
    });
    withStore(st, () => {
      const s = begin();
      assert.equal(s.saved, false);
      const res = R.rate(s.id, 0, "bad");
      assert.equal(res.ok, false);
      assert.equal(R.getSession(s.id).ratings.length, 1, "still held in memory for this page");
      assert.equal(R.endSession(s.id).ok, false);
      assert.equal(R.markSimulated(s.id).ok, false);
      assert.equal(R.setEvaluator("Pat"), false);
      assert.equal(R.setLastVehicle("fp", "Ariya"), false);
      assert.equal(R.setVehicleList(["A"]), false);
    });
  });

  test("storage: getItem that throws (private mode) is survivable", () => {
    const st = fakeStorage({
      getItem() {
        throw new Error("SecurityError");
      },
    });
    withStore(st, () => {
      assert.deepEqual(R.listSessions(), []);
      assert.equal(R.lastNonEmpty(), null);
      assert.equal(R.getEvaluator(), "");
      assert.equal(R.getLastVehicle("fp"), "");
      assert.deepEqual(R.getVehicleList(), []);
      const s = begin();
      assert.equal(R.rate(s.id, 0, "good").ok, true, "writes still work");
    });
  });

  test("storage: a storage whose every method throws does not break anything", () => {
    // A storage whose every method throws, as when storage is blocked.
    const dead = {
      getItem() { throw new Error("x"); },
      setItem() { throw new Error("x"); },
      removeItem() { throw new Error("x"); },
    };
    withStore(dead, () => {
      const s = begin();
      assert.equal(s.saved, false);
      assert.equal(R.rate(s.id, 0, "good").ok, false);
      assert.equal(R.deleteSession(s.id).ok, false);
    });
  });

  test("storage: tampered JSON is dropped or capped", () => {
    const good = (() => {
      const st = fakeStorage();
      return withStore(st, () => {
        const s = begin();
        R.rate(s.id, 0, "good");
        R.endSession(s.id, clock + 1);
        return stored(st)[0];
      });
    })();
    const mut = (fn) => {
      const c = JSON.parse(JSON.stringify(good));
      fn(c);
      return c;
    };
    const tampered = [
      mut((c) => (c.id = 5)),
      mut((c) => (c.id = "")),
      mut((c) => (c.id = "x".repeat(65))),
      mut((c) => (c.vehicle = "v".repeat(81))),
      mut((c) => (c.evaluator = "e".repeat(61))),
      mut((c) => (c.routeName = "n".repeat(201))),
      mut((c) => (c.startedAt = "yesterday")),
      mut((c) => (c.startedAt = -1)),
      mut((c) => (c.endedAt = "soon")),
      mut((c) => (c.simulated = "yes")),
      mut((c) => (c.routePayload = "route")),
      mut((c) => (c.routePayload = { v: 2, w: [], s: [] })),
      mut((c) => (c.routePayload.w = "x")),
      mut((c) => (c.routePayload.s = Array.from({ length: 101 }, () => []))),
      null,
      5,
      "junk",
      [],
    ];
    const st = fakeStorage();
    const keep = JSON.parse(JSON.stringify(good));
    keep.id = "keeper";
    st.data.set("kprSessions", JSON.stringify(tampered.concat([keep])));
    withStore(st, () => {
      const ids = R.listSessions().map((s) => s.id);
      assert.deepEqual(ids, ["keeper"], "only the untouched record survives");
    });

    // Entry-level tampering drops just that rating; long strings are cut by being rejected to "".
    const rt = JSON.parse(JSON.stringify(good));
    rt.ratings = [
      { sceneIndex: 0, label: "L".repeat(500), type: "T", rating: "good", at: 5, lat: 1, lng: 2 },
      { sceneIndex: 1, label: "", type: "", rating: "excellent", at: 5, lat: 1, lng: 2 },
      { sceneIndex: 99, label: "", type: "", rating: "bad", at: 5, lat: 1, lng: 2 },
      { sceneIndex: 2, label: "ok", type: "ok", rating: "bad", at: "now", lat: 500, lng: "x" },
      { sceneIndex: 2, label: "dup", type: "ok", rating: "good", at: 7, lat: 1, lng: 1 },
      "junk",
    ];
    const st2 = fakeStorage();
    st2.data.set("kprSessions", JSON.stringify([rt]));
    withStore(st2, () => {
      const r = R.listSessions()[0].ratings;
      assert.equal(r.length, 2, "bad entries dropped, duplicate scene collapsed");
      assert.equal(r[0].label, "", "a 500-char label is not trusted");
      assert.equal(r[1].sceneIndex, 2);
      assert.equal(r[1].label, "dup", "the later entry for a scene wins");
    });

    // Not JSON at all / not an array / too many.
    const st3 = fakeStorage();
    st3.data.set("kprSessions", "{not json");
    withStore(st3, () => assert.deepEqual(R.listSessions(), []));
    st3.data.set("kprSessions", JSON.stringify({ a: 1 }));
    withStore(st3, () => assert.deepEqual(R.listSessions(), []));
    const many = Array.from({ length: 30 }, (_, i) => Object.assign(JSON.parse(JSON.stringify(good)), { id: "m" + i }));
    st3.data.set("kprSessions", JSON.stringify(many));
    withStore(st3, () => {
      const list = R.listSessions();
      assert.equal(list.length, 20);
      assert.equal(list[19].id, "m29", "the newest 20 are kept");
    });
  });

  test("session: returned objects are copies (editing them does not change the store)", () => {
    withStore(fakeStorage(), () => {
      const s = begin();
      R.rate(s.id, 0, "good");
      const copy = R.getSession(s.id);
      copy.ratings.length = 0;
      copy.vehicle = "changed";
      assert.equal(R.getSession(s.id).ratings.length, 1);
      assert.equal(R.getSession(s.id).vehicle, "Ariya #1");
      R.listSessions()[0].ratings.pop();
      assert.equal(R.getSession(s.id).ratings.length, 1);
    });
  });

  test("session: an unusable route snapshot does not start a session", () => {
    withStore(fakeStorage(), () => {
      assert.equal(R.startSession({ routePayload: null }), null);
      assert.equal(R.startSession({ routePayload: { v: 2, w: [] } }), null);
      assert.equal(R.startSession(), null);
      assert.deepEqual(R.listSessions(), []);
    });
  });

  // ---- lastNonEmpty / delete -----------------------------------------

  test("lastNonEmpty: skips empty and active sessions, picks the latest by start time", () => {
    withStore(fakeStorage(), () => {
      assert.equal(R.lastNonEmpty(), null);
      const a = begin();
      R.rate(a.id, 0, "good");
      R.endSession(a.id, clock + 1);
      const b = begin();
      R.endSession(b.id, clock + 1); // empty
      assert.equal(R.lastNonEmpty().id, a.id, "empty session skipped");
      const c = begin(); // active
      R.rate(c.id, 0, "bad");
      assert.equal(R.lastNonEmpty().id, a.id, "active session skipped");
      R.endSession(c.id, clock + 1);
      assert.equal(R.lastNonEmpty().id, c.id, "after it ends it counts");
    });
  });

  test("lastNonEmpty: a session left open by a killed tab is recoverable after a reload", () => {
    const st = fakeStorage();
    let id;
    withStore(st, () => {
      const s = begin();
      id = s.id;
      R.rate(id, 1, "bad"); // tab killed here: no endSession
    });
    R.useStorage(st); // new page: nothing is "active"
    try {
      const last = R.lastNonEmpty();
      assert.ok(last, "found");
      assert.equal(last.id, id);
      assert.equal(last.endedAt, null);
    } finally {
      R.useStorage(null);
    }
  });

  test("deleteSession: removes it from memory and storage", () => {
    const st = fakeStorage();
    withStore(st, () => {
      const a = begin();
      const b = begin();
      assert.equal(R.deleteSession(a.id).ok, true);
      assert.deepEqual(stored(st).map((s) => s.id), [b.id]);
      assert.equal(R.deleteSession(a.id).ok, false, "already gone");
      assert.equal(R.getSession(a.id), null);
    });
  });

  // ---- small remembered values ---------------------------------------

  test("evaluator: get/set, trimmed and capped at 60", () => {
    const st = fakeStorage();
    withStore(st, () => {
      assert.equal(R.getEvaluator(), "");
      assert.equal(R.setEvaluator("  Pat  "), true);
      assert.equal(R.getEvaluator(), "Pat");
      R.setEvaluator("x".repeat(100));
      assert.equal(R.getEvaluator().length, 60);
      st.data.set("kprEvaluator", "y".repeat(500));
      assert.equal(R.getEvaluator(), "", "an oversized stored value is not trusted");
    });
  });

  test("last vehicle per route: get/set, overwrite, and at most 50 kept (oldest dropped)", () => {
    const st = fakeStorage();
    withStore(st, () => {
      assert.equal(R.getLastVehicle("fp1"), "");
      R.setLastVehicle("fp1", "Ariya");
      R.setLastVehicle("fp2", "Leaf");
      assert.equal(R.getLastVehicle("fp1"), "Ariya");
      R.setLastVehicle("fp1", "Rogue");
      assert.equal(R.getLastVehicle("fp1"), "Rogue");
      for (let i = 0; i < 60; i++) R.setLastVehicle("k" + i, "V" + i);
      assert.equal(JSON.parse(st.data.get("kprLastVehicle")).length, 50);
      assert.equal(R.getLastVehicle("fp1"), "", "old entries dropped");
      assert.equal(R.getLastVehicle("k59"), "V59");
      assert.equal(R.getLastVehicle("k10"), "V10");
      assert.equal(R.getLastVehicle("k9"), "");
      // Digit-only fingerprints keep their insertion order.
      R.setLastVehicle("123", "A");
      R.setLastVehicle("45", "B");
      const keys = JSON.parse(st.data.get("kprLastVehicle")).map((e) => e[0]);
      assert.deepEqual(keys.slice(-2), ["123", "45"]);
      // Bad inputs are refused, bad stored data is ignored.
      assert.equal(R.setLastVehicle("", "A"), false);
      assert.equal(R.setLastVehicle("fp", 5), false);
      assert.equal(R.setLastVehicle("fp", "v".repeat(81)), false);
      st.data.set("kprLastVehicle", "{oops");
      assert.equal(R.getLastVehicle("k59"), "");
      st.data.set("kprLastVehicle", JSON.stringify({ k59: "x" }));
      assert.equal(R.getLastVehicle("k59"), "");
    });
  });

  test("vehicle list: stored normalized, read back normalized, empty is not stored", () => {
    const st = fakeStorage();
    withStore(st, () => {
      assert.deepEqual(R.getVehicleList(), []);
      assert.equal(R.setVehicleList([" Ariya ", "ariya", "Leaf"]), true);
      assert.deepEqual(R.getVehicleList(), ["Ariya", "Leaf"]);
      assert.equal(R.setVehicleList([]), false);
      assert.deepEqual(R.getVehicleList(), ["Ariya", "Leaf"], "an empty list does not overwrite the last one");
      st.data.set("kprVehicles", JSON.stringify(["a", 5, "A\u0001b"]));
      assert.deepEqual(R.getVehicleList(), ["a", "Ab"]);
      st.data.set("kprVehicles", "{oops");
      assert.deepEqual(R.getVehicleList(), []);
    });
  });

  // ---- buildG / countRatings -----------------------------------------

  test("buildG: one character per scene of the snapshot", () => {
    const snap = KPR.codec.buildPayload(appRoute()); // 3 scenes
    const sess = (ratings) => ({ routePayload: snap, ratings });
    assert.equal(R.buildG(sess([])), "---");
    assert.equal(R.buildG(sess([{ sceneIndex: 0, rating: "good" }])), "g--");
    assert.equal(R.buildG(sess([{ sceneIndex: 2, rating: "bad" }, { sceneIndex: 0, rating: "good" }])), "g-b");
    assert.equal(R.buildG(sess([{ sceneIndex: 1, rating: "bad" }, { sceneIndex: 1, rating: "good" }])), "-g-", "last entry wins");
    assert.equal(R.buildG(sess([{ sceneIndex: 3, rating: "good" }, { sceneIndex: -1, rating: "good" }, { sceneIndex: 1, rating: "meh" }, null])), "---", "out of range / unknown ignored");
    assert.equal(R.buildG({ routePayload: { v: 1, w: [], s: [] }, ratings: [] }), "");
    assert.equal(R.buildG({ routePayload: { v: 1, w: [] }, ratings: [] }), "", "no s");
    assert.equal(R.buildG(null), "");
    assert.equal(R.buildG({}), "");
  });

  test("buildG agrees with the codec's results payload", () => {
    withStore(fakeStorage(), () => {
      const s = begin();
      R.rate(s.id, 0, "bad");
      R.rate(s.id, 2, "good");
      const sess = R.getSession(s.id);
      assert.equal(R.buildG(sess), "b-g");
      assert.equal(KPR.codec.buildResultsPayload(sess).g, "b-g");
    });
  });

  test("countRatings: good / bad / rated / notRated / total", () => {
    const snap = KPR.codec.buildPayload(appRoute());
    assert.deepEqual(R.countRatings({ routePayload: snap, ratings: [] }), { good: 0, bad: 0, rated: 0, total: 3, notRated: 3 });
    assert.deepEqual(
      R.countRatings({ routePayload: snap, ratings: [{ sceneIndex: 0, rating: "good" }, { sceneIndex: 1, rating: "bad" }] }),
      { good: 1, bad: 1, rated: 2, total: 3, notRated: 1 }
    );
    assert.deepEqual(R.countRatings(null), { good: 0, bad: 0, rated: 0, total: 0, notRated: 0 });
  });

  // ---- pickRateTarget ------------------------------------------------

  const SC = [
    { startDist: 100, endDist: 200 },
    { startDist: 200, endDist: 300 }, // touches scene 0 at 200
    { startDist: 500, endDist: 600 },
  ];
  const SEC = 1000;

  test("pickRateTarget: nothing before any scene, inside wins, null state is harmless", () => {
    const st = {};
    assert.equal(R.pickRateTarget(st, SC, 50, 0), null, "before any scene");
    assert.deepEqual(R.pickRateTarget(st, SC, 150, 1000), { index: 0, grace: false });
    assert.deepEqual(R.pickRateTarget(st, SC, 100, 2000), { index: 0, grace: false }, "start is inside");
    assert.equal(R.pickRateTarget(null, SC, 150, 0), null);
    assert.equal(R.pickRateTarget({}, null, 150, 0), null);
    assert.equal(R.pickRateTarget({}, [null, {}, { startDist: NaN, endDist: 1 }], 0, 0), null);
  });

  test("pickRateTarget: grace of exactly 15 s is valid, 15.001 s has expired", () => {
    assert.equal(R.RATE_GRACE_SECONDS, 15);
    const st = {};
    R.pickRateTarget(st, SC, 250, 0); // inside scene 1 (scene 0 ended at 200)
    const left = 10 * SEC;
    assert.deepEqual(R.pickRateTarget(st, SC, 350, left), { index: 1, grace: true }, "just left");
    assert.deepEqual(R.pickRateTarget(st, SC, 360, left + 14999), { index: 1, grace: true });
    assert.deepEqual(R.pickRateTarget(st, SC, 370, left + 15000), { index: 1, grace: true }, "exactly 15 s");
    assert.equal(R.pickRateTarget(st, SC, 380, left + 15001), null, "15.001 s");
    assert.equal(R.pickRateTarget(st, SC, 390, left + 16000), null, "stays expired");
  });

  test("pickRateTarget: the grace clock starts when the scene is left, not when it was entered", () => {
    const st = {};
    R.pickRateTarget(st, SC, 150, 0);
    R.pickRateTarget(st, SC, 160, 60 * SEC); // a minute inside
    assert.deepEqual(R.pickRateTarget(st, SC, 400, 61 * SEC), { index: 0, grace: true });
    assert.deepEqual(R.pickRateTarget(st, SC, 410, 61 * SEC + 15000), { index: 0, grace: true });
    assert.equal(R.pickRateTarget(st, SC, 420, 61 * SEC + 15001), null);
  });

  test("pickRateTarget: entering a new scene replaces an old grace; inside beats grace", () => {
    const st = {};
    R.pickRateTarget(st, SC, 250, 0); // in scene 1
    assert.deepEqual(R.pickRateTarget(st, SC, 400, 1000), { index: 1, grace: true });
    assert.deepEqual(R.pickRateTarget(st, SC, 550, 2000), { index: 2, grace: false }, "scene 2 takes over");
    assert.deepEqual(R.pickRateTarget(st, SC, 700, 3000), { index: 2, grace: true }, "grace is for scene 2 now");
    assert.equal(R.pickRateTarget(st, SC, 710, 3000 + 15001), null, "and scene 1's old grace did not come back");
  });

  test("pickRateTarget: scenes that touch hand over at the shared point", () => {
    const st = {};
    assert.deepEqual(R.pickRateTarget(st, SC, 199, 0), { index: 0, grace: false });
    assert.deepEqual(R.pickRateTarget(st, SC, 200, 1000), { index: 1, grace: false }, "shared point goes to the one starting there");
    assert.deepEqual(R.pickRateTarget(st, SC, 201, 2000), { index: 1, grace: false });
    assert.equal(st.graceIndex, null, "no grace was started by the hand-over");
  });

  test("pickRateTarget: no position keeps the current state", () => {
    const st = {};
    R.pickRateTarget(st, SC, 150, 0);
    assert.deepEqual(R.pickRateTarget(st, SC, null, 5000), { index: 0, grace: false }, "GPS gap inside a scene");
    assert.deepEqual(R.pickRateTarget(st, SC, undefined, 6000), { index: 0, grace: false });
    assert.deepEqual(R.pickRateTarget(st, SC, NaN, 7000), { index: 0, grace: false });
    R.pickRateTarget(st, SC, 400, 8000); // leave: grace until 23000
    assert.deepEqual(R.pickRateTarget(st, SC, null, 20000), { index: 0, grace: true });
    assert.equal(R.pickRateTarget(st, SC, null, 23001), null, "a running grace still expires");
  });

  test("pickRateTarget: overlapping scenes pick the one that started last", () => {
    const overlap = [
      { startDist: 0, endDist: 500 },
      { startDist: 100, endDist: 200 },
    ];
    assert.deepEqual(R.pickRateTarget({}, overlap, 150, 0), { index: 1, grace: false });
    assert.deepEqual(R.pickRateTarget({}, overlap, 300, 0), { index: 0, grace: false });
  });
})();
