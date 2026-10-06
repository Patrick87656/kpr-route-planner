/**
 * scene-badge.test.js — scenes.loadFrom stamps `srcIndex`, and the
 * Good / Bad / not-rated badge on a scene's map pin.
 *
 * Mapbox is replaced by the same tiny stubs render-audit.test.js uses for its
 * addScene test, so the real js/scenes.js runs without a map.
 */
(function () {
  const F = window.KPR_FIXTURES;
  const S = KPR.scenes;

  const HOSTILE_KINDS = [
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "GOOD",
    "good ",
    " good",
    "",
    "good\"><img src=x onerror=window.__pwned=1>",
    "<script>window.__pwned=1</script>",
    5,
    true,
    {},
    [],
    ["good"],
  ];

  /** Run fn with Mapbox stubbed and a 11-point route loaded, then restore. */
  function withStubbedMap(fn) {
    const savedMapboxgl = window.mapboxgl;
    const savedMap = KPR.map;
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
        this.setDOMContent = () => this;
        this.remove = () => {};
      },
      Marker: function (opts) {
        this.element = opts.element;
        this.setLngLat = () => this;
        this.addTo = () => this;
        this.remove = () => {};
        this.getElement = () => this.element;
      },
    };
    try {
      S.onRouteUpdated(F.oldRoute);
      fn();
    } finally {
      S.clearAll();
      S.onRouteUpdated(null);
      window.mapboxgl = savedMapboxgl;
      KPR.map = savedMap;
    }
  }

  const rec = (label, startLat, endLat) => ({
    type: "NVH",
    typeLabel: "NVH",
    label,
    notes: "",
    startLat,
    startLng: -83,
    endLat,
    endLng: -83,
  });

  // ---- srcIndex ------------------------------------------------------

  test("srcIndex: survives a skipped middle scene", () => {
    withStubbedMap(() => {
      const list = [
        rec("first", 42.001, 42.003),
        { type: "NVH", typeLabel: "NVH", label: "unplaceable", notes: "" }, // no coordinates, no indices
        rec("third", 42.006, 42.009),
      ];
      const result = S.loadFrom(list);
      assert.deepEqual(result, { loaded: 2, skipped: 1 });
      const all = S.getAll();
      assert.equal(all.length, 2, "getAll() is shorter than the list");
      assert.deepEqual(all.map((s) => s.label), ["first", "third"]);
      assert.deepEqual(all.map((s) => s.srcIndex), [0, 2]);
    });
  });

  test("srcIndex: counts junk entries too, and is reset by the next load", () => {
    withStubbedMap(() => {
      S.loadFrom([null, "junk", rec("only", 42.002, 42.004)]);
      assert.deepEqual(S.getAll().map((s) => s.srcIndex), [2]);
      S.loadFrom([rec("a", 42.001, 42.003), rec("b", 42.005, 42.007)]);
      assert.deepEqual(S.getAll().map((s) => s.srcIndex), [0, 1]);
    });
  });

  test("srcIndex: scenes added by hand have none, and it does not leak into saved data", () => {
    withStubbedMap(() => {
      const hand = S.addScene(1, 3, "NVH", "NVH", "hand", "");
      assert.equal(hand.srcIndex, undefined);
      S.loadFrom([rec("x", 42.001, 42.003)]);
      assert.equal("srcIndex" in S.getSaveData()[0], false);
    });
  });

  // ---- buildRatingBadge ----------------------------------------------

  test("badge: good / bad / none build the expected element", () => {
    [
      ["good", "rating-badge good", "Rated good", true],
      ["bad", "rating-badge bad", "Rated bad", true],
      ["none", "rating-badge none", "Not rated", false],
    ].forEach(([kind, cls, label, hasPath]) => {
      const el = S.buildRatingBadge(kind);
      assert.ok(el, kind);
      assert.equal(el.className, cls);
      assert.equal(el.getAttribute("aria-label"), label);
      const svg = el.querySelector("svg");
      assert.ok(svg, `${kind}: has an icon`);
      assert.equal(svg.getAttribute("aria-hidden"), "true", `${kind}: icon hidden from screen readers`);
      assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg");
      assert.equal(!!svg.querySelector("path"), hasPath, `${kind}: path`);
      assert.equal(!!svg.querySelector("rect"), !hasPath, `${kind}: bar`);
      // Thumb down is the thumb up rotated; the dash is neither.
      assert.equal(!!svg.querySelector("path[transform]"), kind === "bad", `${kind}: rotation`);
      assert.equal(el.textContent, "", `${kind}: no text content`);
    });
  });

  test("badge: unknown or hostile kinds build nothing", () => {
    HOSTILE_KINDS.forEach((kind) => {
      assert.equal(S.buildRatingBadge(kind), null, JSON.stringify(kind));
    });
    assert.equal(S.buildRatingBadge(null), null);
    assert.equal(S.buildRatingBadge(undefined), null);
    assert.equal(window.__pwned, undefined);
  });

  test("badge: nothing but fixed attributes and elements is ever produced", () => {
    ["good", "bad", "none"].forEach((kind) => {
      const el = S.buildRatingBadge(kind);
      const all = [el].concat(Array.from(el.querySelectorAll("*")));
      all.forEach((node) => {
        assert.ok(["SPAN", "svg", "path", "rect"].includes(node.tagName), `${kind}: unexpected <${node.tagName}>`);
        Array.from(node.attributes).forEach((a) => {
          assert.ok(!/^on/i.test(a.name), `${kind}: ${a.name}`);
          assert.ok(a.name !== "style", `${kind}: inline style`);
        });
      });
    });
  });

  // ---- setRatingBadge ------------------------------------------------

  test("badge: add, replace and remove on a scene pin", () => {
    withStubbedMap(() => {
      const scene = S.addScene(1, 4, "NVH", "NVH", "one", "");
      const host = scene.pinMarker.getElement();
      const badges = () => host.querySelectorAll(".rating-badge");
      assert.equal(badges().length, 0);

      S.setRatingBadge(scene.id, "good");
      assert.equal(badges().length, 1);
      assert.equal(badges()[0].className, "rating-badge good");
      assert.equal(badges()[0].parentNode, host, "inside the pin's wrap element");

      S.setRatingBadge(scene.id, "bad");
      assert.equal(badges().length, 1, "replaced, not stacked");
      assert.equal(badges()[0].className, "rating-badge bad");

      S.setRatingBadge(scene.id, "none");
      assert.equal(badges().length, 1);
      assert.equal(badges()[0].className, "rating-badge none");

      S.setRatingBadge(scene.id, null);
      assert.equal(badges().length, 0, "null removes it");

      S.setRatingBadge(scene.id, "good");
      S.setRatingBadge(scene.id, undefined);
      assert.equal(badges().length, 0, "undefined removes it");

      // The pin label itself is untouched by all of this.
      assert.equal(host.querySelector(".scene-pin-marker").textContent, "one");
    });
  });

  test("badge: hostile kind strings add nothing and leave an existing badge alone", () => {
    withStubbedMap(() => {
      const scene = S.addScene(1, 4, "NVH", "NVH", "one", "");
      const host = scene.pinMarker.getElement();
      HOSTILE_KINDS.forEach((kind) => {
        S.setRatingBadge(scene.id, kind);
        assert.equal(host.querySelectorAll(".rating-badge").length, 0, JSON.stringify(kind));
      });
      S.setRatingBadge(scene.id, "bad");
      HOSTILE_KINDS.forEach((kind) => S.setRatingBadge(scene.id, kind));
      const left = host.querySelectorAll(".rating-badge");
      assert.equal(left.length, 1);
      assert.equal(left[0].className, "rating-badge bad");
      assert.equal(host.querySelectorAll("img, script").length, 0);
      assert.equal(window.__pwned, undefined);
    });
  });

  test("badge: an unknown scene id is ignored, and badges go away with the scene", () => {
    withStubbedMap(() => {
      S.setRatingBadge(99999, "good"); // must not throw
      const a = S.addScene(1, 3, "NVH", "NVH", "a", "");
      const b = S.addScene(4, 6, "NVH", "NVH", "b", "");
      S.setRatingBadge(a.id, "good");
      S.setRatingBadge(b.id, "bad");
      assert.equal(a.pinMarker.getElement().querySelectorAll(".rating-badge").length, 1);
      assert.equal(b.pinMarker.getElement().querySelectorAll(".rating-badge").length, 1);
      S.removeScene(a.id);
      S.setRatingBadge(a.id, "good"); // gone: ignored
      assert.equal(b.pinMarker.getElement().querySelectorAll(".rating-badge").length, 1, "the other pin is unaffected");
    });
  });
})();
