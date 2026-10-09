/**
 * evaluation.test.js — js/evaluation.js: the Evaluation setup section (the
 * vehicle list that travels with a route) and the vehicle picker dialog that
 * Start drive shows. Runs against the skeleton in tests/run.html with the map
 * and loaders stubbed and localStorage replaced by a fake (KPR.ratings.useStorage).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const E = KPR.evaluation;
  const St = KPR.storage;
  const F = window.KPR_FIXTURES;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(cond, label) {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await sleep(10);
    }
    throw new Error("timed out waiting for " + label);
  }

  /** An in-memory stand-in for localStorage. */
  function fakeStorage(initial) {
    const data = new Map(Object.entries(initial || {}));
    return {
      data,
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => void data.set(k, String(v)),
      removeItem: (k) => void data.delete(k),
    };
  }

  /** Run fn with a fake storage behind KPR.ratings and the box emptied before
   * and after. */
  async function withEval(initialStore, fn) {
    const store = fakeStorage(initialStore);
    KPR.ratings.useStorage(store);
    $("eval-vehicles").value = "";
    try {
      await fn(store);
    } finally {
      KPR.ratings.useStorage(null);
      $("eval-vehicles").value = "";
      $("eval-vehicles-hint").textContent = "";
    }
  }

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const lines = (n) => Array.from({ length: n }, (_, i) => "Vehicle " + (i + 1));

  // The section wires itself once, like the app does.
  E.init();

  // ---- planner section ---------------------------------------------------

  test("evaluation: init() shows the setup section", () => {
    $("eval-setup").classList.add("hidden");
    try {
      E.init();
      assert.ok(!$("eval-setup").classList.contains("hidden"), "shown after init");
    } finally {
      $("eval-setup").classList.add("hidden");
    }
  });

  test("evaluation: getVehicles / setVehicles round trip", async () => {
    await withEval({}, () => {
      assert.deepEqual(E.getVehicles(), []);
      E.setVehicles(["Ariya #1", "Leaf #2"]);
      assert.equal($("eval-vehicles").value, "Ariya #1\nLeaf #2");
      assert.deepEqual(E.getVehicles(), ["Ariya #1", "Leaf #2"]);
      assert.equal($("eval-vehicles-hint").textContent, "2 vehicles.");
      E.setVehicles([]);
      assert.equal($("eval-vehicles").value, "");
      assert.deepEqual(E.getVehicles(), []);
    });
  });

  test("evaluation: getVehicles cleans what was typed, without touching the box", async () => {
    await withEval({}, () => {
      $("eval-vehicles").value = "  Ariya #1  \n\nariya #1\r\nLeaf\u0007 #2\n";
      assert.deepEqual(E.getVehicles(), ["Ariya #1", "Leaf #2"]);
      assert.ok($("eval-vehicles").value.includes("  Ariya #1  "), "the box itself is left alone until 'change'");
    });
  });

  test("evaluation: 'change' rewrites the box with the cleaned list and a count", async () => {
    await withEval({}, () => {
      $("eval-vehicles").value = "  A  \n\nb\na\n";
      fire($("eval-vehicles"), "change");
      assert.equal($("eval-vehicles").value, "A\nb");
      assert.equal($("eval-vehicles-hint").textContent, "2 vehicles.");
      $("eval-vehicles").value = "Only one";
      fire($("eval-vehicles"), "change");
      assert.equal($("eval-vehicles-hint").textContent, "1 vehicle.");
      $("eval-vehicles").value = "   \n  ";
      fire($("eval-vehicles"), "change");
      assert.equal($("eval-vehicles").value, "");
      assert.ok($("eval-vehicles-hint").textContent.includes("One vehicle per line"));
    });
  });

  test("evaluation: 31 lines are cut to 30 and the hint says so; exactly 30 says nothing", async () => {
    await withEval({}, () => {
      $("eval-vehicles").value = lines(31).join("\n");
      fire($("eval-vehicles"), "change");
      assert.equal($("eval-vehicles").value.split("\n").length, 30);
      assert.ok($("eval-vehicles-hint").textContent.includes("Only the first 30 were kept"), $("eval-vehicles-hint").textContent);
      $("eval-vehicles").value = lines(30).join("\n");
      fire($("eval-vehicles"), "change");
      assert.equal($("eval-vehicles-hint").textContent, "30 vehicles.");
      // Repeats and blanks beyond 30 are not "cut" names.
      $("eval-vehicles").value = lines(30).join("\n") + "\n\nvehicle 1\n";
      fire($("eval-vehicles"), "change");
      assert.equal($("eval-vehicles-hint").textContent, "30 vehicles.");
    });
  });

  test("evaluation: 'Use my last list' fills the box from the remembered list", async () => {
    await withEval({ kprVehicles: JSON.stringify(["Ariya #1", "Leaf #2"]) }, (store) => {
      $("eval-use-last").click();
      assert.deepEqual(E.getVehicles(), ["Ariya #1", "Leaf #2"]);
      assert.equal($("eval-vehicles").value, "Ariya #1\nLeaf #2");
      assert.equal(store.data.get("kprVehicles"), JSON.stringify(["Ariya #1", "Leaf #2"]), "remembered list unchanged");
    });
  });

  test("evaluation: 'Use my last list' with nothing remembered leaves the box alone and says so", async () => {
    await withEval({}, () => {
      $("eval-vehicles").value = "Keep me";
      $("eval-use-last").click();
      assert.equal($("eval-vehicles").value, "Keep me");
      assert.ok($("eval-vehicles-hint").textContent.includes("No earlier list"));
    });
    await withEval({ kprVehicles: "{not json" }, () => {
      $("eval-vehicles").value = "Keep me";
      $("eval-use-last").click();
      assert.equal($("eval-vehicles").value, "Keep me");
    });
  });

  test("evaluation: typing remembers a non-empty list and never stores an empty one", async () => {
    await withEval({}, (store) => {
      $("eval-vehicles").value = "Ariya #1\nLeaf #2";
      fire($("eval-vehicles"), "input");
      assert.equal(store.data.get("kprVehicles"), JSON.stringify(["Ariya #1", "Leaf #2"]));
      $("eval-vehicles").value = "";
      fire($("eval-vehicles"), "input");
      assert.equal(store.data.get("kprVehicles"), JSON.stringify(["Ariya #1", "Leaf #2"]), "empty list not stored");
      $("eval-vehicles").value = "  \n ";
      fire($("eval-vehicles"), "input");
      assert.equal(store.data.get("kprVehicles"), JSON.stringify(["Ariya #1", "Leaf #2"]));
    });
  });

  // ---- loading a route puts its list in the box ---------------------------

  /** Stub the modules applyRoute talks to (same idea as storage.test.js). */
  function stubApp() {
    const original = {
      waypoints: KPR.waypoints,
      routing: KPR.routing,
      scenes: KPR.scenes,
      app: KPR.app,
      map: KPR.map,
      mapboxgl: window.mapboxgl,
    };
    KPR.waypoints = { loadFrom() {} };
    KPR.routing = { recalculate: async () => {}, getRouteCoords: () => F.oldRoute };
    KPR.scenes = Object.assign({}, original.scenes, { loadFrom: () => ({ loaded: 0, skipped: 0 }) });
    KPR.app = { refreshLists() {} };
    KPR.map = { getFitPadding: () => 40, getMap: () => ({ fitBounds() {} }) };
    window.mapboxgl = {
      LngLatBounds: function () {
        this.extend = () => this;
      },
    };
    return () => {
      KPR.waypoints = original.waypoints;
      KPR.routing = original.routing;
      KPR.scenes = original.scenes;
      KPR.app = original.app;
      KPR.map = original.map;
      window.mapboxgl = original.mapboxgl;
    };
  }

  test("evaluation: applyRoute fills the box from the route, then clears it for a route without vehicles", async () => {
    await withEval({ kprVehicles: JSON.stringify(["Remembered"]) }, async (store) => {
      const restore = stubApp();
      try {
        const withVehicles = St.normalizeFileData(
          Object.assign(JSON.parse(JSON.stringify(F.v1File)), { formatVersion: 3, vehicles: ["Ariya #1", "Leaf #2"] })
        );
        await St.applyRoute(withVehicles);
        assert.deepEqual(E.getVehicles(), ["Ariya #1", "Leaf #2"]);

        // A v2 file (no vehicles) must not keep the previous route's list.
        const v2 = St.normalizeFileData(Object.assign(JSON.parse(JSON.stringify(F.v1File)), { formatVersion: 2 }));
        assert.equal("vehicles" in v2, false);
        await St.applyRoute(v2);
        assert.deepEqual(E.getVehicles(), []);
        assert.equal($("eval-vehicles").value, "");

        assert.equal(store.data.get("kprVehicles"), JSON.stringify(["Remembered"]), "remembered list untouched by loading");
      } finally {
        restore();
      }
    });
  });

  test("evaluation: a route's vehicles are saved to the file and clear when absent", async () => {
    await withEval({}, () => {
      const base = { name: "R", waypoints: [], scenes: [], routeCoords: [], routeSummary: {} };
      E.setVehicles(["Ariya #1"]);
      assert.deepEqual(St.buildSaveData(Object.assign({ vehicles: E.getVehicles() }, base)).vehicles, ["Ariya #1"]);
      E.setVehicles([]);
      assert.equal("vehicles" in St.buildSaveData(Object.assign({ vehicles: E.getVehicles() }, base)), false);
    });
  });

  // ---- the Share link carries the list -------------------------------------

  test("evaluation: the Share link carries the vehicle list only when one is set", async () => {
    await withEval({}, async () => {
      const saved = {
        count: KPR.waypoints.count,
        getSave: KPR.waypoints.getSaveData,
        sceneSave: KPR.scenes.getSaveData,
        encode: KPR.codec.encode,
      };
      const seen = [];
      KPR.waypoints.count = () => 2;
      KPR.waypoints.getSaveData = () => [
        { lat: 36.1, lng: -115.1, name: "A", detail: "" },
        { lat: 36.2, lng: -115.2, name: "B", detail: "" },
      ];
      KPR.scenes.getSaveData = () => [];
      KPR.codec.encode = async (route) => {
        seen.push(route);
        return saved.encode(route);
      };
      try {
        E.setVehicles(["Ariya #1", "Leaf #2"]);
        $("share-route").click();
        await until(() => !$("share-copy").disabled, "the link");
        const link = $("share-link").value;
        const back = await KPR.codec.decode(link.slice(link.indexOf("#r=") + 3));
        assert.deepEqual(back.vehicles, ["Ariya #1", "Leaf #2"]);
        $("share-close").click();

        E.setVehicles([]);
        $("share-route").click();
        await until(() => seen.length === 2 && !$("share-copy").disabled, "the second link");
        assert.deepEqual(seen[1].vehicles, []);
        const link2 = $("share-link").value;
        const back2 = await KPR.codec.decode(link2.slice(link2.indexOf("#r=") + 3));
        assert.equal("vehicles" in back2, false);
        $("share-close").click();
      } finally {
        KPR.waypoints.count = saved.count;
        KPR.waypoints.getSaveData = saved.getSave;
        KPR.scenes.getSaveData = saved.sceneSave;
        KPR.codec.encode = saved.encode;
        $("share-dialog").classList.add("hidden");
      }
    });
  });

  // ---- vehicle options -------------------------------------------------------

  const HOSTILE = [
    '"><img src=x onerror=window.__pwned=1>',
    '" onmouseover="window.__pwned=1',
    "<script>window.__pwned=1</script>",
    "constructor",
    "__proto__",
    "url(javascript:alert(1))",
  ];

  /** Fails if a tree holds anything an injection would have created. */
  function assertSafeTree(root, what) {
    assert.equal(
      root.querySelectorAll("img, script, iframe, object, embed, svg, style, link").length,
      0,
      `${what}: injected element`
    );
    [root, ...root.querySelectorAll("*")].forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        assert.ok(!/^on/i.test(a.name), `${what}: ${el.tagName} has attribute ${a.name}`);
      });
    });
    assert.equal(window.__pwned, undefined, `${what}: injected script ran`);
  }

  test("evaluation: renderVehicleOptions puts a disabled placeholder first and shows names as text only", () => {
    const sel = document.createElement("select");
    E.renderVehicleOptions(sel, HOSTILE);
    assert.equal(sel.options.length, HOSTILE.length + 1);
    assert.equal(sel.options[0].value, "");
    assert.ok(sel.options[0].disabled, "placeholder is disabled");
    assert.equal(sel.options[0].textContent, "Select vehicle");
    assert.equal(sel.value, "", "nothing chosen yet");
    HOSTILE.forEach((name, i) => {
      assert.equal(sel.options[i + 1].textContent, name, "name shown verbatim");
      assert.equal(sel.options[i + 1].value, String(i), "value is the position, not the name");
    });
    assertSafeTree(sel, "vehicle select");
    // Rendering again replaces, it does not append.
    E.renderVehicleOptions(sel, ["Only"]);
    assert.equal(sel.options.length, 2);
  });

  // ---- vehicle dialog ---------------------------------------------------------

  /** Close the dialog if a test left it open. */
  function closeDialog() {
    if (E.isVehicleDialogOpen()) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  }

  function pick(index) {
    $("vehicle-select").value = String(index);
    fire($("vehicle-select"), "change");
  }

  test("dialog: hostile names are shown as text only and Start stays disabled until one is chosen", async () => {
    await withEval({}, () => {
      try {
        assert.equal(E.openVehicleDialog({ vehicles: HOSTILE, fingerprint: "fp", routeName: HOSTILE[0] }, () => {}), true);
        assert.ok(!$("vehicle-dialog").classList.contains("hidden"), "dialog open");
        assert.equal($("vehicle-select").options[0].value, "");
        assert.ok($("vehicle-select").options[0].disabled);
        assert.ok($("vehicle-start").disabled, "Start disabled before choosing");
        assert.equal($("vehicle-dialog-route").textContent, HOSTILE[0], "route name is text");
        assertSafeTree($("vehicle-dialog"), "vehicle dialog");
        pick(2);
        assert.ok(!$("vehicle-start").disabled, "Start enabled once a vehicle is chosen");
      } finally {
        closeDialog();
      }
    });
  });

  test("dialog: Start passes the chosen vehicle and the evaluator name, saves the name, and closes", async () => {
    await withEval({}, (store) => {
      const got = [];
      E.openVehicleDialog({ vehicles: ["Ariya #1", "Leaf #2"], fingerprint: "fp" }, (c) => got.push(c));
      pick(1);
      $("evaluator-name").value = "  Pat  ";
      $("vehicle-start").click();
      assert.deepEqual(got, [{ vehicle: "Leaf #2", evaluator: "Pat" }]);
      assert.ok($("vehicle-dialog").classList.contains("hidden"), "dialog closed");
      assert.ok(!E.isVehicleDialogOpen());
      assert.equal(store.data.get("kprEvaluator"), "Pat", "name remembered on this device");

      // ...and offered again next time.
      E.openVehicleDialog({ vehicles: ["Ariya #1", "Leaf #2"], fingerprint: "fp" }, () => {});
      assert.equal($("evaluator-name").value, "Pat");
      closeDialog();
    });
  });

  test("dialog: Escape, Cancel and the backdrop close it without starting", async () => {
    await withEval({}, () => {
      let starts = 0;
      const onStart = () => starts++;
      E.openVehicleDialog({ vehicles: ["A", "B"], fingerprint: "fp" }, onStart);
      pick(0);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      assert.ok($("vehicle-dialog").classList.contains("hidden"), "Escape closes");
      assert.ok(!E.isVehicleDialogOpen());

      E.openVehicleDialog({ vehicles: ["A", "B"], fingerprint: "fp" }, onStart);
      pick(0);
      $("vehicle-cancel").click();
      assert.ok($("vehicle-dialog").classList.contains("hidden"), "Cancel closes");

      E.openVehicleDialog({ vehicles: ["A", "B"], fingerprint: "fp" }, onStart);
      $("vehicle-dialog").click(); // a click on the backdrop itself
      assert.ok($("vehicle-dialog").classList.contains("hidden"), "backdrop closes");
      assert.equal(starts, 0, "onStart was never called");
    });
  });

  test("dialog: a click inside the box does not close it; a second open is refused", async () => {
    await withEval({}, () => {
      try {
        assert.equal(E.openVehicleDialog({ vehicles: ["A"], fingerprint: "fp" }, () => {}), true);
        $("vehicle-select").click();
        assert.ok(!$("vehicle-dialog").classList.contains("hidden"), "still open");
        assert.equal(E.openVehicleDialog({ vehicles: ["B"], fingerprint: "fp" }, () => {}), false);
        assert.equal($("vehicle-select").options[1].textContent, "A", "the open dialog was left alone");
      } finally {
        closeDialog();
      }
    });
  });

  test("dialog: the last vehicle for this route is preselected only if it is still listed", async () => {
    await withEval({}, () => {
      KPR.ratings.setLastVehicle("fp-route", "Leaf #2");
      try {
        E.openVehicleDialog({ vehicles: ["Ariya #1", "Leaf #2", "Rogue"], fingerprint: "fp-route" }, () => {});
        assert.equal($("vehicle-select").value, "1", "Leaf #2 preselected");
        assert.ok(!$("vehicle-start").disabled, "Start usable right away");
        closeDialog();

        E.openVehicleDialog({ vehicles: ["Ariya #1", "Rogue"], fingerprint: "fp-route" }, () => {});
        assert.equal($("vehicle-select").value, "", "no longer listed -> nothing preselected");
        assert.ok($("vehicle-start").disabled);
        closeDialog();

        E.openVehicleDialog({ vehicles: ["Ariya #1", "Leaf #2"], fingerprint: "another-route" }, () => {});
        assert.equal($("vehicle-select").value, "", "a different route -> nothing preselected");
        closeDialog();
      } finally {
        closeDialog();
      }
    });
  });

  test("dialog: a vehicle name that looks like a selector is matched as a plain string", async () => {
    await withEval({}, () => {
      const odd = 'A"],[value="0';
      KPR.ratings.setLastVehicle("fp-odd", odd);
      try {
        E.openVehicleDialog({ vehicles: ["Plain", odd], fingerprint: "fp-odd" }, () => {});
        assert.equal($("vehicle-select").value, "1");
      } finally {
        closeDialog();
      }
    });
  });
})();
