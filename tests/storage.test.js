/**
 * Tests for js/storage.js: file normalizing, the shared applyRoute loader,
 * safeName, and waypoints.loadFrom's quiet option.
 */
(function () {
  const F = window.KPR_FIXTURES;
  const St = KPR.storage;

  function validFile(extra) {
    return Object.assign({ waypoints: [{ lat: 42, lng: -83, name: "A", detail: "B" }] }, extra);
  }

  // ---- normalizeFileData ----------------------------------------------------

  test("normalizeFileData: rejects anything without usable waypoints", () => {
    const msg = "File doesn't look like a KPR route (missing waypoints).";
    [null, undefined, 5, "x", {}, { waypoints: "no" }, { waypoints: [] }, { waypoints: [{ lat: NaN, lng: 1 }, null] }].forEach(
      (bad) => assert.throws(() => St.normalizeFileData(bad), msg)
    );
  });

  test("normalizeFileData: drops bad stops and coerces text fields to strings", () => {
    const out = St.normalizeFileData({
      name: 42,
      waypoints: [
        { lat: 42, lng: -83, name: null, detail: 7 },
        { lat: "42", lng: -83 },
        { lat: Infinity, lng: 0 },
        { lat: 41, lng: -82, name: "Keep", detail: "Me" },
      ],
    });
    assert.equal(out.name, "42");
    assert.deepEqual(out.waypoints, [
      { lat: 42, lng: -83, name: "", detail: "7" },
      { lat: 41, lng: -82, name: "Keep", detail: "Me" },
    ]);
  });

  test("normalizeFileData: scene type must be a known type, else Custom", () => {
    const out = St.normalizeFileData(
      validFile({
        scenes: [
          { type: "Braking", typeLabel: "ignored", label: 1, notes: null, startIdx: 1, endIdx: 2 },
          { type: "Infotainment", typeLabel: "Infotainment", startIdx: 1, endIdx: 2 },
          { type: "toString", startIdx: 1, endIdx: 2 },
          { type: "Custom", typeLabel: 9, startIdx: 1, endIdx: 2 },
          "junk",
          null,
        ],
      })
    );
    assert.equal(out.scenes.length, 4);
    assert.deepEqual([out.scenes[0].type, out.scenes[0].typeLabel], ["Braking", "Braking"]);
    assert.equal(out.scenes[0].label, "1");
    assert.equal(out.scenes[0].notes, "");
    assert.deepEqual([out.scenes[1].type, out.scenes[1].typeLabel], ["Custom", "Infotainment"]);
    assert.equal(out.scenes[2].type, "Custom");
    assert.equal(out.scenes[3].typeLabel, "9");
  });

  test("normalizeFileData: keeps indices only when finite, coordinates only when all valid", () => {
    const out = St.normalizeFileData(
      validFile({
        scenes: [
          { type: "NVH", startIdx: "3", endIdx: NaN },
          { type: "NVH", startIdx: 3, endIdx: 6, startLat: 42, startLng: -83, endLat: 42.01, endLng: -83 },
          { type: "NVH", startIdx: 3, endIdx: 6, startLat: 91, startLng: -83, endLat: 42.01, endLng: -83 },
          { type: "NVH", startIdx: 3, endIdx: 6, startLat: 42, startLng: -83, endLat: 42.01, endLng: 181 },
          { type: "NVH", startIdx: 3, endIdx: 6, startLat: 42, startLng: -83, endLat: 42.01 },
        ],
      })
    );
    assert.equal("startIdx" in out.scenes[0], false);
    assert.equal("endIdx" in out.scenes[0], false);
    assert.deepEqual(
      [out.scenes[1].startLat, out.scenes[1].startLng, out.scenes[1].endLat, out.scenes[1].endLng],
      [42, -83, 42.01, -83]
    );
    [2, 3, 4].forEach((i) => {
      assert.equal("startLat" in out.scenes[i], false);
      assert.equal(out.scenes[i].startIdx, 3);
    });
  });

  test("normalizeFileData: missing or non-array scenes mean no scenes", () => {
    assert.deepEqual(St.normalizeFileData(validFile()).scenes, []);
    assert.deepEqual(St.normalizeFileData(validFile({ scenes: "x" })).scenes, []);
  });

  // ---- safeName -------------------------------------------------------------

  test("safeName: strips path and HTML characters", () => {
    assert.equal(St.safeName("../<b>x</b>"), "bxb");
    assert.equal(St.safeName('a\\b/c:d*e?f"g|h'), "abcdefgh");
    assert.equal(St.safeName("  My Route-1_a  "), "My Route-1_a");
  });

  test("safeName: falls back to 'route' and caps the length", () => {
    assert.equal(St.safeName(""), "route");
    assert.equal(St.safeName(">>>"), "route");
    assert.equal(St.safeName(null), "route");
    assert.equal(St.safeName(undefined), "route");
    assert.equal(St.safeName("a".repeat(200)).length, 80);
  });

  // ---- format v3: optional vehicles ------------------------------------------

  const saveArgs = (extra) =>
    Object.assign(
      {
        name: "V3",
        waypoints: F.v1File.waypoints,
        scenes: [],
        routeCoords: F.oldRoute,
        routeSummary: F.v1File.routeSummary,
        now: 0,
      },
      extra
    );

  test("v3 save: formatVersion is 3 and 'vehicles' is written only when non-empty", () => {
    const without = St.buildSaveData(saveArgs());
    assert.equal(without.formatVersion, 3);
    assert.equal("vehicles" in without, false);
    assert.equal("vehicles" in St.buildSaveData(saveArgs({ vehicles: [] })), false);
    assert.equal("vehicles" in St.buildSaveData(saveArgs({ vehicles: ["", "  "] })), false);
    assert.equal("vehicles" in St.buildSaveData(saveArgs({ vehicles: "nope-not-list" })), true, "a string is one name per line");

    const withList = St.buildSaveData(saveArgs({ vehicles: [" Ariya ", "ariya", "Leaf"] }));
    assert.deepEqual(withList.vehicles, ["Ariya", "Leaf"]);
    // Everything that was in a v2 file is still there.
    ["name", "savedAt", "waypoints", "routeCoords", "routeSummary", "scenes"].forEach((k) =>
      assert.ok(k in withList, k)
    );
  });

  test("v3 round trip: a saved file with vehicles loads them back", () => {
    const file = JSON.parse(JSON.stringify(St.buildSaveData(saveArgs({ vehicles: ["Ariya #1", "Leaf"] }))));
    const back = St.normalizeFileData(file);
    assert.deepEqual(back.vehicles, ["Ariya #1", "Leaf"]);
    assert.equal(back.waypoints.length, 4);
  });

  test("v1 fixture still normalizes to exactly the same route, with no 'vehicles' key", () => {
    const out = St.normalizeFileData(JSON.parse(JSON.stringify(F.v1File)));
    assert.deepEqual(Object.keys(out).sort(), ["name", "scenes", "waypoints"]);
    assert.equal(out.name, "Fixture loop");
    assert.deepEqual(out.waypoints, F.v1File.waypoints.map((w) => ({ lat: w.lat, lng: w.lng, name: w.name, detail: w.detail })));
    assert.deepEqual(out.scenes, [
      { type: "NVH", typeLabel: "NVH", label: "Rough patch", notes: "Expansion joints", startIdx: 2, endIdx: 5 },
      { type: "Custom", typeLabel: "Infotainment", label: "Dead zone", notes: "", startIdx: 6, endIdx: 9 },
      { type: "Braking", typeLabel: "Braking", label: "Hard stop", notes: "From 50 mph", startIdx: 3, endIdx: 9 },
    ]);
  });

  test("a hand-made v2 file (coordinates, no vehicles) normalizes as before, with no 'vehicles' key", () => {
    const v2 = {
      formatVersion: 2,
      name: "Old v2",
      savedAt: "2025-02-02T00:00:00.000Z",
      waypoints: [
        { lat: 42, lng: -83, name: "A", detail: "x" },
        { lat: 42.01, lng: -83, name: "B", detail: "y" },
      ],
      routeCoords: [],
      scenes: [
        {
          type: "NVH",
          typeLabel: "NVH",
          label: "Rough",
          notes: "n",
          startIdx: 1,
          endIdx: 4,
          startLat: 42.001,
          startLng: -83,
          endLat: 42.004,
          endLng: -83,
        },
      ],
    };
    const out = St.normalizeFileData(JSON.parse(JSON.stringify(v2)));
    assert.deepEqual(Object.keys(out).sort(), ["name", "scenes", "waypoints"]);
    assert.deepEqual(out.waypoints, v2.waypoints);
    assert.deepEqual(out.scenes, [
      {
        type: "NVH",
        typeLabel: "NVH",
        label: "Rough",
        notes: "n",
        startIdx: 1,
        endIdx: 4,
        startLat: 42.001,
        startLng: -83,
        endLat: 42.004,
        endLng: -83,
      },
    ]);
  });

  test("a v3 file with vehicles still loads its waypoints and scenes unchanged", () => {
    const base = St.normalizeFileData(JSON.parse(JSON.stringify(F.v1File)));
    const v3 = Object.assign(JSON.parse(JSON.stringify(F.v1File)), { formatVersion: 3, vehicles: ["Ariya"] });
    const out = St.normalizeFileData(v3);
    assert.deepEqual(out.waypoints, base.waypoints);
    assert.deepEqual(out.scenes, base.scenes);
    assert.deepEqual(out.vehicles, ["Ariya"]);
  });

  test("hostile, oversized or non-array vehicles in a file are normalized or ignored", () => {
    const vehiclesOf = (v) => St.normalizeFileData(validFile({ vehicles: v })).vehicles;
    // Not lists at all -> ignored (key absent).
    [undefined, null, 5, true, {}, { 0: "A", length: 1 }, [], ["", "  "], [1, null, {}, []]].forEach((v) => {
      const out = St.normalizeFileData(validFile({ vehicles: v }));
      assert.equal("vehicles" in out, false, JSON.stringify(v));
    });
    // A plain string is read as one name per line, like the planner box.
    assert.deepEqual(vehiclesOf("A\nB"), ["A", "B"]);
    // Mixed junk keeps only the usable names, normalized.
    assert.deepEqual(vehiclesOf(["  A  ", 7, "a", "B\u0001C", null, "\t"]), ["A", "BC"]);
    // Oversized: 31+ names are cut to 30, long names to 80.
    const many = Array.from({ length: 50 }, (_, i) => "Car " + i);
    assert.equal(vehiclesOf(many).length, 30);
    assert.equal(vehiclesOf(["x".repeat(500)])[0].length, 80);
    // Markup stays literal text (the planner only ever puts it in .value / textContent).
    assert.deepEqual(vehiclesOf(["<img src=x onerror=alert(1)>"]), ["<img src=x onerror=alert(1)>"]);
  });
  // ---- applyRoute (with the collaborating modules replaced by stubs) --------

  /** Swap in stubs for the modules applyRoute talks to; returns a restore
   * function and the ordered list of calls they received. */
  function stubApp({ routeCoords, sceneResult }) {
    const calls = [];
    const original = {
      waypoints: KPR.waypoints,
      routing: KPR.routing,
      scenes: KPR.scenes,
      app: KPR.app,
      map: KPR.map,
      mapboxgl: window.mapboxgl,
    };
    KPR.waypoints = {
      loadFrom: (pts, opts) => calls.push(["waypoints.loadFrom", pts.length, opts]),
    };
    KPR.routing = {
      recalculate: async () => {
        calls.push(["routing.recalculate"]);
      },
      getRouteCoords: () => routeCoords,
    };
    KPR.scenes = Object.assign({}, original.scenes, {
      loadFrom: (s) => {
        calls.push(["scenes.loadFrom", s.length]);
        return sceneResult;
      },
    });
    KPR.app = { refreshLists: () => calls.push(["app.refreshLists"]) };
    KPR.map = {
      getFitPadding: () => 40,
      getMap: () => ({ fitBounds: (b, o) => calls.push(["fitBounds", o.padding]) }),
    };
    window.mapboxgl = {
      LngLatBounds: function (a, b) {
        this.extend = () => this;
      },
    };
    return {
      calls,
      restore() {
        KPR.waypoints = original.waypoints;
        KPR.routing = original.routing;
        KPR.scenes = original.scenes;
        KPR.app = original.app;
        KPR.map = original.map;
        window.mapboxgl = original.mapboxgl;
      },
    };
  }

  test("applyRoute: stops (quiet) -> one recalculate -> scenes -> lists -> fit", async () => {
    const stub = stubApp({ routeCoords: F.oldRoute, sceneResult: { loaded: 2, skipped: 1 } });
    try {
      const route = St.normalizeFileData(JSON.parse(JSON.stringify(F.v1File)));
      const result = await St.applyRoute(route);
      assert.deepEqual(result, { ok: true, scenesLoaded: 2, scenesSkipped: 1 });
      assert.equal(document.getElementById("route-name").value, "Fixture loop");
      assert.deepEqual(stub.calls, [
        ["waypoints.loadFrom", 4, { quiet: true }],
        ["routing.recalculate"],
        ["scenes.loadFrom", 3],
        ["app.refreshLists"],
        ["fitBounds", 40],
      ]);
    } finally {
      stub.restore();
    }
  });

  test("applyRoute: no route -> {ok:false, reason:'route'}, stops stay, no scenes", async () => {
    const stub = stubApp({ routeCoords: null, sceneResult: { loaded: 0, skipped: 0 } });
    try {
      const result = await St.applyRoute({ name: "", waypoints: F.v1File.waypoints, scenes: F.v1File.scenes });
      assert.deepEqual(result, { ok: false, reason: "route" });
      assert.equal(document.getElementById("route-name").value, "Untitled route");
      assert.equal(stub.calls.some((c) => c[0] === "scenes.loadFrom" || c[0] === "fitBounds"), false);
    } finally {
      stub.restore();
    }
  });

  // ---- waypoints.loadFrom quiet option --------------------------------------

  test("waypoints.loadFrom: quiet suppresses per-stop notifications, default keeps them", () => {
    // The real js/waypoints.js, run against a tiny fake Marker and map.
    const original = { map: KPR.map, mapboxgl: window.mapboxgl };
    try {
      class FakeMarker {
        constructor(opts) {
          this.el = opts.element;
        }
        setLngLat() { return this; }
        addTo() { return this; }
        on() { return this; }
        getElement() { return this.el; }
        remove() {}
        setDraggable() {}
      }
      window.mapboxgl = { Marker: FakeMarker };
      KPR.map = { getMap: () => ({ on() {} }) };
      const wp = KPR.waypoints;
      let notifications = 0;
      wp.init(() => notifications++);

      const pts = F.v1File.waypoints;
      wp.loadFrom(pts);
      assert.equal(wp.count(), 4);
      const loud = notifications;
      assert.ok(loud >= 5, "default load notifies for the clear and for each stop, got " + loud);

      notifications = 0;
      wp.loadFrom(pts, { quiet: true });
      assert.equal(wp.count(), 4);
      assert.equal(notifications, 1, "only clearAll notifies when quiet");

      // The flag must be reset afterwards: later edits notify again.
      notifications = 0;
      wp.addWaypoint(42.5, -83.5, { name: "X", detail: "" });
      assert.equal(notifications, 1);
      wp.clearAll();
    } finally {
      KPR.map = original.map;
      window.mapboxgl = original.mapboxgl;
    }
  });
})();
