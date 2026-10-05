/**
 * render-audit.test.js — proves that text from files, shared links and the
 * Mapbox API can't turn into markup, attributes or styles in the UI.
 *
 * It renders the real itinerary / scene cards / legend (app.js) and the real
 * popup / pin builders (scenes.js) with hostile strings, then checks the
 * resulting DOM: no injected elements, no on* attributes, the text shows up
 * verbatim, and every inline color is a plain hex / rgb value.
 */
(function () {
  const HOSTILE = [
    '"><img src=x onerror=window.__pwned=1>',
    '" onmouseover="window.__pwned=1',
    "<script>window.__pwned=1</script>",
    "constructor",
    "__proto__",
    "url(javascript:alert(1))",
  ];

  const COLOR_OK = /^(|#[0-9a-f]{6}|rgba?\([\d\s.,]+\))$/i;

  function allElements(root) {
    return [root, ...root.querySelectorAll("*")];
  }

  /** Fails if the tree contains anything an injection would have created. */
  function assertSafeTree(root, what) {
    assert.equal(
      root.querySelectorAll("img, script, iframe, object, embed, svg, style, link").length,
      0,
      `${what}: injected element`
    );
    allElements(root).forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        assert.ok(!/^on/i.test(a.name), `${what}: ${el.tagName} has attribute ${a.name}`);
      });
      ["background", "color", "borderLeftColor"].forEach((prop) => {
        const v = el.style[prop];
        assert.ok(COLOR_OK.test(v), `${what}: unexpected inline ${prop} "${v}"`);
      });
    });
    assert.equal(window.__pwned, undefined, `${what}: injected script ran`);
  }

  /** Swap in stubs for everything the list renderers reach for, run `fn`,
   * then put the real pieces back and empty the lists. */
  function withRenderStubs(stubs, fn) {
    const saved = {
      routing: KPR.routing,
      map: KPR.map,
      wpGetAll: KPR.waypoints.getAll,
      wpRemove: KPR.waypoints.removeWaypoint,
      scGetAll: KPR.scenes.getAll,
      scRemove: KPR.scenes.removeScene,
      scSetColor: KPR.scenes.setTypeColor,
    };
    KPR.routing = { getRouteCoords: () => null };
    KPR.waypoints.getAll = () => stubs.waypoints || [];
    KPR.scenes.getAll = () => stubs.scenes || [];
    if (stubs.map) KPR.map = stubs.map;
    if (stubs.removeWaypoint) KPR.waypoints.removeWaypoint = stubs.removeWaypoint;
    if (stubs.removeScene) KPR.scenes.removeScene = stubs.removeScene;
    if (stubs.setTypeColor) KPR.scenes.setTypeColor = stubs.setTypeColor;
    try {
      return fn();
    } finally {
      KPR.routing = saved.routing;
      KPR.map = saved.map;
      KPR.waypoints.getAll = saved.wpGetAll;
      KPR.waypoints.removeWaypoint = saved.wpRemove;
      KPR.scenes.getAll = saved.scGetAll;
      KPR.scenes.removeScene = saved.scRemove;
      KPR.scenes.setTypeColor = saved.scSetColor;
      ["waypoint-list", "scene-list", "scene-legend"].forEach((id) => {
        document.getElementById(id).replaceChildren();
      });
    }
  }

  function fakeScene(id, overrides) {
    const popupCalls = [];
    const popup = {
      setLngLat(ll) {
        popupCalls.push(ll);
        return popup;
      },
      addTo() {
        return popup;
      },
    };
    return Object.assign(
      {
        id,
        type: "Custom",
        typeLabel: "Infotainment",
        label: "Label",
        notes: "Notes",
        color: "#10b981",
        startIdx: 0,
        endIdx: 1,
        pinMarker: { getLngLat: () => [1, 2] },
        popup,
        popupCalls,
      },
      overrides
    );
  }

  test("safeColor accepts only #rrggbb", () => {
    const sc = KPR.scenes.safeColor;
    assert.equal(sc("#AbCdEf"), "#AbCdEf");
    assert.equal(sc("#fff"), "#c3002f", "3-digit hex");
    assert.equal(sc("red"), "#c3002f");
    assert.equal(sc("url(javascript:alert(1))"), "#c3002f");
    assert.equal(sc('#123456" onmouseover="x'), "#c3002f");
    assert.equal(sc("#12345678"), "#c3002f");
    assert.equal(sc(undefined), "#c3002f");
    assert.equal(sc(42), "#c3002f");
    assert.equal(sc({}), "#c3002f");
    assert.equal(sc("nope", "#000000"), "#000000", "custom fallback");
    assert.equal(sc("nope", null), null, "null fallback (used as a validity check)");
  });

  test("getTypeColors has no prototype, so odd keys are just missing", () => {
    const colors = KPR.scenes.getTypeColors();
    assert.equal(Object.getPrototypeOf(colors), null);
    ["constructor", "__proto__", "toString", "hasOwnProperty"].forEach((k) => {
      assert.equal(colors[k], undefined, k);
    });
    assert.equal(colors.NVH, KPR.scenes.DEFAULT_SCENE_COLORS.NVH);
  });

  test("setTypeColor ignores values that are not #rrggbb", () => {
    HOSTILE.concat(["red", "#fff", ""]).forEach((bad) => {
      KPR.scenes.setTypeColor("audit-key", bad);
    });
    assert.equal(KPR.scenes.getTypeColors()["audit-key"], undefined);
  });

  test("addScene colors: odd type names fall back to the default, never a function", () => {
    const savedMapboxgl = window.mapboxgl;
    const savedMap = KPR.map;
    const added = [];
    const mapStub = {
      getLayer: () => null,
      getSource: () => null,
      addSource() {},
      addLayer() {},
      removeLayer() {},
      removeSource() {},
      on() {},
      getCanvas: () => ({ style: {} }),
    };
    KPR.map = { getMap: () => mapStub, isStyleReady: () => true };
    window.mapboxgl = {
      Popup: function () {
        this.setDOMContent = (node) => {
          this.content = node;
          return this;
        };
        this.remove = () => {};
      },
      Marker: function (opts) {
        this.element = opts.element;
        this.setLngLat = () => this;
        this.addTo = () => {
          added.push(this);
          return this;
        };
        this.remove = () => {};
        this.getElement = () => this.element;
      },
    };
    try {
      KPR.scenes.onRouteUpdated([
        { lat: 1, lng: 1 },
        { lat: 1.001, lng: 1 },
        { lat: 1.002, lng: 1 },
      ]);
      ["constructor", "__proto__", "toString", "hasOwnProperty"].forEach((name) => {
        const scene = KPR.scenes.addScene(0, 2, "Custom", name, "l", "n");
        assert.equal(scene.color, KPR.scenes.DEFAULT_SCENE_COLORS.Custom, `Custom/${name}`);
      });
      // A type key that isn't a preset at all (only possible from code, since
      // files are normalised) still gets a valid color.
      const odd = KPR.scenes.addScene(0, 2, "constructor", "constructor", "l", "n");
      assert.equal(odd.color, KPR.scenes.DEFAULT_SCENE_COLORS.Custom);
      // A preset keeps its own color, and the pin uses it.
      const nvh = KPR.scenes.addScene(0, 2, "NVH", "NVH", "l", "n");
      assert.equal(nvh.color, KPR.scenes.DEFAULT_SCENE_COLORS.NVH);
      assert.ok(added[added.length - 1].element.querySelector(".scene-pin-marker"), "pin built");
      assert.ok(nvh.popup.content.classList.contains("scene-popup"), "popup built from a DOM node");
    } finally {
      KPR.scenes.clearAll();
      KPR.scenes.onRouteUpdated(null);
      window.mapboxgl = savedMapboxgl;
      KPR.map = savedMap;
    }
  });

  test("popup: hostile text stays literal text", () => {
    HOSTILE.forEach((s) => {
      const node = KPR.scenes.buildPopupContent(s, s, s);
      assertSafeTree(node, "popup");
      assert.equal(node.querySelector(".scene-popup-type").textContent, s);
      assert.equal(node.querySelector(".scene-popup-label").textContent, s);
      assert.equal(node.querySelector(".scene-popup-notes").textContent, s);
    });
  });

  test("popup: same structure and classes as before, including the empty-notes state", () => {
    const full = KPR.scenes.buildPopupContent("NVH", "Bridge", "Buzz at 60");
    assert.equal(full.className, "scene-popup");
    assert.deepEqual(
      Array.from(full.children).map((c) => c.tagName + "." + c.className),
      ["DIV.scene-popup-type", "DIV.scene-popup-label", "P.scene-popup-notes"]
    );
    const empty = KPR.scenes.buildPopupContent("NVH", "Bridge", "");
    const p = empty.querySelector("p");
    assert.equal(p.className, "scene-popup-notes scene-popup-notes-empty");
    assert.equal(p.textContent, "No notes added.");
    assert.equal(KPR.scenes.buildPopupContent(null, undefined, undefined).querySelector(".scene-popup-type").textContent, "");
  });

  test("pin: hostile label and color stay safe; structure unchanged", () => {
    HOSTILE.forEach((s) => {
      const wrap = KPR.scenes.buildPinElement(s, s);
      assertSafeTree(wrap, "pin");
      assert.equal(wrap.className, "scene-pin-marker-wrap");
      const pin = wrap.querySelector(".scene-pin-marker");
      assert.equal(pin.textContent, s);
      assert.equal(pin.parentNode, wrap);
    });
    const ok = KPR.scenes.buildPinElement("Bridge", "#112233");
    assert.equal(ok.firstElementChild.style.background, "rgb(17, 34, 51)");
    const bad = KPR.scenes.buildPinElement("Bridge", "url(javascript:alert(1))");
    assert.equal(bad.firstElementChild.style.background, "rgb(195, 0, 47)", "falls back to the default red");
  });

  test("itinerary: hostile stop names, details and scene tags render as text", () => {
    const waypoints = HOSTILE.map((s, i) => ({ id: i + 1, lat: 42 + i / 100, lng: -83, name: s, detail: s }));
    const scenes = HOSTILE.map((s, i) => fakeScene(i + 1, { typeLabel: s, label: s, notes: s, color: s }));
    withRenderStubs({ waypoints, scenes }, () => {
      KPR.app.refreshLists();
      const list = document.getElementById("waypoint-list");
      assertSafeTree(list, "itinerary");
      const names = Array.from(list.querySelectorAll(".stop-name"));
      const details = Array.from(list.querySelectorAll(".stop-detail"));
      assert.equal(names.length, HOSTILE.length);
      names.forEach((el, i) => {
        assert.equal(el.textContent, HOSTILE[i]);
        assert.equal(el.getAttribute("title"), HOSTILE[i], "title is a verbatim attribute value");
        assert.equal(el.attributes.length, 2, "only class and title");
      });
      details.forEach((el, i) => assert.equal(el.textContent, HOSTILE[i]));
    });
  });

  test("itinerary: scene tags show hostile type labels as text with safe colors", () => {
    // Routing is stubbed with a two-point line so scenes are bucketed onto legs.
    const route = [
      { lat: 42, lng: -83 },
      { lat: 42.01, lng: -83 },
    ];
    const waypoints = [
      { id: 1, lat: 42, lng: -83, name: "A", detail: "" },
      { id: 2, lat: 42.01, lng: -83, name: "B", detail: "" },
    ];
    const scenes = HOSTILE.map((s, i) => fakeScene(i + 1, { typeLabel: s, color: s }));
    withRenderStubs({ waypoints, scenes }, () => {
      KPR.routing = { getRouteCoords: () => route };
      KPR.app.refreshLists();
      const list = document.getElementById("waypoint-list");
      assertSafeTree(list, "itinerary tags");
      const tags = Array.from(list.querySelectorAll(".stop-tag"));
      assert.equal(tags.length, HOSTILE.length);
      tags.forEach((t, i) => {
        assert.equal(t.textContent, HOSTILE[i]);
        assert.equal(t.style.color, "rgb(195, 0, 47)", "invalid color replaced by the default");
      });
    });
  });

  test("itinerary: structure, classes and handlers match the old markup", () => {
    const removed = [];
    const flown = [];
    const map = {
      getMap: () => ({ flyTo: (o) => flown.push(o), getZoom: () => 10 }),
    };
    const waypoints = [
      { id: 7, lat: 42.5, lng: -83.25, name: "Start", detail: "Novi, MI" },
      { id: 8, lat: 42.6, lng: -83.3, name: null, detail: "" },
      { id: 9, lat: 42.7, lng: -83.4, name: "", detail: "" },
    ];
    withRenderStubs({ waypoints, map, removeWaypoint: (id) => removed.push(id) }, () => {
      KPR.app.refreshLists();
      const items = document.querySelectorAll("#waypoint-list > li");
      assert.equal(items.length, 3);
      const first = items[0];
      assert.deepEqual(
        Array.from(first.children).map((c) => c.tagName + "." + c.className),
        ["SPAN.stop-badge", "DIV.stop-text", "BUTTON.remove-btn"]
      );
      assert.equal(first.querySelector(".stop-badge").textContent, "1");
      assert.equal(first.querySelector(".stop-name").textContent, "Start");
      assert.equal(first.querySelector(".stop-detail").textContent, "Novi, MI");
      assert.equal(first.querySelector(".stop-tags"), null, "no tag row without scenes");
      const btn = first.querySelector(".remove-btn");
      assert.equal(btn.textContent, "\u00d7");
      assert.equal(btn.getAttribute("title"), "Remove stop");
      assert.equal(btn.getAttribute("aria-label"), "Remove stop 1");
      assert.equal(first.querySelector(".stop-text").style.cursor, "pointer");

      // Pending name, then the coordinates fallback for an empty name.
      assert.equal(items[1].querySelector(".stop-name").className, "stop-name pending");
      assert.equal(items[1].querySelector(".stop-name").textContent, "Locating\u2026");
      assert.equal(items[2].querySelector(".stop-name").textContent, "42.70000, -83.40000");
      assert.equal(items[2].querySelector(".stop-detail"), null);

      // Last stop gets the flag badge.
      const badge = items[2].querySelector(".stop-badge");
      assert.equal(badge.className, "stop-badge is-last");
      assert.equal(badge.textContent, "\u2691");

      btn.click();
      assert.deepEqual(removed, [7]);
      first.querySelector(".stop-text").click();
      assert.equal(flown.length, 1);
      assert.deepEqual(flown[0].center, [-83.25, 42.5]);
      assert.equal(flown[0].zoom, 14);
    });
  });

  test("scene cards: hostile text and colors render as text; structure unchanged", () => {
    const scenes = HOSTILE.map((s, i) => fakeScene(i + 1, { typeLabel: s, label: s, notes: s, color: s }));
    withRenderStubs({ scenes }, () => {
      KPR.app.refreshLists();
      const list = document.getElementById("scene-list");
      assertSafeTree(list, "scene cards");
      const cards = Array.from(list.children);
      assert.equal(cards.length, HOSTILE.length);
      cards.forEach((li, i) => {
        assert.equal(li.querySelector(".scene-card-type").textContent, HOSTILE[i]);
        assert.equal(li.querySelector(".scene-card-label").textContent, HOSTILE[i]);
        assert.equal(li.querySelector(".scene-card-notes").textContent, HOSTILE[i]);
        assert.equal(li.style.borderLeftColor, "rgb(195, 0, 47)");
      });
    });
  });

  test("scene cards: classes, notes-optional and click handlers", () => {
    const removed = [];
    const panned = [];
    const map = { getMap: () => ({ panTo: (ll) => panned.push(ll) }) };
    const withNotes = fakeScene(1, { color: "#112233" });
    const noNotes = fakeScene(2, { notes: "" });
    withRenderStubs({ scenes: [withNotes, noNotes], map, removeScene: (id) => removed.push(id) }, () => {
      KPR.app.refreshLists();
      const cards = document.querySelectorAll("#scene-list > li");
      assert.equal(cards.length, 2);
      assert.deepEqual(
        Array.from(cards[0].children).map((c) => c.tagName + "." + c.className),
        ["DIV.scene-card-text", "BUTTON.remove-btn"]
      );
      assert.deepEqual(
        Array.from(cards[0].firstElementChild.children).map((c) => c.className),
        ["scene-card-type", "scene-card-label", "scene-card-notes"]
      );
      assert.equal(cards[0].querySelector(".scene-card-type").style.color, "rgb(17, 34, 51)");
      assert.equal(cards[0].style.borderLeftColor, "rgb(17, 34, 51)");
      assert.equal(cards[1].querySelector(".scene-card-notes"), null);
      const btn = cards[0].querySelector(".remove-btn");
      assert.equal(btn.textContent, "\u00d7");
      assert.equal(btn.getAttribute("title"), "Remove scene");
      assert.equal(btn.getAttribute("aria-label"), "Remove scene");

      cards[0].click();
      assert.equal(withNotes.popupCalls.length, 1, "card click opens the popup");
      assert.equal(panned.length, 1);
      btn.click();
      assert.deepEqual(removed, [1], "remove button removes without opening the popup");
      assert.equal(withNotes.popupCalls.length, 1);
    });
  });

  test("legend: hostile category names and colors render as text with valid swatches", () => {
    const scenes = HOSTILE.map((s, i) => fakeScene(i + 1, { type: "Custom", typeLabel: s, color: s }));
    withRenderStubs({ scenes }, () => {
      KPR.app.refreshLists();
      const legend = document.getElementById("scene-legend");
      assertSafeTree(legend, "legend");
      const items = Array.from(legend.children);
      assert.equal(items.length, HOSTILE.length);
      items.forEach((li, i) => {
        assert.equal(li.querySelector("span").textContent, HOSTILE[i]);
        const input = li.querySelector("input");
        assert.equal(input.type, "color");
        assert.equal(input.className, "legend-swatch");
        assert.equal(input.title, `Change color for ${HOSTILE[i]}`);
        assert.ok(/^#[0-9a-f]{6}$/.test(input.value), `swatch value "${input.value}"`);
        assert.equal(input.value, "#d6002f", "unknown / odd keys get the default red");
      });
      assert.equal(legend.previousElementSibling.classList.contains("hidden"), false);
    });
  });

  test("legend: swatch change calls setTypeColor with the category key", () => {
    const calls = [];
    const scenes = [fakeScene(1, { type: "NVH", typeLabel: "NVH" })];
    withRenderStubs({ scenes, setTypeColor: (k, v) => calls.push([k, v]) }, () => {
      KPR.app.refreshLists();
      const input = document.querySelector("#scene-legend input");
      assert.equal(input.value, KPR.scenes.DEFAULT_SCENE_COLORS.NVH);
      input.value = "#123456";
      input.dispatchEvent(new Event("input"));
      assert.deepEqual(calls, [["NVH", "#123456"]]);
    });
  });
})();
