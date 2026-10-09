/**
 * send-results.test.js — KPR.evaluation.prepareLink / sendResults and the
 * planner's "Last drive results" card. navigator.share, the clipboard copy,
 * confirm() and localStorage are all stubbed; nothing leaves the page.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const E = KPR.evaluation;
  const R = KPR.ratings;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fakeStorage() {
    const data = new Map();
    return {
      data,
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => void data.set(k, String(v)),
      removeItem: (k) => void data.delete(k),
    };
  }

  function appRoute(name) {
    return {
      name: name || "Loop A",
      waypoints: [
        { lat: 36.1, lng: -115.1, name: "Start", detail: "" },
        { lat: 36.2, lng: -115.2, name: "End", detail: "" },
      ],
      scenes: [
        { type: "NVH", typeLabel: "NVH", label: "One", notes: "", startLat: 36.12, startLng: -115.12, endLat: 36.14, endLng: -115.14 },
        { type: "Braking", typeLabel: "Braking", label: "Two", notes: "", startLat: 36.15, startLng: -115.15, endLat: 36.18, endLng: -115.18 },
      ],
    };
  }

  let clock = 1700000000000;
  /** A stored session with scene 0 rated good and scene 1 rated bad. */
  function makeSession(extra) {
    clock += 1000;
    const s = R.startSession(
      Object.assign(
        {
          routeFingerprint: "fp" + clock,
          routeName: "Loop A",
          vehicle: "Ariya #1",
          evaluator: "Pat",
          routePayload: KPR.codec.buildPayload(appRoute()),
          now: clock,
        },
        extra
      )
    );
    R.rate(s.id, 0, "good", { label: "One", type: "NVH", lat: 36.13, lng: -115.13, at: clock });
    R.rate(s.id, 1, "bad", { label: "Two", type: "Braking", lat: 36.16, lng: -115.16, at: clock });
    R.endSession(s.id, clock + 500); // a finished drive, as the planner card sees it
    return R.getSession(s.id);
  }

  /** Run fn with a fake storage behind KPR.ratings, the beta switch on, and
   * navigator.share / KPR.share.copyText / confirm / buildResultsLink
   * restored afterwards. */
  async function withEnv(fn) {
    const store = fakeStorage();
    R.useStorage(store);
    const realCopy = KPR.share.copyText;
    const realConfirm = window.confirm;
    const realBuild = KPR.codec.buildResultsLink;
    const hadShare = Object.prototype.hasOwnProperty.call(navigator, "share");
    const shareDesc = hadShare ? Object.getOwnPropertyDescriptor(navigator, "share") : null;
    try {
      await fn(store);
    } finally {
      if (hadShare) Object.defineProperty(navigator, "share", shareDesc);
      else delete navigator.share;
      KPR.share.copyText = realCopy;
      window.confirm = realConfirm;
      KPR.codec.buildResultsLink = realBuild;
      R.useStorage(null);
      $("send-dialog").classList.add("hidden");
      E.isSendDialogOpen() && document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      $("last-results").classList.add("hidden");
      $("last-results-summary").replaceChildren();
      $("last-results-status").textContent = "";
    }
  }

  function setShare(fn) {
    Object.defineProperty(navigator, "share", { configurable: true, writable: true, value: fn });
  }
  function noShare() {
    Object.defineProperty(navigator, "share", { configurable: true, writable: true, value: undefined });
  }
  const dialogOpen = () => !$("send-dialog").classList.contains("hidden");
  const errNamed = (name) => Object.assign(new Error(name), { name });

  // ---- the link ------------------------------------------------------

  test("send: the link decodes and the ratings match the taps", async () => {
    await withEnv(async () => {
      const s = makeSession();
      const { link, length } = await E.prepareLink(s);
      assert.equal(length, link.length);
      const hash = link.slice(link.indexOf("#"));
      const data = await KPR.codec.decodeResults(KPR.codec.parseResultsHash(hash));
      assert.deepEqual(data.ratings, ["good", "bad"]);
      assert.equal(data.vehicle, "Ariya #1");
      assert.equal(data.route.scenes.length, 2);
    });
  });

  test("send: the link is reused until a rating changes, then rebuilt", async () => {
    await withEnv(async () => {
      const s = makeSession();
      const a = await E.prepareLink(s);
      const b = await E.prepareLink(R.getSession(s.id));
      assert.ok(a === b, "same cached result");
      R.rate(s.id, 0, "bad", { label: "One", type: "NVH", lat: 36.13, lng: -115.13, at: clock + 5 });
      const c = await E.prepareLink(R.getSession(s.id));
      assert.ok(c !== a, "cache invalidated by the new rating");
      assert.ok(c.link !== a.link, "link changed");
      const data = await KPR.codec.decodeResults(KPR.codec.parseResultsHash(c.link.slice(c.link.indexOf("#"))));
      assert.deepEqual(data.ratings, ["bad", "bad"]);
    });
  });

  // ---- share sheet ---------------------------------------------------

  test("send: warm cache calls navigator.share synchronously with the specified payload", async () => {
    await withEnv(async () => {
      const s = makeSession();
      const warm = await E.prepareLink(s);
      const calls = [];
      setShare((arg) => {
        calls.push(arg);
        return Promise.resolve();
      });
      const status = $("last-results-status");
      const p = E.sendResults(s, status); // no await: the call must already have happened
      assert.equal(calls.length, 1, "share called before any await");
      assert.deepEqual(Object.keys(calls[0]).sort(), ["text", "title", "url"]);
      assert.equal(calls[0].title, "KPR results - Ariya #1 - Loop A");
      assert.equal(calls[0].text, "KPR evaluation results. Open on a PC to see the route and ratings.");
      assert.equal(calls[0].url, warm.link);
      await p;
      assert.equal(calls.length, 1, "called once");
      assert.ok(!dialogOpen(), "no dialog on success");
      assert.ok(status.textContent.includes(`Link length: ${warm.length} characters`), status.textContent);
    });
  });

  test("send: a blank vehicle is left out of the title", async () => {
    await withEnv(async () => {
      const s = makeSession({ vehicle: "" });
      await E.prepareLink(s);
      let title = null;
      setShare((arg) => {
        title = arg.title;
        return Promise.resolve();
      });
      await E.sendResults(s, $("last-results-status"));
      assert.equal(title, "KPR results - Loop A");
    });
  });

  test("send: each title part is cut at 80 characters", async () => {
    await withEnv(async () => {
      const s = makeSession({ vehicle: "V".repeat(80), routeName: "R".repeat(80) });
      await E.prepareLink(s);
      let title = null;
      setShare((arg) => {
        title = arg.title;
        return Promise.resolve();
      });
      await E.sendResults(s, $("last-results-status"));
      assert.equal(title, `KPR results - ${"V".repeat(80)} - ${"R".repeat(80)}`);
    });
  });

  test("send: AbortError is ignored silently", async () => {
    await withEnv(async () => {
      const s = makeSession();
      await E.prepareLink(s);
      setShare(() => Promise.reject(errNamed("AbortError")));
      await E.sendResults(s, $("last-results-status"));
      assert.ok(!dialogOpen(), "no dialog after the user closed the sheet");
    });
  });

  test("send: a share failure opens the dialog with the link", async () => {
    await withEnv(async () => {
      const s = makeSession();
      const warm = await E.prepareLink(s);
      setShare(() => Promise.reject(errNamed("NotAllowedError")));
      await E.sendResults(s, $("last-results-status"));
      assert.ok(dialogOpen(), "dialog opened");
      assert.equal($("send-link").value, warm.link);
    });
  });

  test("send: a cold cache builds first; NotAllowedError then opens the dialog", async () => {
    await withEnv(async () => {
      const s = makeSession({ vehicle: "Cold " + Date.now() });
      setShare(() => Promise.reject(errNamed("NotAllowedError")));
      await E.sendResults(s, $("last-results-status"));
      assert.ok(dialogOpen(), "dialog opened so a second tap can copy");
      assert.ok($("send-link").value.includes("#res="));
    });
  });

  test("send: a share that throws synchronously opens the dialog", async () => {
    await withEnv(async () => {
      const s = makeSession();
      await E.prepareLink(s);
      setShare(() => {
        throw errNamed("TypeError");
      });
      await E.sendResults(s, $("last-results-status"));
      assert.ok(dialogOpen());
    });
  });

  // ---- no share sheet ------------------------------------------------

  test("send: without navigator.share the link is copied and the message says so", async () => {
    await withEnv(async () => {
      const s = makeSession();
      const warm = await E.prepareLink(s);
      noShare();
      let copied = null;
      KPR.share.copyText = async (t) => {
        copied = t;
        return true;
      };
      const status = $("last-results-status");
      await E.sendResults(s, status);
      assert.equal(copied, warm.link);
      assert.ok(status.textContent.includes("Link copied. Paste it into Teams or an email."), status.textContent);
      assert.ok(!dialogOpen());
    });
  });

  test("send: when copying fails too, the dialog shows the link", async () => {
    await withEnv(async () => {
      const s = makeSession();
      const warm = await E.prepareLink(s);
      noShare();
      KPR.share.copyText = async () => false;
      await E.sendResults(s, $("last-results-status"));
      assert.ok(dialogOpen());
      assert.equal($("send-link").value, warm.link);
      assert.ok($("send-status").textContent.includes("Press and hold the link to copy it"), $("send-status").textContent);
    });
  });

  test("send: the dialog's Copy button copies, Escape closes it", async () => {
    await withEnv(async () => {
      const s = makeSession();
      await E.prepareLink(s);
      noShare();
      KPR.share.copyText = async () => false;
      await E.sendResults(s, $("last-results-status"));
      KPR.share.copyText = async () => true;
      $("send-copy").click();
      await sleep(20);
      assert.ok($("send-status").textContent.includes("Link copied"), $("send-status").textContent);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      assert.ok(!dialogOpen(), "Escape closes");
    });
  });

  // ---- link length ---------------------------------------------------

  test("send: the hint shows above 2000 characters and not at exactly 2000", async () => {
    await withEnv(async () => {
      noShare();
      KPR.share.copyText = async () => true;
      let n = 2000;
      KPR.codec.buildResultsLink = () => "h".repeat(n);
      const a = makeSession({ vehicle: "Len A" });
      const st = $("last-results-status");
      await E.sendResults(a, st);
      assert.ok(st.textContent.includes("Link length: 2000 characters"), st.textContent);
      assert.ok(!st.textContent.includes(KPR.share.longLinkHint), "no hint at exactly 2000");

      n = 2001;
      const b = makeSession({ vehicle: "Len B" });
      await E.sendResults(b, st);
      assert.ok(st.textContent.includes("Link length: 2001 characters"), st.textContent);
      assert.ok(st.textContent.includes(KPR.share.longLinkHint), "hint above 2000");
    });
  });

  test("send: a link that cannot be built shows a friendly message, nothing is shared", async () => {
    await withEnv(async () => {
      const s = makeSession({ vehicle: "Big" });
      let shared = 0;
      setShare(() => {
        shared++;
        return Promise.resolve();
      });
      const real = KPR.codec.encodeResults;
      KPR.codec.encodeResults = () => Promise.reject(new KPR.codec.LinkError("too-big"));
      try {
        const st = $("last-results-status");
        await E.sendResults(s, st);
        assert.equal(st.textContent, "These results are too big to send as a link.");
        KPR.codec.encodeResults = () => Promise.reject(new KPR.codec.LinkError("bad-data"));
        const s2 = makeSession({ vehicle: "Bad" });
        await E.sendResults(s2, st);
        assert.equal(st.textContent, "Could not build the results link.");
      } finally {
        KPR.codec.encodeResults = real;
      }
      assert.equal(shared, 0);
    });
  });

  // ---- Last drive results card ---------------------------------------

  function allElements(root) {
    return [root, ...root.querySelectorAll("*")];
  }
  const HOSTILE = [
    '<img src=x onerror="window.__pwned=1">',
    '"><script>window.__pwned=1</script>',
    "<svg onload=window.__pwned=1>",
  ];

  test("last results: hostile vehicle and route names stay text; TEST tag for a simulated drive", () => {
    HOSTILE.forEach((h) => {
      const box = document.createElement("div");
      E.renderLastResults(box, {
        vehicle: h,
        routeName: h,
        startedAt: 1700000000000,
        simulated: true,
        routePayload: { s: [1, 2] },
        ratings: [{ sceneIndex: 0, rating: "good" }],
      });
      assert.equal(box.querySelectorAll("img, script, iframe, object, embed, svg, style, link").length, 0, "injected element");
      allElements(box).forEach((el) => {
        Array.from(el.attributes).forEach((a) => assert.ok(!/^on/i.test(a.name), "attribute " + a.name));
      });
      assert.equal(box.querySelector(".lr-vehicle").firstChild.textContent, h);
      assert.equal(box.querySelector(".lr-route").textContent, h);
      assert.equal(box.querySelector(".lr-test").textContent, "TEST");
      assert.equal(box.querySelector(".lr-counts").textContent, "1 good, 0 bad, 1 not rated");
      assert.equal(window.__pwned, undefined, "injected script ran");
    });
  });

  test("last results: a real drive has no TEST tag; a blank vehicle reads 'No vehicle'", () => {
    const box = document.createElement("div");
    E.renderLastResults(box, {
      vehicle: "",
      routeName: "Loop A",
      startedAt: 1700000000000,
      simulated: false,
      routePayload: { s: [1, 2] },
      ratings: [],
    });
    assert.equal(box.querySelector(".lr-test"), null);
    assert.equal(box.querySelector(".lr-vehicle").textContent, "No vehicle");
    assert.ok(box.querySelector(".lr-date").textContent.length > 0, "date shown");
  });

  test("last results: the card appears from stored data (as after a reload)", async () => {
    await withEnv(async () => {
      makeSession({ vehicle: "Stored car" });
      E.refreshLastResults();
      assert.ok(!$("last-results").classList.contains("hidden"), "shown");
      assert.ok($("last-results-summary").textContent.includes("Stored car"));
      assert.ok($("last-results-summary").textContent.includes("1 good, 1 bad, 0 not rated"));
    });
  });

  test("last results: the card is hidden when no stored drive has ratings", async () => {
    await withEnv(async () => {
      E.refreshLastResults();
      assert.ok($("last-results").classList.contains("hidden"));
    });
  });

  test("last results: Send goes through the share sheet; Delete respects confirm(false) and confirm(true)", async () => {
    await withEnv(async () => {
      E.init();
      const s = makeSession({ vehicle: "Del car" });
      E.refreshLastResults();
      await E.prepareLink(s);

      const shares = [];
      setShare((arg) => {
        shares.push(arg);
        return Promise.resolve();
      });
      $("last-results-send").click();
      assert.equal(shares.length, 1, "Send shares synchronously from the click");
      assert.ok(shares[0].title.includes("Del car"));
      await sleep(20);

      let asked = null;
      window.confirm = (msg) => {
        asked = msg;
        return false;
      };
      $("last-results-delete").click();
      assert.equal(asked, "Delete these results from this device?");
      assert.ok(R.getSession(s.id), "kept after Cancel");
      assert.ok(!$("last-results").classList.contains("hidden"));

      window.confirm = () => true;
      $("last-results-delete").click();
      assert.equal(R.getSession(s.id), null, "deleted after OK");
      assert.ok($("last-results").classList.contains("hidden"), "card hides once nothing is left");
    });
  });
})();
