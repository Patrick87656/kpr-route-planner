/**
 * browse-routes.test.js - the "Browse saved routes" panel (js/browse-routes.js).
 *
 * The module fetches routes/index.json, lists each published route, and loads
 * a chosen one through the existing normalizeFileData + applyRoute pipeline.
 * The harness has no network and no Mapbox, so these tests (1) check the pure
 * miles/minutes formatting matches routing.js, (2) drive renderList against a
 * fixture manifest and a hostile one (markup must never survive), and (3) drive
 * open() through a STUBBED fetch seam for the success and failure paths. The
 * actual load of a selected route needs Mapbox/applyRoute and is covered by the
 * headless-browser run, not here.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const B = KPR.browseRoutes;

  const SAMPLE = {
    file: "dealer-training-route-2.json",
    name: "Dealer Training Route 2",
    start: "Genesee Avenue, San Diego, California 92121",
    end: "Genesee Avenue, La Jolla, California 92121",
    distanceMeters: 17442.094,
    durationSeconds: 1408.361,
    waypointCount: 10,
    sceneCount: 8,
    vehicles: ["Nissan Rogue Hybrid", "Toyota RAV4 Hybrid"],
    date: "2026-10-19T16:47:16.879Z",
  };

  // A fetch stub that resolves to a JSON body (ok=true) or rejects.
  function okFetch(body) {
    return () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }
  function rejectFetch() {
    return () => Promise.reject(new Error("offline"));
  }
  function notOkFetch() {
    return () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }

  function reset() {
    $("browse-dialog").classList.add("hidden");
    $("browse-list").textContent = "";
    $("browse-msg").textContent = "";
    $("browse-msg").classList.add("hidden");
  }

  B.init(); // wire the dialog once, like the app does

  // ---- formatting (must match routing.js _setStats) -------------------

  test("browse: formatMiles matches routing.js (meters / 1609.34, one decimal)", () => {
    assert.equal(B.formatMiles(17442.094), "10.8");
    assert.equal(B.formatMiles(0), "0.0");
    assert.equal(B.formatMiles(1609.34), "1.0");
  });

  test("browse: formatMinutes matches routing.js (round seconds / 60)", () => {
    assert.equal(B.formatMinutes(1408.361), "23");
    assert.equal(B.formatMinutes(0), "0");
    assert.equal(B.formatMinutes(90), "2");
  });

  // ---- renderList -----------------------------------------------------

  test("browse: renderList shows name, miles, minutes, scenes, stops and vehicles", () => {
    reset();
    const list = $("browse-list");
    B.renderList(list, [SAMPLE]);
    const rows = list.querySelectorAll("li");
    assert.equal(rows.length, 1);
    const text = rows[0].textContent;
    assert.ok(text.includes("Dealer Training Route 2"), "name");
    assert.ok(text.includes("10.8 mi"), "miles");
    assert.ok(text.includes("23 min"), "minutes");
    assert.ok(text.includes("8 scenes"), "scene count");
    assert.ok(text.includes("10 stops"), "stop count");
    assert.ok(text.includes("Nissan Rogue Hybrid"), "vehicle one");
    assert.ok(text.includes("Toyota RAV4 Hybrid"), "vehicle two");
    reset();
  });

  test("browse: renderList with an empty list shows the empty message", () => {
    reset();
    const list = $("browse-list");
    B.renderList(list, []);
    assert.equal(list.querySelectorAll("li").length, 0);
    assert.ok(!$("browse-msg").classList.contains("hidden"), "message shown");
    assert.ok($("browse-msg").textContent.length > 5);
    reset();
  });

  test("browse: a route with no vehicles still renders (just omits the vehicle part)", () => {
    reset();
    const list = $("browse-list");
    const noVeh = Object.assign({}, SAMPLE, { vehicles: [] });
    B.renderList(list, [noVeh]);
    const text = list.querySelector("li").textContent;
    assert.ok(text.includes("10 stops"), "still shows the rest");
    reset();
  });

  test("browse: hostile manifest strings are shown as plain text, never as markup", () => {
    reset();
    window.__pwned = undefined;
    const list = $("browse-list");
    const hostile = Object.assign({}, SAMPLE, {
      name: '<img src=x onerror="window.__pwned=1">',
      vehicles: ["<script>window.__pwned=1<\/script>"],
    });
    B.renderList(list, [hostile]);
    assert.equal(window.__pwned, undefined, "nothing executed");
    assert.equal(list.querySelector("img, script"), null, "no elements from hostile strings");
    assert.ok(list.textContent.includes("<img src=x"), "shown verbatim as text");
    reset();
  });

  // ---- open() with a stubbed fetch (no network) -----------------------

  test("browse: open() fetches the manifest and lists the saved route", async () => {
    reset();
    B._setFetch(okFetch({ routes: [SAMPLE] }));
    await B.open();
    assert.ok(!$("browse-dialog").classList.contains("hidden"), "dialog open");
    const rows = $("browse-list").querySelectorAll("li");
    assert.equal(rows.length, 1);
    assert.ok(rows[0].textContent.includes("Dealer Training Route 2"));
    B.close();
    reset();
  });

  test("browse: open() with a rejected fetch shows a friendly error and does not throw", async () => {
    reset();
    B._setFetch(rejectFetch());
    await B.open(); // must not throw
    assert.equal($("browse-list").querySelectorAll("li").length, 0, "no rows");
    assert.ok(!$("browse-msg").classList.contains("hidden"), "message shown");
    assert.ok($("browse-msg").textContent.length > 5);
    B.close();
    reset();
  });

  test("browse: open() with a non-ok response shows a friendly error and does not throw", async () => {
    reset();
    B._setFetch(notOkFetch());
    await B.open();
    assert.equal($("browse-list").querySelectorAll("li").length, 0);
    assert.ok(!$("browse-msg").classList.contains("hidden"));
    B.close();
    reset();
  });

  test("browse: open() with an empty library shows the empty message", async () => {
    reset();
    B._setFetch(okFetch({ routes: [] }));
    await B.open();
    assert.equal($("browse-list").querySelectorAll("li").length, 0);
    assert.ok(!$("browse-msg").classList.contains("hidden"));
    B.close();
    reset();
  });

  // ---- dialog wiring --------------------------------------------------

  test("browse: the button opens the dialog; Close, backdrop and Escape close it", async () => {
    reset();
    B._setFetch(okFetch({ routes: [SAMPLE] }));

    $("browse-routes").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!$("browse-dialog").classList.contains("hidden"), "opened by button");
    $("browse-close").click();
    assert.ok($("browse-dialog").classList.contains("hidden"), "Close");

    await B.open();
    $("browse-dialog").click(); // backdrop = the dialog element itself
    assert.ok($("browse-dialog").classList.contains("hidden"), "backdrop");

    await B.open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    assert.ok($("browse-dialog").classList.contains("hidden"), "Escape");
    reset();
  });
})();
