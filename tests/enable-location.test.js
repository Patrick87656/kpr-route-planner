/**
 * enable-location.test.js — the "Enable location" strip (js/enable-location-strip.js).
 *
 * The strip is a footer row above Start drive that only shows when geolocation
 * permission is 'prompt' or 'denied'. render(state) toggles it; the button
 * triggers the native popup in 'prompt' (KPR.map.requestLocation) and reveals
 * device-specific re-enable steps in 'denied' (never re-prompting).
 *
 * No Mapbox/network here, so we drive the module through its seams: render() is
 * exported and called directly for the show/hide tests, and the click tests
 * stub KPR.geoPermission.getState/isIOS and KPR.map.requestLocation on the
 * objects themselves (mirroring how browse-routes.test.js stubs its fetch
 * seam). Every stub is restored in a finally so later tests see the real API.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const S = KPR.enableLocationStrip;

  S.init(); // wire the button's click handler once, like the app does

  function reset() {
    $("enable-location").classList.add("hidden");
    const help = $("enable-location-help");
    help.classList.add("hidden");
    help.textContent = "";
  }

  // Stub KPR.geoPermission.getState / isIOS for a block, restoring after.
  function withGeo(opts, fn) {
    const g = KPR.geoPermission;
    const origGetState = g.getState;
    const origIsIOS = g.isIOS;
    if (opts.state !== undefined) g.getState = () => opts.state;
    if (opts.ios !== undefined) g.isIOS = () => opts.ios;
    try {
      return fn();
    } finally {
      g.getState = origGetState;
      g.isIOS = origIsIOS;
    }
  }

  // Stub KPR.map.requestLocation with a spy, restoring KPR.map after.
  function withMapSpy(fn) {
    const origMap = KPR.map;
    const spy = { calls: 0 };
    KPR.map = { requestLocation: () => { spy.calls++; return true; } };
    try {
      return fn(spy);
    } finally {
      KPR.map = origMap;
    }
  }

  // ---- render(): show/hide by state ------------------------------------

  test("enable-location: render('granted') hides the strip and its help", () => {
    reset();
    $("enable-location").classList.remove("hidden");
    $("enable-location-help").classList.remove("hidden");
    S.render("granted");
    assert.ok($("enable-location").classList.contains("hidden"), "strip hidden");
    assert.ok($("enable-location-help").classList.contains("hidden"), "help hidden");
    reset();
  });

  test("enable-location: render('unsupported') hides the strip", () => {
    reset();
    $("enable-location").classList.remove("hidden");
    S.render("unsupported");
    assert.ok($("enable-location").classList.contains("hidden"), "strip hidden");
    reset();
  });

  test("enable-location: render('prompt') shows the strip, help stays hidden", () => {
    reset();
    S.render("prompt");
    assert.ok(!$("enable-location").classList.contains("hidden"), "strip shown");
    assert.ok($("enable-location-help").classList.contains("hidden"), "help hidden");
    reset();
  });

  test("enable-location: render('denied') shows the strip, help stays hidden until tapped", () => {
    reset();
    S.render("denied");
    assert.ok(!$("enable-location").classList.contains("hidden"), "strip shown");
    assert.ok($("enable-location-help").classList.contains("hidden"), "help hidden");
    reset();
  });

  // ---- button click in 'prompt' ---------------------------------------

  test("enable-location: clicking in 'prompt' calls KPR.map.requestLocation", () => {
    reset();
    withMapSpy((spy) => {
      withGeo({ state: "prompt" }, () => {
        S.render("prompt");
        $("enable-location-btn").click();
        assert.equal(spy.calls, 1, "requestLocation called once");
      });
    });
    assert.ok($("enable-location-help").classList.contains("hidden"), "no help shown in prompt");
    reset();
  });

  // ---- button click in 'denied' ---------------------------------------

  test("enable-location: clicking in 'denied' reveals iOS steps and does NOT re-prompt", () => {
    reset();
    withMapSpy((spy) => {
      withGeo({ state: "denied", ios: true }, () => {
        S.render("denied");
        $("enable-location-btn").click();
        const help = $("enable-location-help");
        assert.ok(!help.classList.contains("hidden"), "help revealed");
        assert.ok(help.textContent.indexOf("Safari") !== -1, "iOS-specific steps");
        assert.equal(spy.calls, 0, "requestLocation NOT called when denied");
      });
    });
    reset();
  });

  test("enable-location: clicking in 'denied' on a non-iOS device shows generic steps", () => {
    reset();
    withMapSpy((spy) => {
      withGeo({ state: "denied", ios: false }, () => {
        S.render("denied");
        $("enable-location-btn").click();
        const help = $("enable-location-help");
        assert.ok(!help.classList.contains("hidden"), "help revealed");
        assert.ok(help.textContent.toLowerCase().indexOf("site settings") !== -1, "generic site-settings steps");
        assert.ok(help.textContent.indexOf("Safari") === -1, "not the iOS text");
        assert.equal(spy.calls, 0, "requestLocation NOT called when denied");
      });
    });
    reset();
  });

  test("enable-location: a second tap in 'denied' toggles the help region closed", () => {
    reset();
    withGeo({ state: "denied", ios: false }, () => {
      S.render("denied");
      $("enable-location-btn").click();
      assert.ok(!$("enable-location-help").classList.contains("hidden"), "open after first tap");
      $("enable-location-btn").click();
      assert.ok($("enable-location-help").classList.contains("hidden"), "closed after second tap");
    });
    reset();
  });

  // ---- help text goes in as plain text, never markup ------------------

  test("enable-location: denied help text is set via textContent (no markup injected)", () => {
    reset();
    withGeo({ state: "denied", ios: false }, () => {
      S.render("denied");
      $("enable-location-btn").click();
      const help = $("enable-location-help");
      assert.equal(help.querySelector("*"), null, "no child elements, plain text only");
      assert.ok(help.textContent.length > 5, "text present");
    });
    reset();
  });
})();

/**
 * geo-dialog section — the pre-drive permission backstop (js/geo-dialog.js).
 *
 * KPR.geoDialog.open(onDone) shows #geo-dialog with body text for the current
 * permission state and ALWAYS runs onDone once the user responds (Allow, Not
 * now, Escape, backdrop). Allow calls KPR.map.requestLocation() only in
 * 'prompt'; in 'denied' the Allow button is hidden (no re-prompt). We drive it
 * through the same seams as the strip tests: stub KPR.geoPermission.getState/
 * isIOS and KPR.map on the objects, restoring each in a finally.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const D = KPR.geoDialog;

  D.init(); // wire the dialog listeners once, like the app does

  function closeIfOpen() {
    // Dismiss restores the real flow; call it only while open so onDone from a
    // test's own open() isn't double-counted by later resets.
    if (D.isOpen()) $("geo-dialog-dismiss").click();
    $("geo-dialog").classList.add("hidden");
  }

  // Stub KPR.geoPermission.getState / isIOS for a block, restoring after.
  function withGeo(opts, fn) {
    const g = KPR.geoPermission;
    const origGetState = g.getState;
    const origIsIOS = g.isIOS;
    if (opts.state !== undefined) g.getState = () => opts.state;
    if (opts.ios !== undefined) g.isIOS = () => opts.ios;
    try {
      return fn();
    } finally {
      g.getState = origGetState;
      g.isIOS = origIsIOS;
    }
  }

  // Stub KPR.map.requestLocation with a spy, restoring KPR.map after.
  function withMapSpy(fn) {
    const origMap = KPR.map;
    const spy = { calls: 0 };
    KPR.map = { requestLocation: () => { spy.calls++; return true; } };
    try {
      return fn(spy);
    } finally {
      KPR.map = origMap;
    }
  }

  // ---- open(): body text per state ------------------------------------

  test("geo-dialog: open() in 'prompt' shows the dialog, body explains Allow, Allow visible", () => {
    withGeo({ state: "prompt" }, () => {
      D.open(() => {});
      assert.ok(!$("geo-dialog").classList.contains("hidden"), "dialog shown");
      assert.ok(D.isOpen(), "isOpen true");
      assert.ok($("geo-dialog-body").textContent.indexOf("Allow") !== -1, "prompt body mentions Allow");
      assert.ok(!$("geo-dialog-allow").classList.contains("hidden"), "Allow button visible in prompt");
    });
    closeIfOpen();
  });

  test("geo-dialog: open() in 'denied' on iOS shows Safari steps and hides Allow", () => {
    withGeo({ state: "denied", ios: true }, () => {
      D.open(() => {});
      assert.ok(!$("geo-dialog").classList.contains("hidden"), "dialog shown");
      assert.ok($("geo-dialog-body").textContent.indexOf("Safari") !== -1, "iOS-specific steps");
      assert.ok($("geo-dialog-allow").classList.contains("hidden"), "Allow hidden when denied");
    });
    closeIfOpen();
  });

  test("geo-dialog: open() in 'denied' on a non-iOS device shows generic site-settings steps", () => {
    withGeo({ state: "denied", ios: false }, () => {
      D.open(() => {});
      const body = $("geo-dialog-body");
      assert.ok(body.textContent.toLowerCase().indexOf("site settings") !== -1, "generic site-settings steps");
      assert.ok(body.textContent.indexOf("Safari") === -1, "not the iOS text");
      assert.ok($("geo-dialog-allow").classList.contains("hidden"), "Allow hidden when denied");
    });
    closeIfOpen();
  });

  test("geo-dialog: body text is set via textContent (no markup injected)", () => {
    withGeo({ state: "denied", ios: false }, () => {
      D.open(() => {});
      assert.equal($("geo-dialog-body").querySelector("*"), null, "no child elements, plain text only");
    });
    closeIfOpen();
  });

  // ---- Allow / dismiss / Escape always invoke onDone ------------------

  test("geo-dialog: Allow in 'prompt' calls requestLocation, closes, and invokes onDone", () => {
    withMapSpy((spy) => {
      withGeo({ state: "prompt" }, () => {
        let done = 0;
        D.open(() => { done++; });
        $("geo-dialog-allow").click();
        assert.equal(spy.calls, 1, "requestLocation called once");
        assert.equal(done, 1, "onDone invoked");
        assert.ok(!D.isOpen(), "dialog closed");
        assert.ok($("geo-dialog").classList.contains("hidden"), "dialog hidden");
      });
    });
    closeIfOpen();
  });

  test("geo-dialog: Not now in 'prompt' invokes onDone WITHOUT calling requestLocation", () => {
    withMapSpy((spy) => {
      withGeo({ state: "prompt" }, () => {
        let done = 0;
        D.open(() => { done++; });
        $("geo-dialog-dismiss").click();
        assert.equal(spy.calls, 0, "requestLocation NOT called on dismiss");
        assert.equal(done, 1, "onDone invoked");
        assert.ok(!D.isOpen(), "dialog closed");
      });
    });
    closeIfOpen();
  });

  test("geo-dialog: Escape invokes onDone WITHOUT calling requestLocation", () => {
    withMapSpy((spy) => {
      withGeo({ state: "prompt" }, () => {
        let done = 0;
        D.open(() => { done++; });
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        assert.equal(spy.calls, 0, "requestLocation NOT called on Escape");
        assert.equal(done, 1, "onDone invoked");
        assert.ok(!D.isOpen(), "dialog closed");
      });
    });
    closeIfOpen();
  });

  test("geo-dialog: dismiss in 'denied' invokes onDone and never re-prompts", () => {
    withMapSpy((spy) => {
      withGeo({ state: "denied", ios: false }, () => {
        let done = 0;
        D.open(() => { done++; });
        $("geo-dialog-dismiss").click();
        assert.equal(spy.calls, 0, "requestLocation NOT called when denied");
        assert.equal(done, 1, "onDone invoked");
      });
    });
    closeIfOpen();
  });

  // ---- open() while open is a no-op -----------------------------------

  test("geo-dialog: open() while already open is a no-op (first onDone not replaced)", () => {
    withGeo({ state: "prompt" }, () => {
      let first = 0;
      let second = 0;
      D.open(() => { first++; });
      D.open(() => { second++; }); // ignored — dialog already open
      $("geo-dialog-dismiss").click();
      assert.equal(first, 1, "first onDone invoked once");
      assert.equal(second, 0, "second onDone never registered");
    });
    closeIfOpen();
  });
})();
