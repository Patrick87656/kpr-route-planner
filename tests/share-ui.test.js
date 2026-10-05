/**
 * share-ui.test.js — the Share dialog and the open-a-shared-route flow in
 * js/share.js, run against the dialog skeleton in tests/run.html with the
 * stops, scenes, map and loader stubbed (no Mapbox, no network).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const C = KPR.codec;

  const BAD = "That link doesn't look like a KPR route. Ask the sender to share it again.";

  const stops = (n) =>
    Array.from({ length: n }, (_, i) => ({ lat: 36.1 + i / 100, lng: -115.1 - i / 100, name: "Stop " + i, detail: "" }));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(cond, label) {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await sleep(10);
    }
    throw new Error("timed out waiting for " + label);
  }

  function setHash(hash) {
    history.replaceState(null, "", location.pathname + location.search + hash);
  }

  /**
   * Replace the pieces share.js talks to, run fn(ctx), then put everything
   * back. ctx records alerts/confirms/applyRoute calls.
   */
  async function withStubs(opts, fn) {
    opts = opts || {};
    const ctx = { alerts: [], confirms: [], applied: [], styleWaits: 0 };
    const saved = {
      alert: window.alert,
      confirm: window.confirm,
      count: KPR.waypoints.count,
      getSave: KPR.waypoints.getSaveData,
      sceneSave: KPR.scenes.getSaveData,
      apply: KPR.storage.applyRoute,
      map: KPR.map,
      consoleError: console.error,
    };
    window.alert = (m) => ctx.alerts.push(String(m));
    window.confirm = (m) => {
      ctx.confirms.push(String(m));
      return opts.confirm !== false;
    };
    console.error = () => {};
    KPR.waypoints.count = () => (opts.stops == null ? 0 : opts.stops);
    KPR.waypoints.getSaveData = () => stops(opts.stops == null ? 0 : opts.stops);
    KPR.scenes.getSaveData = () => opts.scenes || [];
    KPR.storage.applyRoute = async (route) => {
      ctx.applied.push(route);
      if (opts.applyThrows) throw new Error("boom");
      return opts.applyResult || { ok: true, scenesLoaded: 0, scenesSkipped: 0 };
    };
    KPR.map = {
      whenStyleReady: async () => {
        ctx.styleWaits++;
        return opts.styleReady !== false;
      },
    };
    $("route-status").textContent = "previous status";
    $("route-name").value = opts.routeName == null ? "" : opts.routeName;
    try {
      await fn(ctx);
    } finally {
      window.alert = saved.alert;
      window.confirm = saved.confirm;
      console.error = saved.consoleError;
      KPR.waypoints.count = saved.count;
      KPR.waypoints.getSaveData = saved.getSave;
      KPR.scenes.getSaveData = saved.sceneSave;
      KPR.storage.applyRoute = saved.apply;
      if (saved.map === undefined) delete KPR.map;
      else KPR.map = saved.map;
      setHash("");
      $("route-name").value = "";
      $("share-dialog").classList.add("hidden");
    }
  }

  async function validHash(name) {
    const encoded = await C.encode({
      name: name || "Shared",
      waypoints: [
        { lat: 36.1, lng: -115.1, name: "A", detail: "" },
        { lat: 36.2, lng: -115.2, name: "B", detail: "" },
      ],
      scenes: [
        { type: "NVH", typeLabel: "NVH", label: "L", notes: "N", startLat: 36.1, startLng: -115.1, endLat: 36.2, endLng: -115.2 },
      ],
    });
    return "#r=" + encoded;
  }

  // Wire the dialog once, like the app does.
  KPR.share.init();

  // ---- button ---------------------------------------------------------

  test("share: the Share button reflects the stop count", async () => {
    await withStubs({ stops: 1 }, async () => {
      KPR.share.syncButton();
      assert.equal($("share-route").getAttribute("aria-disabled"), "true");
      assert.ok($("share-route").title.includes("at least 2"));
    });
    await withStubs({ stops: 2 }, async () => {
      KPR.share.syncButton();
      assert.equal($("share-route").getAttribute("aria-disabled"), "false");
    });
  });

  test("share: with fewer than 2 stops the button explains instead of opening the dialog", async () => {
    await withStubs({ stops: 1 }, async (ctx) => {
      $("share-route").click();
      await sleep(30);
      assert.deepEqual(ctx.alerts, ["Add at least 2 stops to share a route."]);
      assert.ok($("share-dialog").classList.contains("hidden"), "dialog stays closed");
    });
  });

  // ---- dialog ---------------------------------------------------------

  test("share: the dialog shows a QR code and the link", async () => {
    await withStubs({ stops: 2, routeName: "My route" }, async () => {
      $("share-route").click();
      await until(() => !$("share-copy").disabled, "the link");
      assert.ok(!$("share-dialog").classList.contains("hidden"), "dialog open");
      const link = $("share-link").value;
      assert.ok(link.includes("#r="), "link has a fragment payload");
      assert.ok(!link.includes("?"), "no query string");
      assert.ok(/#r=[dp][A-Za-z0-9_-]+$/.test(link), "link format");
      assert.ok($("share-link").readOnly, "link field is read-only");
      assert.ok($("share-qr").width >= 480, "QR canvas is at least 480 px: " + $("share-qr").width);
      assert.ok(!$("share-qr-wrap").classList.contains("hidden"), "QR visible");
      assert.ok($("share-qr-fallback").classList.contains("hidden"), "fallback hidden");
      assert.equal(
        !$("share-send").classList.contains("hidden"),
        typeof navigator.share === "function",
        "Send… only where navigator.share exists"
      );
      // The link round-trips to the route that was shared.
      const route = await C.decode(link.slice(link.indexOf("#r=") + 3));
      assert.equal(route.name, "My route");
      assert.equal(route.waypoints.length, 2);
    });
  });

  test("share: Escape and the Close button close the dialog", async () => {
    await withStubs({ stops: 2 }, async () => {
      $("share-route").click();
      await until(() => !$("share-copy").disabled, "the link");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      assert.ok($("share-dialog").classList.contains("hidden"), "Escape closes");
      $("share-route").click();
      await until(() => !$("share-copy").disabled, "the link again");
      $("share-close").click();
      assert.ok($("share-dialog").classList.contains("hidden"), "Close closes");
    });
  });

  test("share: a long link shows the hint; a route too big for a link hides the link", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      type: "NVH",
      typeLabel: "NVH",
      label: "Scene " + i + " " + "variation ".repeat(5) + i * 7919,
      notes: Array.from({ length: 30 }, (_, k) => "note" + ((i * 31 + k * 17) % 997)).join(" "),
      startLat: 36 + i / 1000,
      startLng: -115 - i / 1000,
      endLat: 36.5 + i / 1000,
      endLng: -115.5 - i / 1000,
    }));
    await withStubs({ stops: 2, scenes: many }, async () => {
      $("share-route").click();
      await until(() => !$("share-copy").disabled, "the long link");
      assert.ok($("share-link").value.length > 2000, "link is long: " + $("share-link").value.length);
      assert.ok(!$("share-long-hint").classList.contains("hidden"), "long-link hint shown");
      assert.ok($("share-long-hint").textContent.includes("Save"), "hint points to Save");
      $("share-close").click();
    });

    await withStubs({ stops: 51 }, async () => {
      $("share-route").click();
      await until(() => $("share-status").textContent !== "", "the too-big message");
      assert.ok($("share-status").textContent.includes("too big"), $("share-status").textContent);
      assert.ok($("share-status").textContent.includes("Save"), "points to Save");
      assert.ok($("share-qr-wrap").classList.contains("hidden"), "QR hidden");
      assert.ok($("share-link").parentElement.classList.contains("hidden"), "link hidden");
      assert.ok($("share-copy").disabled, "Copy disabled");
    });
  });

  test("share: a link too long for any QR code shows the fallback text instead", async () => {
    const realBuild = KPR.share.buildQr;
    // Drive the real dialog with a route whose link cannot fit a QR: shrink
    // the QR library's view of it by using an over-capacity scene set.
    const rand = (() => {
      let a = 5;
      return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
    })();
    const text = (n) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)]).join("");
    const scenes = Array.from({ length: 20 }, (_, i) => ({
      type: "NVH",
      typeLabel: "NVH",
      label: text(60),
      notes: text(300),
      startLat: 36 + i / 100,
      startLng: -115,
      endLat: 36.5,
      endLng: -115.5,
    }));
    await withStubs({ stops: 2, scenes }, async () => {
      $("share-route").click();
      await until(() => !$("share-copy").disabled, "the link");
      assert.ok($("share-link").value.length > 2953, "link longer than any QR can hold: " + $("share-link").value.length);
      assert.ok($("share-qr-wrap").classList.contains("hidden"), "QR hidden");
      assert.ok(!$("share-qr-fallback").classList.contains("hidden"), "fallback text shown");
      assert.ok($("share-link").value.length > 0, "the link is still there to copy");
      assert.equal(KPR.share.buildQr, realBuild);
    });
  });

  test("share: Copy link copies the link and says so", async () => {
    await withStubs({ stops: 2 }, async () => {
      let copied = null;
      const own = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t) => { copied = t; } },
      });
      try {
        $("share-route").click();
        await until(() => !$("share-copy").disabled, "the link");
        $("share-copy").click();
        await until(() => $("share-status").textContent !== "", "the copy status");
        if (window.isSecureContext) {
          assert.equal(copied, $("share-link").value);
          assert.equal($("share-status").textContent, "Link copied");
        } else {
          // Insecure page: the async clipboard API is not used; one of the
          // fallbacks reported a result instead.
          assert.equal(copied, null);
          assert.ok(["Link copied", "Press and hold the link to copy it"].includes($("share-status").textContent));
        }
      } finally {
        if (own) Object.defineProperty(navigator, "clipboard", own);
        else delete navigator.clipboard;
      }
    });
  });

  // ---- opening a shared link -----------------------------------------

  test("open: a hash that is not a share link is ignored", async () => {
    await withStubs({}, async (ctx) => {
      setHash("#something-else");
      await KPR.share.loadFromHash();
      assert.equal(ctx.applied.length, 0);
      assert.equal(ctx.alerts.length, 0);
      assert.equal(location.hash, "#something-else", "hash left alone");
    });
  });

  test("open: a valid link loads through applyRoute and the hash is removed", async () => {
    await withStubs({}, async (ctx) => {
      setHash(await validHash("From a friend"));
      await KPR.share.loadFromHash();
      assert.equal(ctx.applied.length, 1);
      assert.equal(ctx.applied[0].name, "From a friend");
      assert.equal(ctx.applied[0].waypoints.length, 2);
      assert.equal(ctx.applied[0].scenes.length, 1);
      assert.equal(ctx.confirms.length, 0, "no prompt when the map is empty");
      assert.equal(ctx.alerts.length, 0);
      assert.equal(ctx.styleWaits, 1, "waited for the map style");
      assert.equal(location.hash, "", "hash removed");
      assert.ok(!location.search, "no query string left behind");
    });
  });

  test("open: existing stops ask first; declining keeps them and still removes the hash", async () => {
    await withStubs({ stops: 3, confirm: false }, async (ctx) => {
      setHash(await validHash());
      await KPR.share.loadFromHash();
      assert.equal(ctx.confirms.length, 1);
      assert.ok(ctx.confirms[0].includes("replace"), ctx.confirms[0]);
      assert.equal(ctx.applied.length, 0, "nothing loaded");
      assert.equal(location.hash, "");
      assert.equal($("route-status").textContent, "previous status", "status put back");
    });
    await withStubs({ stops: 3, confirm: true }, async (ctx) => {
      setHash(await validHash());
      await KPR.share.loadFromHash();
      assert.equal(ctx.confirms.length, 1);
      assert.equal(ctx.applied.length, 1, "accepted -> loaded");
    });
  });

  test("open: a bad link shows only the friendly message and loads nothing", async () => {
    const bad = ["#r=", "#r=dAAAA", "#r=p!!!", "#r=x123", "#r=pAAAA", "#r=d" + "A".repeat(150000)];
    for (const hash of bad) {
      await withStubs({ stops: 2 }, async (ctx) => {
        setHash(hash);
        await KPR.share.loadFromHash();
        assert.deepEqual(ctx.alerts, [BAD], "message for " + hash.slice(0, 12));
        assert.equal(ctx.applied.length, 0);
        assert.equal(ctx.confirms.length, 0, "no replace prompt for junk");
        assert.equal(location.hash, "", "hash removed");
        assert.equal($("route-status").textContent, "previous status");
      });
    }
  });

  test("open: a link edited mid-string is rejected", async () => {
    const good = await validHash();
    const mid = Math.floor(good.length / 2);
    const edited = good.slice(0, mid) + "_-_-" + good.slice(mid + 4);
    await withStubs({}, async (ctx) => {
      setHash(edited);
      await KPR.share.loadFromHash();
      assert.equal(ctx.applied.length, 0);
      assert.equal(ctx.alerts.length, 1);
      assert.equal(ctx.alerts[0], BAD);
    });
  });

  test("open: map style never ready, route not calculated, skipped scenes, and loader errors are all reported", async () => {
    await withStubs({ styleReady: false }, async (ctx) => {
      setHash(await validHash());
      await KPR.share.loadFromHash();
      assert.equal(ctx.applied.length, 0);
      assert.ok(ctx.alerts[0].includes("map is still loading"), ctx.alerts[0]);
      assert.equal(location.hash, "");
    });
    await withStubs({ applyResult: { ok: false, reason: "route" } }, async (ctx) => {
      setHash(await validHash());
      await KPR.share.loadFromHash();
      assert.ok(ctx.alerts[0].includes("couldn't be calculated"), ctx.alerts[0]);
      assert.equal(location.hash, "");
    });
    await withStubs({ applyResult: { ok: true, scenesLoaded: 1, scenesSkipped: 2 } }, async (ctx) => {
      setHash(await validHash());
      await KPR.share.loadFromHash();
      assert.ok(ctx.alerts[0].startsWith("2 scenes"), ctx.alerts[0]);
    });
    await withStubs({ applyThrows: true }, async (ctx) => {
      setHash(await validHash());
      await KPR.share.loadFromHash();
      assert.equal(ctx.alerts.length, 1);
      assert.equal(location.hash, "");
      // The re-entrancy guard was released: a second link still loads.
      setHash(await validHash());
      await KPR.share.loadFromHash();
      assert.equal(ctx.applied.length, 2);
    });
  });

  test("open: without DecompressionStream a deflate link gets the 'try another browser' message", async () => {
    const hash = await validHash();
    const real = window.DecompressionStream;
    await withStubs({}, async (ctx) => {
      window.DecompressionStream = undefined;
      try {
        setHash(hash);
        await KPR.share.loadFromHash();
      } finally {
        window.DecompressionStream = real;
      }
      assert.equal(ctx.applied.length, 0);
      assert.ok(ctx.alerts[0].includes("Safari or Chrome"), ctx.alerts[0]);
    });
  });

  test("open: changing the hash in the same tab opens the new link", async () => {
    const hash = await validHash("Pasted later");
    await withStubs({}, async (ctx) => {
      location.hash = hash; // fires 'hashchange', which share.init() listens for
      await until(() => ctx.applied.length === 1, "the hashchange handler");
      assert.equal(ctx.applied[0].name, "Pasted later");
      await until(() => location.hash === "", "the hash to be removed");
    });
  });
})();
