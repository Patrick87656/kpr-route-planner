/**
 * start-chooser.test.js - the "Start with" chooser (js/start-chooser.js).
 *
 * The chooser has no Mapbox or network dependency of its own: the collapse
 * decision is a pure function of the stop count, and its two actions just
 * delegate to KPR.browseRoutes.open() and KPR.waypoints.confirmClearAll().
 * So these tests cover (1) the pure shouldCollapse decision, (2) sync()
 * toggling the collapsed class from the live count (driven through a stubbed
 * KPR.waypoints.count, the same seam-stub style browse-routes uses for fetch),
 * and (3) that "New route" routes through the ONE shared clear path
 * (confirmClearAll) and does not duplicate the confirm wording.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const C = KPR.startChooser;

  C.init(); // wire the cards once, like the app does

  function reset() {
    $("start-chooser").classList.remove("is-collapsed");
  }

  // ---- shouldCollapse (pure) ------------------------------------------

  test("start-chooser: shouldCollapse is false for an empty route, true once there are stops", () => {
    assert.equal(C.shouldCollapse(0), false);
    assert.equal(C.shouldCollapse(1), true);
    assert.equal(C.shouldCollapse(2), true);
    assert.equal(C.shouldCollapse(50), true);
  });

  test("start-chooser: shouldCollapse treats junk / non-number input as not-collapsed", () => {
    [null, undefined, NaN, "", "abc", {}, [], -1].forEach((v) => {
      assert.equal(C.shouldCollapse(v), false, JSON.stringify(v));
    });
    // A numeric string that is a real positive count still collapses.
    assert.equal(C.shouldCollapse("3"), true);
  });

  // ---- sync() toggles the collapsed class from the count --------------

  test("start-chooser: sync() collapses when stops exist and expands when empty", () => {
    reset();
    const realCount = KPR.waypoints.count;
    try {
      let n = 0;
      KPR.waypoints.count = () => n;

      n = 0;
      C.sync();
      assert.ok(!$("start-chooser").classList.contains("is-collapsed"), "empty route stays expanded");

      n = 3;
      C.sync();
      assert.ok($("start-chooser").classList.contains("is-collapsed"), "stops collapse the chooser");

      n = 0;
      C.sync();
      assert.ok(!$("start-chooser").classList.contains("is-collapsed"), "emptying expands it again");
    } finally {
      KPR.waypoints.count = realCount;
      reset();
    }
  });

  // ---- "New route" routes through the ONE shared clear path -----------

  test("start-chooser: the New route card calls KPR.waypoints.confirmClearAll exactly once", () => {
    const realConfirmClear = KPR.waypoints.confirmClearAll;
    const realConfirm = window.confirm;
    try {
      let calls = 0;
      KPR.waypoints.confirmClearAll = () => { calls++; };
      // If the chooser duplicated the confirm wording it would call this; it
      // must not — the confirm lives only inside confirmClearAll.
      let confirmed = 0;
      window.confirm = () => { confirmed++; return false; };

      $("chooser-new").click();
      assert.equal(calls, 1, "the shared clear path ran once");
      assert.equal(confirmed, 0, "the chooser does not re-prompt (no duplicated confirm)");
    } finally {
      KPR.waypoints.confirmClearAll = realConfirmClear;
      window.confirm = realConfirm;
    }
  });

  test("start-chooser: the compact New route button also routes through confirmClearAll", () => {
    const realConfirmClear = KPR.waypoints.confirmClearAll;
    try {
      let calls = 0;
      KPR.waypoints.confirmClearAll = () => { calls++; };
      $("chooser-new-compact").click();
      assert.equal(calls, 1);
    } finally {
      KPR.waypoints.confirmClearAll = realConfirmClear;
    }
  });

  // ---- "Browse library" routes to the saved-routes dialog -------------

  test("start-chooser: the Browse library cards call KPR.browseRoutes.open", () => {
    const realOpen = KPR.browseRoutes.open;
    try {
      let calls = 0;
      KPR.browseRoutes.open = () => { calls++; };
      $("chooser-browse").click();
      $("chooser-browse-compact").click();
      assert.equal(calls, 2, "both the big and compact Browse buttons open the library");
    } finally {
      KPR.browseRoutes.open = realOpen;
    }
  });
})();
