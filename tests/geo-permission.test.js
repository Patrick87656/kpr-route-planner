/**
 * geo-permission.test.js — the shared permission module (js/geo-permission.js).
 *
 * The harness runs in a real browser where navigator.permissions and
 * navigator.userAgent are real and read-only, so these tests drive the module
 * through STUBBED seams, mirroring how browse-routes.test.js stubs fetch:
 *
 *  - Permission state: we replace navigator.permissions with a fake whose
 *    query() resolves a fake PermissionStatus. The fake status has a settable
 *    `.state` and a real EventTarget-style addEventListener/dispatch for
 *    'change', so a test can flip the state and fire a 'change' the way the
 *    browser would when the user toggles location in site settings.
 *  - window.isSecureContext: file:// is already a secure context in the test
 *    runner, but we force it true while a permissions fake is installed and
 *    delete the fake (making the module see no Permissions API) to drive the
 *    'unsupported' path.
 *  - isIOS(): we stub navigator.userAgent / navigator.platform /
 *    navigator.maxTouchPoints via Object.defineProperty, then restore them.
 *
 * Each seam is installed around a single test and torn down in a finally so a
 * failure can't leak a stub into the rest of the suite.
 */
(function () {
  const G = KPR.geoPermission;

  // --- navigator.permissions fake ------------------------------------

  // A fake PermissionStatus: settable .state and a 'change' listener list.
  function fakeStatus(initial) {
    const listeners = [];
    return {
      state: initial,
      addEventListener(type, cb) {
        if (type === "change") listeners.push(cb);
      },
      removeEventListener(type, cb) {
        if (type !== "change") return;
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
      // Test helper: flip state and notify, like the browser does.
      _fireChange(next) {
        this.state = next;
        listeners.slice().forEach((cb) => cb({ type: "change" }));
      },
    };
  }

  // Install a fake navigator.permissions whose query() resolves `status`.
  // Returns a restore() that puts the real descriptor back.
  function installPermissions(status) {
    const navProto = Object.getPrototypeOf(navigator);
    const original = Object.getOwnPropertyDescriptor(navigator, "permissions") ||
      Object.getOwnPropertyDescriptor(navProto, "permissions");
    const secureOriginal = Object.getOwnPropertyDescriptor(window, "isSecureContext");

    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: () => Promise.resolve(status) },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    return function restore() {
      delete navigator.permissions;
      if (original) Object.defineProperty(navigator, "permissions", original);
      if (secureOriginal) Object.defineProperty(window, "isSecureContext", secureOriginal);
      else delete window.isSecureContext;
    };
  }

  // Install a navigator with no Permissions API (drives the 'unsupported'
  // path). Returns a restore().
  function installNoPermissions() {
    const navProto = Object.getPrototypeOf(navigator);
    const original = Object.getOwnPropertyDescriptor(navigator, "permissions") ||
      Object.getOwnPropertyDescriptor(navProto, "permissions");
    Object.defineProperty(navigator, "permissions", { configurable: true, value: undefined });
    return function restore() {
      delete navigator.permissions;
      if (original) Object.defineProperty(navigator, "permissions", original);
    };
  }

  // Stub navigator.userAgent / platform / maxTouchPoints for isIOS().
  function installUA(ua, platform, maxTouchPoints) {
    const keys = ["userAgent", "platform", "maxTouchPoints"];
    const navProto = Object.getPrototypeOf(navigator);
    const originals = keys.map((k) =>
      Object.getOwnPropertyDescriptor(navigator, k) ||
      Object.getOwnPropertyDescriptor(navProto, k)
    );
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: maxTouchPoints });
    return function restore() {
      keys.forEach((k, i) => {
        delete navigator[k];
        if (originals[i]) Object.defineProperty(navigator, k, originals[i]);
      });
    };
  }

  // --- getState / refresh --------------------------------------------

  test("geo-permission: exposes the documented API", () => {
    ["init", "getState", "refresh", "subscribe", "setRequester", "requestLocation", "isIOS"].forEach(
      (name) => assert.equal(typeof G[name], "function", name)
    );
  });

  test("geo-permission: refresh() reflects 'granted'", async () => {
    const restore = installPermissions(fakeStatus("granted"));
    try {
      const state = await G.refresh();
      assert.equal(state, "granted", "resolved state");
      assert.equal(G.getState(), "granted", "cached state");
    } finally {
      restore();
    }
  });

  test("geo-permission: refresh() reflects 'prompt'", async () => {
    const restore = installPermissions(fakeStatus("prompt"));
    try {
      await G.refresh();
      assert.equal(G.getState(), "prompt");
    } finally {
      restore();
    }
  });

  test("geo-permission: refresh() reflects 'denied'", async () => {
    const restore = installPermissions(fakeStatus("denied"));
    try {
      await G.refresh();
      assert.equal(G.getState(), "denied");
    } finally {
      restore();
    }
  });

  test("geo-permission: refresh() resolves 'unsupported' with no Permissions API", async () => {
    const restore = installNoPermissions();
    try {
      const state = await G.refresh();
      assert.equal(state, "unsupported");
      assert.equal(G.getState(), "unsupported");
    } finally {
      restore();
    }
  });

  // --- subscribe + live 'change' -------------------------------------

  test("geo-permission: a simulated 'change' re-reads state and notifies subscribers", async () => {
    const status = fakeStatus("prompt");
    const restore = installPermissions(status);
    const seen = [];
    let unsubscribe;
    try {
      unsubscribe = G.subscribe((s) => seen.push(s));
      G.init();
      // Let init()'s refresh() + listener-attach settle.
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(G.getState(), "prompt", "after init");

      status._fireChange("granted");
      assert.equal(G.getState(), "granted", "cache updated by change");
      assert.ok(seen.includes("granted"), "subscriber was notified of granted");

      status._fireChange("denied");
      assert.equal(G.getState(), "denied");
      assert.ok(seen.includes("denied"), "subscriber was notified of denied");
    } finally {
      if (unsubscribe) unsubscribe();
      restore();
    }
  });

  test("geo-permission: unsubscribe() stops further notifications", async () => {
    const status = fakeStatus("prompt");
    const restore = installPermissions(status);
    const seen = [];
    try {
      const unsubscribe = G.subscribe((s) => seen.push(s));
      await G.refresh(); // notifies -> 'prompt'
      unsubscribe();
      await G.refresh(); // must not notify the unsubscribed callback
      assert.equal(seen.length, 1, "only the pre-unsubscribe notification");
      assert.equal(seen[0], "prompt");
    } finally {
      restore();
    }
  });

  // --- requestLocation -----------------------------------------------

  test("geo-permission: requestLocation() calls the requester only in 'prompt'", async () => {
    const restore = installPermissions(fakeStatus("prompt"));
    let calls = 0;
    try {
      G.setRequester(() => { calls += 1; });
      await G.refresh();
      const fired = G.requestLocation();
      assert.equal(fired, true, "returned true");
      assert.equal(calls, 1, "requester called once");
    } finally {
      G.setRequester(null);
      restore();
    }
  });

  test("geo-permission: requestLocation() does NOT call the requester when 'denied'", async () => {
    const restore = installPermissions(fakeStatus("denied"));
    let calls = 0;
    try {
      G.setRequester(() => { calls += 1; });
      await G.refresh();
      const fired = G.requestLocation();
      assert.equal(fired, false, "returned false");
      assert.equal(calls, 0, "requester not called when denied");
    } finally {
      G.setRequester(null);
      restore();
    }
  });

  test("geo-permission: requestLocation() does NOT call the requester when 'unsupported'", async () => {
    const restore = installNoPermissions();
    let calls = 0;
    try {
      G.setRequester(() => { calls += 1; });
      await G.refresh(); // -> 'unsupported'
      const fired = G.requestLocation();
      assert.equal(fired, false, "returned false");
      assert.equal(calls, 0, "requester not called when unsupported");
    } finally {
      G.setRequester(null);
      restore();
    }
  });

  // --- isIOS ----------------------------------------------------------

  test("geo-permission: isIOS() true for an iPhone userAgent", () => {
    const restore = installUA(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      "iPhone",
      5
    );
    try {
      assert.equal(G.isIOS(), true);
    } finally {
      restore();
    }
  });

  test("geo-permission: isIOS() true for iPadOS reporting as MacIntel with touch", () => {
    const restore = installUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "MacIntel",
      5
    );
    try {
      assert.equal(G.isIOS(), true);
    } finally {
      restore();
    }
  });

  test("geo-permission: isIOS() false for a desktop Mac without touch", () => {
    const restore = installUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "MacIntel",
      0
    );
    try {
      assert.equal(G.isIOS(), false);
    } finally {
      restore();
    }
  });

  test("geo-permission: isIOS() false for a Windows desktop", () => {
    const restore = installUA(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Win32",
      0
    );
    try {
      assert.equal(G.isIOS(), false);
    } finally {
      restore();
    }
  });
})();
