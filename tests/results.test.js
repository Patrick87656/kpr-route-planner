/**
 * results.test.js — KPR.results: the CSV export, the Results view lifecycle
 * (overlay layers, badges, panel, exit) and opening a #res= link.
 *
 * No Mapbox and no network: the map is a recording fake, and the pieces
 * results.js talks to (scenes, waypoints, app mode, storage.applyRoute,
 * alert/confirm) are swapped for stubs and put back afterwards.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const RES = KPR.results;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const HOSTILE = [
    '"><img src=x onerror=window.__pwned=1>',
    '" onmouseover="window.__pwned=1',
    "<script>window.__pwned=1</script>",
    "constructor",
    "__proto__",
    "url(javascript:alert(1))",
  ];

  // ---- fixtures ---------------------------------------------------------

  function sceneRec(type, label, lat, lng) {
    return {
      type: "NVH",
      typeLabel: type,
      label,
      notes: "",
      startLat: lat,
      startLng: lng,
      endLat: lat + 0.01,
      endLng: lng - 0.01,
    };
  }

  /** Validated results, the shape KPR.codec.decodeResults returns. */
  function makeResults(overrides) {
    return Object.assign(
      {
        route: {
          name: "Loop A",
          waypoints: [
            { lat: 36.1, lng: -115.1, name: "Start", detail: "" },
            { lat: 36.2, lng: -115.2, name: "End", detail: "" },
          ],
          scenes: [
            sceneRec("NVH", "One", 36.12, -115.12),
            sceneRec("Braking", "Two", 36.14, -115.14),
            sceneRec("Steering", "Three", 36.16, -115.16),
          ],
        },
        vehicle: "Ariya #1",
        evaluator: "Pat",
        startedAt: new Date(2024, 2, 5, 7, 9).getTime(), // local 2024-03-05 07:09
        simulated: false,
        ratings: ["good", "bad", null],
      },
      overrides
    );
  }

  function setHash(hash) {
    history.replaceState(null, "", location.pathname + location.search + hash);
  }

  // ---- fakes ------------------------------------------------------------

  /** A map that records what results.js does to it. */
  function fakeMap() {
    const layers = new Map();
    const sources = new Map();
    const log = [];
    return {
      layers,
      sources,
      log,
      getSource(id) {
        if (!sources.has(id)) return undefined;
        return {
          setData(d) {
            sources.get(id).data = d;
            log.push(["setData", id]);
          },
        };
      },
      addSource(id, spec) {
        sources.set(id, { spec, data: spec.data });
        log.push(["addSource", id]);
      },
      getLayer: (id) => layers.get(id),
      addLayer(spec, before) {
        layers.set(spec.id, spec);
        log.push(["addLayer", spec.id, before]);
      },
      removeLayer(id) {
        layers.delete(id);
        log.push(["removeLayer", id]);
      },
      removeSource(id) {
        sources.delete(id);
        log.push(["removeSource", id]);
      },
      moveLayer(id, before) {
        log.push(["moveLayer", id, before]);
      },
      setPaintProperty(...a) {
        log.push(["setPaintProperty", ...a]);
      },
      setLayoutProperty(...a) {
        log.push(["setLayoutProperty", ...a]);
      },
      fitBounds(bounds, opts) {
        log.push(["fitBounds", bounds, opts]);
      },
      wipe() {
        layers.clear();
        sources.clear();
      },
    };
  }

  /** A placed scene as KPR.scenes would hold it. */
  function liveScene(id, srcIndex, segment) {
    const popupCalls = [];
    const popup = {
      setLngLat(ll) {
        popupCalls.push(ll);
        return popup;
      },
      addTo() {
        popupCalls.push("addTo");
        return popup;
      },
    };
    return {
      id,
      srcIndex,
      segment: segment || [
        { lat: 36.1 + id / 100, lng: -115.1 },
        { lat: 36.2 + id / 100, lng: -115.3 },
      ],
      popup,
      popupCalls,
      pinMarker: { getLngLat: () => [-115.2, 36.15] },
    };
  }

  /**
   * Run fn(ctx) with the map, scenes, waypoints, app mode, applyRoute, drive
   * and alert/confirm replaced by recording stubs; put everything back after
   * (leaving results mode first if the test left it on).
   */
  async function withEnv(opts, fn) {
    opts = opts || {};
    const map = fakeMap();
    const ctx = {
      map,
      scenes: opts.scenes || [],
      alerts: [],
      confirms: [],
      modes: [],
      locked: [],
      badges: [],
      applied: [],
      order: [],
      cleared: 0,
      styleReady: true,
      whenReady: true,
      stops: opts.stops || 0,
      driveActive: false,
      confirmAnswer: true,
      applyResult: opts.applyResult || { ok: true, scenesLoaded: 0, scenesSkipped: 0 },
    };
    const saved = {
      map: KPR.map,
      drive: KPR.drive,
      getAll: KPR.scenes.getAll,
      setBadge: KPR.scenes.setRatingBadge,
      setMode: KPR.app.setMode,
      setLocked: KPR.waypoints.setLocked,
      clearAll: KPR.waypoints.clearAll,
      count: KPR.waypoints.count,
      apply: KPR.storage.applyRoute,
      alert: window.alert,
      confirm: window.confirm,
      consoleError: console.error,
    };
    KPR.map = {
      getMap: () => map,
      isStyleReady: () => ctx.styleReady,
      whenStyleReady: async () => ctx.whenReady,
      getFitPadding: () => ({ top: 1, left: 2, right: 3, bottom: 4 }),
    };
    KPR.drive = { isActive: () => ctx.driveActive };
    KPR.scenes.getAll = () => ctx.scenes;
    KPR.scenes.setRatingBadge = (id, kind) => ctx.badges.push([id, kind]);
    KPR.app.setMode = (m) => ctx.modes.push(m);
    KPR.waypoints.setLocked = (l) => ctx.locked.push(l);
    KPR.waypoints.clearAll = () => {
      ctx.cleared++;
    };
    KPR.waypoints.count = () => ctx.stops;
    KPR.storage.applyRoute = async (route) => {
      ctx.order.push("apply");
      ctx.applied.push(route);
      return ctx.applyResult;
    };
    window.alert = (m) => ctx.alerts.push(String(m));
    window.confirm = (m) => {
      ctx.confirms.push(String(m));
      return ctx.confirmAnswer;
    };
    console.error = () => {};
    try {
      await fn(ctx);
    } finally {
      if (RES.isActive()) RES.exit({ keepRoute: true });
      KPR.map = saved.map;
      if (saved.map === undefined) delete KPR.map;
      KPR.drive = saved.drive;
      if (saved.drive === undefined) delete KPR.drive;
      KPR.scenes.getAll = saved.getAll;
      KPR.scenes.setRatingBadge = saved.setBadge;
      KPR.app.setMode = saved.setMode;
      KPR.waypoints.setLocked = saved.setLocked;
      KPR.waypoints.clearAll = saved.clearAll;
      KPR.waypoints.count = saved.count;
      KPR.storage.applyRoute = saved.apply;
      window.alert = saved.alert;
      window.confirm = saved.confirm;
      console.error = saved.consoleError;
      document.body.classList.remove("results-mode");
      $("results-view").classList.add("hidden");
      $("results-scenes").replaceChildren();
      setHash("");
    }
  }

  const layerAdds = (map) => map.log.filter((e) => e[0] === "addLayer");

  // ---- CSV --------------------------------------------------------------

  /** Minimal RFC 4180 reader: rows of {v: text, q: was it quoted}. */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let v = "";
    let q = false;
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            v += '"';
            i++;
          } else {
            inQ = false;
          }
        } else {
          v += c;
        }
      } else if (c === '"') {
        inQ = true;
        q = true;
      } else if (c === ",") {
        row.push({ v, q });
        v = "";
        q = false;
      } else if (c === "\r" && text[i + 1] === "\n") {
        row.push({ v, q });
        rows.push(row);
        row = [];
        v = "";
        q = false;
        i++;
      } else {
        v += c;
      }
    }
    if (v !== "" || row.length) {
      row.push({ v, q });
      rows.push(row);
    }
    return rows;
  }

  const HEADER =
    "Route,Vehicle,Evaluator,Drive date/time,Simulated,Scene #,Scene type,Scene label,Rating,Rated at,Latitude,Longitude";

  test("csv: BOM, CRLF everywhere, exact header, one row per scene", () => {
    const csv = RES.buildCsv(makeResults());
    assert.equal(csv.charCodeAt(0), 0xfeff, "starts with a BOM");
    assert.ok(csv.endsWith("\r\n"), "ends with CRLF");
    assert.ok(!/(^|[^\r])\n/.test(csv.slice(1)), "no bare LF");
    const lines = csv.slice(1).split("\r\n");
    assert.equal(lines[0], HEADER);
    assert.equal(lines.length, 5, "header + 3 rows + empty tail");
    assert.equal(lines[4], "");
    parseCsv(csv.slice(1)).forEach((row, i) => assert.equal(row.length, 12, "columns in row " + i));
  });

  test("csv: cell values, Good/Bad/Not rated, local date, Simulated Yes/No", () => {
    const rows = parseCsv(RES.buildCsv(makeResults()).slice(1));
    const r1 = rows[1].map((c) => c.v);
    assert.deepEqual(r1, [
      "Loop A",
      "Ariya #1",
      "Pat",
      "2024-03-05 07:09",
      "No",
      "1",
      "NVH",
      "One",
      "Good",
      "",
      "36.12",
      "-115.12",
    ]);
    assert.equal(rows[2][8].v, "Bad");
    assert.equal(rows[3][8].v, "Not rated");
    assert.equal(rows[3][5].v, "3", "Scene # is 1-based");
    const sim = parseCsv(RES.buildCsv(makeResults({ simulated: true })).slice(1));
    assert.equal(sim[1][4].v, "Yes");
  });

  test("csv: text cells are always quoted; numbers never are; negative longitudes are untouched", () => {
    const rows = parseCsv(RES.buildCsv(makeResults()).slice(1));
    [0, 1, 2, 3, 4, 6, 7, 8].forEach((c) => assert.equal(rows[1][c].q, true, "text column " + c));
    [5, 10, 11].forEach((c) => assert.equal(rows[1][c].q, false, "number column " + c));
    assert.equal(rows[1][11].v, "-115.12", "no quote prefix on a negative number");
    assert.equal(rows[1][9].v, "", "Rated at is empty");
  });

  test("csv: cells starting with = + - @ TAB or CR are neutralized with a quote prefix", () => {
    ["=", "+", "-", "@", "\t", "\r"].forEach((lead) => {
      const results = makeResults({ vehicle: lead + "veh", evaluator: lead + "who" });
      results.route.name = lead + "route";
      results.route.scenes[0].typeLabel = lead + "type";
      results.route.scenes[0].label = lead + "label";
      const row = parseCsv(RES.buildCsv(results).slice(1))[1].map((c) => c.v);
      const tag = JSON.stringify(lead);
      assert.equal(row[0], "'" + lead + "route", "route " + tag);
      assert.equal(row[1], "'" + lead + "veh", "vehicle " + tag);
      assert.equal(row[2], "'" + lead + "who", "evaluator " + tag);
      assert.equal(row[6], "'" + lead + "type", "type " + tag);
      assert.equal(row[7], "'" + lead + "label", "label " + tag);
    });
    const formula = parseCsv(RES.buildCsv(makeResults({ vehicle: "=HYPERLINK(\"http://x\",\"y\")" })).slice(1));
    assert.equal(formula[1][1].v, "'=HYPERLINK(\"http://x\",\"y\")");
    assert.equal(formula[1][1].q, true);
  });

  test("csv: a formula character later in the text, or spaces first, are left alone", () => {
    const results = makeResults({ vehicle: "a=b", evaluator: "x-y" });
    results.route.scenes[0].label = "1+1";
    const row = parseCsv(RES.buildCsv(results).slice(1))[1].map((c) => c.v);
    assert.equal(row[1], "a=b");
    assert.equal(row[2], "x-y");
    assert.equal(row[7], "1+1");
  });

  test("csv: quotes, commas and line breaks inside text survive a round trip", () => {
    const results = makeResults({ vehicle: 'The "big", red one' });
    results.route.scenes[0].label = "line one\nline two, with comma";
    const row = parseCsv(RES.buildCsv(results).slice(1))[1].map((c) => c.v);
    assert.equal(row[1], 'The "big", red one');
    assert.equal(row[7], "line one\nline two, with comma");
    assert.equal(row.length, 12);
  });

  test("csv: every scene in the link gets a row, including ones that could not be placed", () => {
    const results = makeResults();
    results.ratings = ["good", "good", "bad"];
    const rows = parseCsv(RES.buildCsv(results).slice(1));
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.slice(1).map((r) => r[8].v),
      ["Good", "Good", "Bad"]
    );
  });

  test("csv: a route with no scenes is just the header", () => {
    const results = makeResults({ ratings: [] });
    results.route.scenes = [];
    assert.equal(RES.buildCsv(results), "\uFEFF" + HEADER + "\r\n");
  });

  test("exportCsv: downloads text/csv with a BOM and a safe <name>-results.csv file name", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async () => {
      const realCreate = URL.createObjectURL;
      const realRevoke = URL.revokeObjectURL;
      const realClick = HTMLAnchorElement.prototype.click;
      const seen = { blobs: [], names: [], revoked: [] };
      URL.createObjectURL = (b) => {
        seen.blobs.push(b);
        return "blob:kpr-test";
      };
      URL.revokeObjectURL = (u) => seen.revoked.push(u);
      HTMLAnchorElement.prototype.click = function () {
        seen.names.push(this.download);
      };
      try {
        RES.exportCsv(); // not in results mode yet: nothing happens
        assert.equal(seen.blobs.length, 0);

        RES.enter(makeResults());
        RES.exportCsv();
        assert.equal(seen.blobs.length, 1);
        assert.equal(seen.blobs[0].type, "text/csv;charset=utf-8");
        assert.equal(seen.names[0], "Loop A-results.csv");
        assert.deepEqual(seen.revoked, ["blob:kpr-test"]);
        const bytes = new Uint8Array(await seen.blobs[0].arrayBuffer());
        assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf], "UTF-8 BOM");
        assert.equal(document.querySelectorAll("body > a[download]").length, 0, "temporary link removed");

        RES.exit();
        const hostile = makeResults();
        hostile.route.name = "..\\..\\evil<>:*?/name";
        RES.enter(hostile);
        RES.exportCsv();
        assert.ok(/^[A-Za-z0-9\-_ ]+-results\.csv$/.test(seen.names[1]), "safe file name: " + seen.names[1]);
      } finally {
        URL.createObjectURL = realCreate;
        URL.revokeObjectURL = realRevoke;
        HTMLAnchorElement.prototype.click = realClick;
      }
    });
  });

  // ---- overlay layers ---------------------------------------------------

  test("enter: one source, a casing layer and a line layer are added on top, with the fixed palette", async () => {
    const a = liveScene(1, 0);
    const b = liveScene(2, 1);
    const c = liveScene(3, 2);
    await withEnv({ scenes: [a, b, c] }, async (ctx) => {
      RES.enter(makeResults());
      const ids = RES.LAYER_IDS;
      assert.ok(ctx.map.sources.has(ids.source));
      const adds = layerAdds(ctx.map);
      assert.deepEqual(adds.map((e) => e[1]), [ids.casing, ids.line], "casing first, line above it");
      adds.forEach((e) => assert.equal(e[2], undefined, "no beforeId: drawn above everything"));

      const casing = ctx.map.layers.get(ids.casing);
      const line = ctx.map.layers.get(ids.line);
      assert.equal(casing.source, ids.source);
      assert.equal(line.source, ids.source);
      assert.equal(casing.paint["line-color"], "#ffffff");
      assert.equal(casing.paint["line-width"], 13);
      assert.equal(line.paint["line-width"], 10);
      assert.deepEqual(line.paint["line-color"], ["match", ["get", "r"], "g", "#22c55e", "b", "#ef4444", "#9ca3af"]);
      assert.equal(line.paint["line-emissive-strength"], 1);

      const data = ctx.map.sources.get(ids.source).data;
      assert.equal(data.type, "FeatureCollection");
      assert.deepEqual(data.features.map((f) => f.properties.r), ["g", "b", "n"]);
      assert.equal(data.features[0].geometry.type, "LineString");
      assert.deepEqual(data.features[0].geometry.coordinates[0], [a.segment[0].lng, a.segment[0].lat]);
    });
  });

  test("enter: scene layers are never touched (overlay is purely additive)", async () => {
    await withEnv({ scenes: [liveScene(1, 0), liveScene(2, 1)] }, async (ctx) => {
      RES.enter(makeResults());
      RES.exit({ keepRoute: true });
      const kinds = new Set(ctx.map.log.map((e) => e[0]));
      assert.ok(!kinds.has("setPaintProperty"), "no paint changes");
      assert.ok(!kinds.has("setLayoutProperty"), "no layout changes");
      const touched = ctx.map.log.filter((e) => e[0] === "removeLayer" || e[0] === "addLayer").map((e) => e[1]);
      touched.forEach((id) => assert.ok(/^kpr-res-/.test(id), "only overlay layers: " + id));
    });
  });

  test("ratings map by srcIndex, not by position, when a middle scene could not be placed", async () => {
    // Scene 1 (the middle one) was skipped: live scenes carry srcIndex 0 and 2.
    const first = liveScene(10, 0);
    const third = liveScene(11, 2);
    await withEnv({ scenes: [first, third] }, async (ctx) => {
      RES.enter(makeResults({ ratings: ["good", "good", "bad"] }));
      const data = ctx.map.sources.get(RES.LAYER_IDS.source).data;
      // By position the second live scene would read "good" (index 1).
      assert.deepEqual(data.features.map((f) => f.properties.r), ["g", "b"]);
      assert.deepEqual(ctx.badges, [
        [10, "good"],
        [11, "bad"],
      ]);

      const rows = $("results-scenes").querySelectorAll("li");
      assert.equal(rows.length, 3, "all three payload scenes are listed");
      assert.equal(rows[1].querySelector(".rs-unplaced").textContent, "Not shown on map");
      assert.equal(rows[0].querySelector(".rs-unplaced"), null);
      assert.equal(rows[2].querySelector(".rs-unplaced"), null);
      assert.equal(rows[1].querySelector(".rs-rating").textContent, "Good", "the skipped scene keeps its own rating");
      assert.equal(rows[2].querySelector(".rs-rating").textContent, "Bad");
      assert.ok(/1 scene couldn't be placed/.test($("results-note").textContent));
      assert.ok(!$("results-note").classList.contains("hidden"));
    });
  });

  test("unrated and unknown srcIndex scenes draw grey and get the 'none' badge", async () => {
    const stray = liveScene(5, undefined); // no srcIndex at all
    const far = liveScene(6, 99); // outside the ratings
    const unrated = liveScene(7, 2); // ratings[2] is null
    await withEnv({ scenes: [stray, far, unrated] }, async (ctx) => {
      RES.enter(makeResults());
      const data = ctx.map.sources.get(RES.LAYER_IDS.source).data;
      assert.deepEqual(data.features.map((f) => f.properties.r), ["n", "n", "n"]);
      assert.deepEqual(ctx.badges, [
        [5, "none"],
        [6, "none"],
        [7, "none"],
      ]);
    });
  });

  test("segments with fewer than 2 points are not drawn", async () => {
    await withEnv({ scenes: [liveScene(1, 0, [{ lat: 1, lng: 1 }]), liveScene(2, 1)] }, async (ctx) => {
      RES.enter(makeResults());
      assert.equal(ctx.map.sources.get(RES.LAYER_IDS.source).data.features.length, 1);
    });
  });

  test("ensureLayers is idempotent: a second call refreshes data, adds nothing", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async (ctx) => {
      RES.enter(makeResults());
      assert.equal(layerAdds(ctx.map).length, 2);
      RES.ensureLayers();
      RES.ensureLayers();
      assert.equal(layerAdds(ctx.map).length, 2, "no duplicate layers");
      assert.equal(ctx.map.log.filter((e) => e[0] === "addSource").length, 1, "no duplicate source");
      assert.ok(ctx.map.log.some((e) => e[0] === "setData"), "existing source is updated");
    });
  });

  test("ensureLayers waits while a style is loading, then the reload callback adds the overlay", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async (ctx) => {
      ctx.styleReady = false;
      RES.enter(makeResults());
      assert.equal(ctx.map.log.length, 0, "nothing is added while the style loads");
      ctx.styleReady = true;
      RES.handleStyleReload();
      assert.equal(layerAdds(ctx.map).length, 2);
    });
  });

  test("style reload (Satellite swap) rebuilds the wiped overlay and raises it above the scene layers", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async (ctx) => {
      RES.enter(makeResults());
      ctx.map.wipe(); // setStyle() throws every custom layer away
      ctx.map.log.length = 0;
      RES.handleStyleReload();
      assert.ok(ctx.map.layers.has(RES.LAYER_IDS.casing) && ctx.map.layers.has(RES.LAYER_IDS.line));
      assert.ok(ctx.map.sources.has(RES.LAYER_IDS.source));

      // scenes.js re-adds its layers after this callback has run, so the
      // overlay is moved to the top once every callback is done.
      assert.ok(!ctx.map.log.some((e) => e[0] === "moveLayer"), "not raised synchronously");
      await Promise.resolve();
      await Promise.resolve();
      const moves = ctx.map.log.filter((e) => e[0] === "moveLayer");
      assert.deepEqual(moves.map((e) => e[1]), [RES.LAYER_IDS.casing, RES.LAYER_IDS.line]);
      moves.forEach((e) => assert.equal(e[2], undefined, "moved to the very top"));
    });
  });

  test("style reload does nothing when results mode is off", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async (ctx) => {
      RES.handleStyleReload();
      await Promise.resolve();
      assert.equal(ctx.map.log.length, 0);
      RES.enter(makeResults());
      RES.exit();
      ctx.map.log.length = 0;
      RES.handleStyleReload();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(ctx.map.log.length, 0, "an exited view is not resurrected by a later style switch");
    });
  });

  test("the style-reload callback is registered exactly once, when the file loads", async () => {
    const regs = [];
    const savedMap = KPR.map;
    const savedResults = KPR.results;
    KPR.map = { onStyleReload: (cb) => regs.push(cb) };
    const tag = document.createElement("script");
    try {
      await new Promise((resolve, reject) => {
        tag.onload = resolve;
        tag.onerror = () => reject(new Error("results.js did not load"));
        tag.src = "../js/results.js";
        document.head.appendChild(tag);
      });
      assert.equal(regs.length, 1, "one registration at load");
      assert.equal(typeof regs[0], "function");
      assert.equal(regs[0], KPR.results.handleStyleReload, "it is the module's reload handler");
    } finally {
      KPR.results = savedResults;
      if (savedMap === undefined) delete KPR.map;
      else KPR.map = savedMap;
      tag.remove();
    }
    assert.equal(KPR.results, savedResults, "the real module is back");
  });

  // ---- enter / exit -----------------------------------------------------

  test("enter: results mode on, planner locked, badges set, panel shown", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async (ctx) => {
      RES.enter(makeResults());
      assert.equal(RES.isActive(), true);
      assert.ok(document.body.classList.contains("results-mode"));
      assert.deepEqual(ctx.modes, ["results"]);
      assert.deepEqual(ctx.locked, [true]);
      assert.deepEqual(ctx.badges, [[1, "good"]]);
      assert.ok(!$("results-view").classList.contains("hidden"));
    });
  });

  test("enter twice is ignored; exit when not active does nothing", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async (ctx) => {
      RES.exit();
      assert.deepEqual(ctx.modes, []);
      RES.enter(makeResults());
      RES.enter(makeResults({ vehicle: "Other" }));
      assert.deepEqual(ctx.modes, ["results"], "second enter did nothing");
      assert.equal($("results-vehicle").textContent, "Ariya #1");
      RES.exit();
      RES.exit();
      assert.deepEqual(ctx.modes, ["results", "waypoint"], "second exit did nothing");
      assert.equal(ctx.cleared, 0);
    });
  });

  test("exit removes layers, source, badges and the body class, restores the mode and unlocks stops", async () => {
    await withEnv({ scenes: [liveScene(1, 0), liveScene(2, 1)] }, async (ctx) => {
      RES.enter(makeResults());
      ctx.badges.length = 0;
      RES.exit();
      assert.equal(RES.isActive(), false);
      assert.equal(ctx.map.layers.size, 0, "overlay layers removed");
      assert.equal(ctx.map.sources.size, 0, "overlay source removed");
      assert.deepEqual(ctx.badges, [
        [1, null],
        [2, null],
      ], "every pin badge removed");
      assert.ok(!document.body.classList.contains("results-mode"));
      assert.ok($("results-view").classList.contains("hidden"));
      assert.equal($("results-scenes").children.length, 0);
      assert.deepEqual(ctx.modes, ["results", "waypoint"]);
      assert.deepEqual(ctx.locked, [true, false]);
    });
  });

  test("Open as editable route and Close results differ only in clearing the stops", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async (ctx) => {
      RES.init();
      RES.enter(makeResults());
      $("results-edit").click();
      assert.equal(RES.isActive(), false);
      assert.equal(ctx.cleared, 0, "Open as editable route keeps the stops");
      assert.deepEqual(ctx.modes, ["results", "waypoint"]);

      RES.enter(makeResults());
      $("results-close").click();
      assert.equal(RES.isActive(), false);
      assert.equal(ctx.cleared, 1, "Close results clears the stops");
      assert.deepEqual(ctx.modes, ["results", "waypoint", "results", "waypoint"]);
      assert.deepEqual(ctx.locked, [true, false, true, false]);

      RES.enter(makeResults());
      RES.exit();
      RES.enter(makeResults());
      RES.exit({ keepRoute: true });
      assert.equal(ctx.cleared, 1, "exit() defaults to keeping the route");
    });
  });

  test("exit still finishes if the map refuses the layer removal mid style switch", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async (ctx) => {
      RES.enter(makeResults());
      ctx.map.removeLayer = () => {
        throw new Error("Style is not done loading");
      };
      RES.exit({ keepRoute: false });
      assert.equal(RES.isActive(), false);
      assert.equal(ctx.cleared, 1);
      assert.ok(!document.body.classList.contains("results-mode"));
    });
  });

  // ---- panel ------------------------------------------------------------

  test("panel: route, vehicle, evaluator, date, counts and the scene list", async () => {
    await withEnv({ scenes: [liveScene(1, 0), liveScene(2, 1), liveScene(3, 2)] }, async () => {
      RES.enter(makeResults());
      assert.equal($("results-route").textContent, "Loop A");
      assert.equal($("results-vehicle").textContent, "Ariya #1");
      assert.equal($("results-evaluator").textContent, "Pat");
      assert.equal($("results-when").textContent, new Date(makeResults().startedAt).toLocaleString());
      assert.equal($("results-count-good").textContent, "1 good");
      assert.equal($("results-count-bad").textContent, "1 bad");
      assert.equal($("results-count-none").textContent, "1 not rated");
      const rows = $("results-scenes").querySelectorAll("li > button.results-scene");
      assert.equal(rows.length, 3);
      assert.deepEqual(
        Array.from(rows).map((r) => r.querySelector(".rs-rating").textContent),
        ["Good", "Bad", "Not rated"]
      );
      assert.equal(rows[0].querySelector(".rs-type").textContent, "NVH");
      assert.equal(rows[0].querySelector(".rs-label").textContent, "One");
      assert.equal($("results-note").classList.contains("hidden"), true, "all placed: no note");
    });
  });

  test("panel: blank vehicle and evaluator read 'Not recorded'; a route with no scenes says so", async () => {
    await withEnv({}, async () => {
      const r = makeResults({ vehicle: "", evaluator: "", ratings: [] });
      r.route.scenes = [];
      RES.enter(r);
      assert.equal($("results-vehicle").textContent, "Not recorded");
      assert.equal($("results-evaluator").textContent, "Not recorded");
      assert.equal($("results-note").textContent, "This route has no scenes.");
      assert.equal($("results-count-none").textContent, "0 not rated");
    });
  });

  test("panel: the TEST banner shows only for a simulated drive", async () => {
    await withEnv({}, async () => {
      RES.enter(makeResults({ simulated: true }));
      assert.equal($("results-test-banner").classList.contains("hidden"), false);
      assert.ok(/TEST/.test($("results-test-banner").textContent));
      RES.exit();
      RES.enter(makeResults({ simulated: false }));
      assert.equal($("results-test-banner").classList.contains("hidden"), true);
    });
  });

  test("panel: hostile text in every field stays literal text (no elements, attributes or scripts)", async () => {
    const ALLOWED = new Set(["LI", "BUTTON", "SPAN", "SVG", "PATH", "RECT"]);
    await withEnv({ scenes: [liveScene(1, 0)] }, async () => {
      HOSTILE.forEach((s) => {
        const r = makeResults({ vehicle: s, evaluator: s });
        r.route.name = s;
        r.route.scenes[0].typeLabel = s;
        r.route.scenes[0].label = s;
        RES.enter(r);

        assert.equal($("results-route").textContent, s);
        assert.equal($("results-vehicle").textContent, s);
        assert.equal($("results-evaluator").textContent, s);
        const row = $("results-scenes").querySelector("button.results-scene");
        assert.equal(row.querySelector(".rs-type").textContent, s);
        assert.equal(row.querySelector(".rs-label").textContent, s);

        const view = $("results-view");
        assert.equal(view.querySelectorAll("img, script, iframe, object, embed, style, link").length, 0);
        [$("results-scenes"), $("results-route"), $("results-vehicle"), $("results-evaluator")].forEach((root) => {
          [root, ...root.querySelectorAll("*")].forEach((el) => {
            assert.ok(ALLOWED.has(el.tagName.toUpperCase()) || el === root, "unexpected <" + el.tagName + ">");
            assert.equal(el.getAttribute("style"), null, "no inline style");
            Array.from(el.attributes).forEach((a) => assert.ok(!/^on/i.test(a.name), "attribute " + a.name));
          });
        });
        assert.equal(window.__pwned, undefined, "injected script ran");
        RES.exit();
      });
    });
  });

  test("panel: each scene row is a keyboard-reachable button with a text rating", async () => {
    await withEnv({ scenes: [liveScene(1, 0)] }, async () => {
      RES.enter(makeResults());
      $("results-scenes").querySelectorAll("li").forEach((li) => {
        assert.equal(li.children.length, 1);
        assert.equal(li.firstElementChild.tagName, "BUTTON");
        assert.equal(li.firstElementChild.type, "button");
        assert.ok(/Good|Bad|Not rated/.test(li.textContent));
        assert.equal(li.querySelector(".rating-badge").getAttribute("aria-hidden"), "true");
      });
    });
  });

  test("clicking a row zooms to the live segment, or to the link's coordinates if it was not placed", async () => {
    const seg = [
      { lat: 36.1, lng: -115.4 },
      { lat: 36.3, lng: -115.1 },
      { lat: 36.2, lng: -115.2 },
    ];
    const live = liveScene(1, 0, seg);
    await withEnv({ scenes: [live] }, async (ctx) => {
      RES.enter(makeResults());
      const rows = $("results-scenes").querySelectorAll("button.results-scene");

      rows[0].click();
      let fit = ctx.map.log.filter((e) => e[0] === "fitBounds").pop();
      assert.deepEqual(fit[1], [
        [-115.4, 36.1],
        [-115.1, 36.3],
      ]);
      assert.deepEqual(fit[2].padding, { top: 1, left: 2, right: 3, bottom: 4 });
      assert.equal(fit[2].maxZoom, 17);
      assert.ok(live.popupCalls.includes("addTo"), "the scene's popup opens");

      rows[1].click(); // scene 1 is not placed: use the coordinates from the link
      fit = ctx.map.log.filter((e) => e[0] === "fitBounds").pop();
      const sc = makeResults().route.scenes[1];
      assert.deepEqual(fit[1], [
        [Math.min(sc.startLng, sc.endLng), Math.min(sc.startLat, sc.endLat)],
        [Math.max(sc.startLng, sc.endLng), Math.max(sc.startLat, sc.endLat)],
      ]);
    });
  });

  // ---- opening a #res= link ----------------------------------------------

  /** A real results link hash for a two-scene drive (good, bad). */
  async function realHash(extra) {
    const route = {
      name: "Linked loop",
      waypoints: [
        { lat: 36.1, lng: -115.1, name: "Start", detail: "" },
        { lat: 36.2, lng: -115.2, name: "End", detail: "" },
      ],
      scenes: [
        { type: "NVH", typeLabel: "NVH", label: "One", notes: "", startLat: 36.12, startLng: -115.12, endLat: 36.14, endLng: -115.14 },
        { type: "Braking", typeLabel: "Braking", label: "Two", notes: "", startLat: 36.15, startLng: -115.15, endLat: 36.18, endLng: -115.18 },
      ],
    };
    const session = Object.assign(
      {
        routePayload: KPR.codec.buildPayload(route),
        vehicle: "Leaf #2",
        evaluator: "Sam",
        startedAt: 1700000000000,
        simulated: false,
        ratings: [
          { sceneIndex: 0, rating: "good" },
          { sceneIndex: 1, rating: "bad" },
        ],
      },
      extra
    );
    return KPR.codec.RES_PREFIX + (await KPR.codec.encodeResults(session));
  }

  test("loadFromHash: a valid link loads the route once, enters results mode and clears the hash", async () => {
    const hash = await realHash();
    await withEnv({ scenes: [liveScene(1, 0), liveScene(2, 1)] }, async (ctx) => {
      setHash(hash);
      await RES.loadFromHash();
      assert.deepEqual(ctx.alerts, []);
      assert.equal(ctx.applied.length, 1, "applyRoute ran exactly once");
      assert.equal(ctx.applied[0].name, "Linked loop");
      assert.equal(ctx.applied[0].scenes.length, 2);
      assert.equal(RES.isActive(), true);
      assert.equal($("results-vehicle").textContent, "Leaf #2");
      assert.equal($("results-evaluator").textContent, "Sam");
      assert.equal($("results-count-good").textContent, "1 good");
      assert.equal($("results-count-bad").textContent, "1 bad");
      assert.equal(location.hash, "", "hash removed");
      assert.ok(ctx.map.layers.has(RES.LAYER_IDS.line));
    });
  });

  test("loadFromHash: the results viewer works for anyone (no gating)", async () => {
    const hash = await realHash();
    await withEnv({ scenes: [liveScene(1, 0)] }, async () => {
      setHash(hash);
      await RES.loadFromHash();
      assert.equal(RES.isActive(), true);
    });
  });

  test("loadFromHash: a simulated drive shows the TEST banner", async () => {
    const hash = await realHash({ simulated: true });
    await withEnv({}, async () => {
      setHash(hash);
      await RES.loadFromHash();
      assert.equal($("results-test-banner").classList.contains("hidden"), false);
    });
  });

  test("loadFromHash: junk after #res= shows the fixed message, changes nothing, clears the hash", async () => {
    await withEnv({}, async (ctx) => {
      for (const bad of ["#res=", "#res=%%%", "#res=dAAAA", "#res=pAAAA", "#res=" + "x".repeat(50)]) {
        ctx.alerts.length = 0;
        setHash(bad);
        await RES.loadFromHash();
        assert.equal(ctx.alerts.length, 1, "one alert for " + bad);
        assert.equal(
          ctx.alerts[0],
          "That link doesn't look like KPR results. Ask the sender to share them again."
        );
        assert.ok(!ctx.alerts[0].includes(bad.slice(5) || "@@"), "never echoes the link");
        assert.equal(location.hash, "");
      }
      assert.equal(ctx.applied.length, 0);
      assert.equal(RES.isActive(), false);
      assert.deepEqual(ctx.modes, []);
    });
  });

  test("loadFromHash: a #r= route link in the results slot is rejected by the results decoder", async () => {
    const route = { name: "R", waypoints: [{ lat: 1, lng: 2, name: "", detail: "" }], scenes: [] };
    const asRoute = await KPR.codec.encode(route);
    await withEnv({}, async (ctx) => {
      setHash(KPR.codec.RES_PREFIX + asRoute); // valid route payload, but not a results payload
      await RES.loadFromHash();
      assert.equal(ctx.alerts.length, 1);
      assert.equal(ctx.applied.length, 0);
      assert.equal(RES.isActive(), false);
    });
  });

  test("loadFromHash: an oversized hash is refused before decoding", async () => {
    await withEnv({}, async (ctx) => {
      setHash("#res=d" + "A".repeat(KPR.codec.LIMITS.MAX_HASH_CHARS));
      await RES.loadFromHash();
      assert.equal(ctx.alerts.length, 1);
      assert.equal(location.hash, "");
      assert.equal(ctx.applied.length, 0);
    });
  });

  test("loadFromHash: refuses while a drive is running, with a fixed message", async () => {
    const hash = await realHash();
    await withEnv({}, async (ctx) => {
      ctx.driveActive = true;
      setHash(hash);
      await RES.loadFromHash();
      assert.deepEqual(ctx.alerts, ["End the drive first, then open the results link again."]);
      assert.equal(ctx.applied.length, 0);
      assert.equal(RES.isActive(), false);
      assert.equal(location.hash, "");
    });
  });

  test("loadFromHash: asks before replacing existing stops, and Cancel leaves everything alone", async () => {
    const hash = await realHash();
    await withEnv({ stops: 3 }, async (ctx) => {
      ctx.confirmAnswer = false;
      setHash(hash);
      await RES.loadFromHash();
      assert.equal(ctx.confirms.length, 1);
      assert.equal(ctx.applied.length, 0);
      assert.equal(RES.isActive(), false);
      assert.equal(location.hash, "", "hash cleared even when cancelled");

      ctx.confirmAnswer = true;
      setHash(hash);
      await RES.loadFromHash();
      assert.equal(ctx.applied.length, 1);
      assert.equal(RES.isActive(), true);
    });
  });

  test("loadFromHash: no stops means no confirm prompt", async () => {
    const hash = await realHash();
    await withEnv({ stops: 0 }, async (ctx) => {
      setHash(hash);
      await RES.loadFromHash();
      assert.equal(ctx.confirms.length, 0);
    });
  });

  test("loadFromHash: a map that never finishes loading gets a message, not a half-opened view", async () => {
    const hash = await realHash();
    await withEnv({}, async (ctx) => {
      ctx.whenReady = false;
      setHash(hash);
      await RES.loadFromHash();
      assert.equal(ctx.alerts.length, 1);
      assert.equal(ctx.applied.length, 0);
      assert.equal(RES.isActive(), false);
    });
  });

  test("loadFromHash: a route that cannot be calculated does not enter results mode", async () => {
    const hash = await realHash();
    await withEnv({ applyResult: { ok: false, reason: "route" } }, async (ctx) => {
      setHash(hash);
      await RES.loadFromHash();
      assert.equal(ctx.applied.length, 1);
      assert.equal(ctx.alerts.length, 1);
      assert.equal(RES.isActive(), false);
      assert.ok(!document.body.classList.contains("results-mode"));
      assert.equal(ctx.map.layers.size, 0);
      assert.equal(location.hash, "");
    });
  });

  test("loadFromHash: an error while loading is reported with a fixed message and leaves the planner usable", async () => {
    const hash = await realHash();
    await withEnv({}, async (ctx) => {
      KPR.storage.applyRoute = async () => {
        throw new Error("boom <b>secret</b>");
      };
      setHash(hash);
      await RES.loadFromHash();
      assert.equal(ctx.alerts.length, 1);
      assert.ok(!ctx.alerts[0].includes("secret"), "the error text is not shown");
      assert.equal(RES.isActive(), false);
      assert.equal(location.hash, "");
      // and a second link works afterwards (the loading flag was released)
      KPR.storage.applyRoute = async () => ({ ok: true, scenesLoaded: 0, scenesSkipped: 0 });
      setHash(hash);
      await RES.loadFromHash();
      assert.equal(RES.isActive(), true);
    });
  });

  test("loadFromHash: opening a second results link while one is open replaces it cleanly", async () => {
    const first = await realHash();
    const second = await realHash({ vehicle: "Second car" });
    await withEnv({ scenes: [liveScene(1, 0)], stops: 2 }, async (ctx) => {
      setHash(first);
      await RES.loadFromHash();
      assert.equal($("results-vehicle").textContent, "Leaf #2");

      setHash(second);
      await RES.loadFromHash();
      assert.equal(RES.isActive(), true);
      assert.equal($("results-vehicle").textContent, "Second car");
      assert.equal(ctx.cleared, 0, "the old view is left without clearing the stops");
      assert.deepEqual(ctx.modes, ["results", "waypoint", "results"]);
      assert.equal(layerAdds(ctx.map).filter((e) => e[1] === RES.LAYER_IDS.line).length, 2);
    });
  });

  test("loadFromHash: ignores other hashes, and #r= links are left to share.js", async () => {
    await withEnv({}, async (ctx) => {
      for (const h of ["", "#top", "#r=abc", "#resx=abc", "#RES=abc"]) {
        setHash(h);
        await RES.loadFromHash();
        assert.equal(location.hash, h, "left alone: " + h);
      }
      assert.deepEqual(ctx.alerts, []);
      assert.equal(ctx.applied.length, 0);
    });
  });

  test("share.loadFromHash ignores a #res= link (results.js owns it)", async () => {
    await withEnv({}, async (ctx) => {
      setHash("#res=dAAAA");
      await KPR.share.loadFromHash();
      assert.equal(location.hash, "#res=dAAAA", "untouched");
      assert.deepEqual(ctx.alerts, []);
      assert.equal(ctx.applied.length, 0);
    });
  });

  test("opening a #r= route link leaves results mode first, then applies the route", async () => {
    const routeHash = KPR.codec.buildLink(
      await KPR.codec.encode({
        name: "Shared",
        waypoints: [
          { lat: 36.1, lng: -115.1, name: "A", detail: "" },
          { lat: 36.2, lng: -115.2, name: "B", detail: "" },
        ],
        scenes: [],
      })
    );
    await withEnv({ scenes: [liveScene(1, 0)] }, async (ctx) => {
      RES.enter(makeResults());
      const realExit = RES.exit;
      RES.exit = (o) => {
        ctx.order.push("exit");
        return realExit(o);
      };
      try {
        setHash(routeHash.slice(routeHash.indexOf("#")));
        await KPR.share.loadFromHash();
      } finally {
        RES.exit = realExit;
      }
      assert.deepEqual(ctx.order, ["exit", "apply"]);
      assert.equal(RES.isActive(), false);
      assert.equal(ctx.cleared, 0, "the route is replaced by applyRoute, not cleared by exit");
      assert.ok(!document.body.classList.contains("results-mode"));
    });
  });

  // ---- planner guards -----------------------------------------------------

  test("right-clicking a stop removes it normally but does nothing in results mode", () => {
    const savedMapboxgl = window.mapboxgl;
    const savedMap = KPR.map;
    const savedGetMode = KPR.app.getMode;
    let el = null;
    window.mapboxgl = {
      Marker: function (opts) {
        el = opts.element;
        this.setLngLat = () => this;
        this.addTo = () => this;
        this.on = () => {};
        this.remove = () => {};
        this.getElement = () => el;
        this.setDraggable = () => {};
      },
    };
    KPR.map = { getMap: () => ({}) };
    try {
      KPR.waypoints.clearAll();
      KPR.waypoints.addWaypoint(36.1, -115.1, { name: "A", detail: "" });
      assert.equal(KPR.waypoints.count(), 1);

      KPR.app.getMode = () => "results";
      const blocked = new MouseEvent("contextmenu", { cancelable: true });
      el.dispatchEvent(blocked);
      assert.equal(KPR.waypoints.count(), 1, "stop kept in results mode");
      assert.equal(blocked.defaultPrevented, true, "browser menu still suppressed");

      KPR.app.getMode = () => "waypoint";
      el.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }));
      assert.equal(KPR.waypoints.count(), 0, "stop removed in the normal planner");
    } finally {
      KPR.app.getMode = savedGetMode;
      KPR.waypoints.clearAll();
      window.mapboxgl = savedMapboxgl;
      if (savedMap === undefined) delete KPR.map;
      else KPR.map = savedMap;
    }
  });
})();
