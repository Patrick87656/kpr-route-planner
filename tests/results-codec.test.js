/**
 * results-codec.test.js — the vehicle list (`vh`) in route links and the
 * #res= results link in js/route-codec.js.
 *
 * Like codec.test.js, most of these are rejections: a results link is
 * attacker-controlled input, so every limit is checked at the cap (accepted)
 * and one past it (rejected), and garbage may only ever produce a LinkError.
 */
(function () {
  const C = KPR.codec;
  const L = C.LIMITS;

  // ---- helpers -------------------------------------------------------

  const utf8 = (text) => new TextEncoder().encode(text);

  function b64u(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const plainLink = (obj) => "p" + b64u(utf8(typeof obj === "string" ? obj : JSON.stringify(obj)));

  const clone = (o) => JSON.parse(JSON.stringify(o));

  const SCENE_A = ["NVH", "NVH", "Rough road", "Listen for rattles", 36.12, -115.12, 36.18, -115.18];
  const SCENE_B = ["Braking", "Braking", "Hard stop", "", 36.13, -115.13, 36.15, -115.15];

  function baseRoutePayload() {
    return {
      v: 1,
      n: "Test route",
      w: [
        [36.1, -115.1, "Start", "1 Main St"],
        [36.2, -115.2, "End", "2 Main St"],
      ],
      s: [SCENE_A.slice(), SCENE_B.slice()],
    };
  }

  function baseResults() {
    return { v: 1, r: baseRoutePayload(), veh: "Ariya #1", who: "Pat", t: 1700000000000, sim: 0, g: "gb" };
  }

  function appRoute(extra) {
    return Object.assign(
      {
        name: "Loop A",
        waypoints: [
          { lat: 36.1, lng: -115.1, name: "Start", detail: "1 Main St" },
          { lat: 36.2, lng: -115.2, name: "End", detail: "" },
        ],
        scenes: [
          { type: "NVH", typeLabel: "NVH", label: "Rough road", notes: "Listen", startLat: 36.12, startLng: -115.12, endLat: 36.18, endLng: -115.18 },
          { type: "Braking", typeLabel: "Braking", label: "Hard stop", notes: "", startLat: 36.13, startLng: -115.13, endLat: 36.15, endLng: -115.15 },
        ],
      },
      extra || {}
    );
  }

  function session(over) {
    return Object.assign(
      {
        id: "s1",
        routePayload: C.buildPayload(appRoute()),
        routeName: "Loop A",
        vehicle: "Ariya #1",
        evaluator: "Pat",
        startedAt: 1700000000000,
        simulated: false,
        ratings: [
          { sceneIndex: 0, rating: "good" },
          { sceneIndex: 1, rating: "bad" },
        ],
      },
      over || {}
    );
  }

  async function assertCode(promiseFn, code, label) {
    let error = null;
    try {
      await promiseFn();
    } catch (err) {
      error = err;
    }
    assert.ok(error, `${label || code}: expected rejection`);
    assert.ok(error instanceof C.LinkError, `${label || code}: expected a LinkError, got ${error}`);
    assert.equal(error.code, code, label || code);
  }

  function assertResRejected(label, mutate) {
    const p = baseResults();
    mutate(p);
    let error = null;
    try {
      C.validateResultsPayload(p);
    } catch (err) {
      error = err;
    }
    assert.ok(error, `${label}: expected rejection`);
    assert.ok(error instanceof C.LinkError, `${label}: expected a LinkError, got ${error}`);
    assert.equal(error.code, "bad-data", label);
  }

  function assertResAccepted(label, mutate) {
    const p = baseResults();
    mutate(p);
    try {
      return C.validateResultsPayload(p);
    } catch (err) {
      throw new Error(`${label}: expected acceptance, got ${err && err.code}`);
    }
  }

  function prng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- normalizeVehicles ---------------------------------------------

  test("vehicles: normalize table", () => {
    const N = C.normalizeVehicles;
    assert.deepEqual(N("  Ariya  \n Leaf "), ["Ariya", "Leaf"], "trim");
    assert.deepEqual(N("A\n\n  \n\t\nB"), ["A", "B"], "blank lines dropped");
    assert.deepEqual(N("Ariya\nARIYA\nariya\nLeaf"), ["Ariya", "Leaf"], "case-insensitive de-dup keeps the first spelling");
    assert.deepEqual(N("A\r\nB\rC\nD"), ["A", "B", "C", "D"], "CRLF, CR and LF all split");
    assert.deepEqual(N(["A", 5, null, undefined, {}, ["x"], true, "B"]), ["A", "B"], "non-strings dropped");
    assert.deepEqual(N("A\u0000B\u0007\u001fC"), ["ABC"], "control characters stripped");
    assert.deepEqual(N(["A\tB", "C\nD"]), ["AB", "CD"], "a name is one line even from an array");
    assert.deepEqual(N(""), []);
    assert.deepEqual(N("   \n  "), []);
    assert.deepEqual(N(null), []);
    assert.deepEqual(N(undefined), []);
    assert.deepEqual(N(42), []);
    assert.deepEqual(N({ 0: "A", length: 1 }), [], "array-likes are not arrays");
    assert.ok(Array.isArray(N("A")), "returns an array");
  });

  test("vehicles: 30 names are kept, the 31st is cut", () => {
    const names = Array.from({ length: 31 }, (_, i) => "Car " + i);
    assert.equal(C.normalizeVehicles(names.slice(0, 30)).length, 30);
    const cut = C.normalizeVehicles(names);
    assert.equal(cut.length, 30);
    assert.equal(cut[29], "Car 29");
    assert.equal(C.normalizeVehicles(names.join("\n")).length, 30, "string input too");
  });

  test("vehicles: 80 units are kept, 81 are cut", () => {
    assert.equal(C.normalizeVehicles("x".repeat(80))[0].length, 80);
    assert.equal(C.normalizeVehicles("x".repeat(81))[0].length, 80);
    assert.equal(C.normalizeVehicles("x".repeat(500))[0].length, 80);
  });

  test("vehicles: a cut never leaves half a surrogate pair", () => {
    // The emoji is 2 UTF-16 units; starting at unit 79 the pair straddles the cut.
    const name = "x".repeat(79) + "\uD83D\uDE97" + "tail";
    const out = C.normalizeVehicles(name)[0];
    assert.equal(out, "x".repeat(79), "the high surrogate is dropped with its pair");
    const last = out.charCodeAt(out.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no lone high surrogate");
    // A pair that fits whole is kept.
    assert.equal(C.normalizeVehicles("x".repeat(78) + "\uD83D\uDE97")[0].length, 80);
  });

  test("vehicles: a trailing space exposed by the cut is trimmed, and names that become equal de-dup", () => {
    const out = C.normalizeVehicles(["x".repeat(79) + " yyy", "x".repeat(79)]);
    assert.deepEqual(out, ["x".repeat(79)]);
  });

  // ---- vh in route links ---------------------------------------------

  test("vh: a route without vehicles keeps the exact old key sets", async () => {
    assert.deepEqual(Object.keys(C.buildPayload(appRoute())).sort(), ["n", "s", "v", "w"]);
    assert.deepEqual(Object.keys(C.buildPayload(appRoute({ vehicles: [] }))).sort(), ["n", "s", "v", "w"]);
    assert.deepEqual(Object.keys(C.buildPayload(appRoute({ vehicles: ["", "  "] }))).sort(), ["n", "s", "v", "w"]);
    const decoded = await C.decode(await C.encode(appRoute()));
    assert.deepEqual(Object.keys(decoded).sort(), ["name", "scenes", "waypoints"]);
    assert.deepEqual(Object.keys(C.validatePayload(baseRoutePayload())).sort(), ["name", "scenes", "waypoints"]);
  });

  test("vh: buildPayload writes vh after s, normalized, and keeps v at 1", () => {
    const p = C.buildPayload(appRoute({ vehicles: [" Ariya ", "ariya", "Leaf"] }));
    assert.deepEqual(Object.keys(p), ["v", "n", "w", "s", "vh"]);
    assert.deepEqual(p.vh, ["Ariya", "Leaf"]);
    assert.equal(p.v, 1);
  });

  test("vh: round trip in the deflate (d) and plain (p) markers", async () => {
    const route = appRoute({ vehicles: ["Ariya #1", "Leaf \u00e9\u4e2d", "Rogue"] });
    const d = await C.encode(route);
    assert.equal(d.charAt(0), "d");
    assert.deepEqual((await C.decode(d)).vehicles, ["Ariya #1", "Leaf \u00e9\u4e2d", "Rogue"]);
    const p = plainLink(C.buildPayload(route));
    assert.equal(p.charAt(0), "p");
    assert.deepEqual((await C.decode(p)).vehicles, ["Ariya #1", "Leaf \u00e9\u4e2d", "Rogue"]);
  });

  test("vh: old payloads without vh decode exactly as before", async () => {
    const route = await C.decode(plainLink(baseRoutePayload()));
    assert.deepEqual(Object.keys(route).sort(), ["name", "scenes", "waypoints"]);
    assert.equal(route.name, "Test route");
    assert.equal(route.scenes.length, 2);
  });

  test("vh: validation table", () => {
    const withVh = (vh) => {
      const p = baseRoutePayload();
      p.vh = vh;
      return p;
    };
    const rejected = (label, vh) => {
      let error = null;
      try {
        C.validatePayload(withVh(vh));
      } catch (err) {
        error = err;
      }
      assert.ok(error instanceof C.LinkError, `${label}: expected a LinkError`);
      assert.equal(error.code, "bad-data", label);
    };
    rejected("string", "Ariya");
    rejected("object", { 0: "Ariya" });
    rejected("number", 5);
    rejected("null", null);
    rejected("31 entries", Array.from({ length: 31 }, (_, i) => "C" + i));
    rejected("81 units", ["x".repeat(81)]);
    rejected("non-string entry", ["ok", 5]);
    rejected("null entry", ["ok", null]);
    rejected("control char", ["bad\u0001name"]);
    rejected("NUL", ["bad\u0000name"]);

    // Accepted edge: exactly 30 entries of exactly 80 units.
    const max = Array.from({ length: 30 }, (_, i) => String(i).padStart(2, "0") + "x".repeat(78));
    assert.equal(C.validatePayload(withVh(max)).vehicles.length, 30);
    // Blanks, repeats and whitespace are normalized away, not rejected.
    assert.deepEqual(C.validatePayload(withVh([" A ", "", "a", "  ", "B"])).vehicles, ["A", "B"]);
    // Empty / all-blank -> no 'vehicles' key at all.
    assert.equal(Object.prototype.hasOwnProperty.call(C.validatePayload(withVh([])), "vehicles"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(C.validatePayload(withVh(["", " "])), "vehicles"), false);
    // Absent -> no key.
    assert.equal(Object.prototype.hasOwnProperty.call(C.validatePayload(baseRoutePayload()), "vehicles"), false);
  });

  // ---- results: round trip -------------------------------------------

  test("results: round trip (deflate d) returns the documented shape", async () => {
    const encoded = await C.encodeResults(session());
    assert.equal(encoded.charAt(0), "d");
    assert.ok(/^[dp][A-Za-z0-9_-]*$/.test(encoded));
    const res = await C.decodeResults(encoded);
    assert.deepEqual(Object.keys(res).sort(), ["evaluator", "ratings", "route", "simulated", "startedAt", "vehicle"]);
    assert.equal(res.vehicle, "Ariya #1");
    assert.equal(res.evaluator, "Pat");
    assert.equal(res.startedAt, 1700000000000);
    assert.equal(res.simulated, false);
    assert.deepEqual(res.ratings, ["good", "bad"]);
    assert.equal(res.route.name, "Loop A");
    assert.equal(res.route.scenes.length, 2);
    assert.deepEqual(Object.keys(res.route).sort(), ["name", "scenes", "waypoints"]);
  });

  test("results: round trip in the plain (p) marker, with unrated scenes and sim=1", async () => {
    const payload = C.buildResultsPayload(session({ simulated: true, ratings: [{ sceneIndex: 1, rating: "good" }] }));
    assert.equal(payload.g, "-g");
    assert.equal(payload.sim, 1);
    const res = await C.decodeResults(plainLink(payload));
    assert.deepEqual(res.ratings, [null, "good"]);
    assert.equal(res.simulated, true);
  });

  test("results: a session with no vehicle or evaluator round-trips with blanks", async () => {
    const res = await C.decodeResults(await C.encodeResults(session({ vehicle: "", evaluator: "" })));
    assert.equal(res.vehicle, "");
    assert.equal(res.evaluator, "");
  });

  test("results: vehicles in the stored route snapshot are not carried into the link", async () => {
    const snap = C.buildPayload(appRoute({ vehicles: ["Ariya", "Leaf"] }));
    assert.ok(snap.vh);
    const payload = C.buildResultsPayload(session({ routePayload: snap }));
    assert.equal(payload.r.vh, undefined);
    const res = await C.decodeResults(await C.encodeResults(session({ routePayload: snap })));
    assert.equal(Object.prototype.hasOwnProperty.call(res.route, "vehicles"), false);
  });

  test("results: buildResultsPayload has exactly the documented keys and lengths", () => {
    const p = C.buildResultsPayload(session());
    assert.deepEqual(Object.keys(p).sort(), ["g", "r", "sim", "t", "veh", "who"].concat("v").sort());
    assert.equal(p.v, 1);
    assert.equal(p.g.length, p.r.s.length);
    assert.ok(/^[gb-]*$/.test(p.g));
  });

  test("results: encoding caps over-long vehicle / evaluator names instead of failing", () => {
    const p = C.buildResultsPayload(session({ vehicle: "v".repeat(500), evaluator: "e".repeat(500) }));
    assert.equal(p.veh.length, 80);
    assert.equal(p.who.length, 60);
  });

  test("results: encoding a session with a bad stored snapshot or time is bad-data", async () => {
    await assertCode(() => C.encodeResults(session({ routePayload: null })), "bad-data", "null snapshot");
    await assertCode(() => C.encodeResults(session({ routePayload: { v: 2 } })), "bad-data", "wrong snapshot version");
    const tampered = C.buildPayload(appRoute());
    tampered.w[0][0] = "lots";
    await assertCode(() => C.encodeResults(session({ routePayload: tampered })), "bad-data", "tampered coordinate");
    await assertCode(() => C.encodeResults(session({ startedAt: NaN })), "bad-data", "NaN time");
    await assertCode(() => C.encodeResults(session({ startedAt: -5 })), "bad-data", "negative time");
    await assertCode(() => C.encodeResults(null), "bad-data", "null session");
    await assertCode(() => C.encodeResults("x"), "bad-data", "string session");
  });

  // ---- results: validation table -------------------------------------

  test("results validation: the base payload is accepted", () => {
    const res = C.validateResultsPayload(baseResults());
    assert.deepEqual(res.ratings, ["good", "bad"]);
  });

  test("results validation: g length and characters", () => {
    assertResRejected("g one short", (p) => (p.g = "g"));
    assertResRejected("g one long", (p) => (p.g = "gbg"));
    assertResRejected("g empty for 2 scenes", (p) => (p.g = ""));
    assertResRejected("g uppercase G", (p) => (p.g = "Gb"));
    assertResRejected("g uppercase B", (p) => (p.g = "gB"));
    assertResRejected("g space", (p) => (p.g = "g "));
    assertResRejected("g zero", (p) => (p.g = "g0"));
    assertResRejected("g digit", (p) => (p.g = "g1"));
    assertResRejected("g newline", (p) => (p.g = "g\n"));
    assertResRejected("g number", (p) => (p.g = 12));
    assertResRejected("g array", (p) => (p.g = ["g", "b"]));
    assertResRejected("g missing", (p) => delete p.g);
    assertResRejected("g null", (p) => (p.g = null));
    assertResAccepted("g all dashes", (p) => (p.g = "--"));
    // A route with no scenes takes an empty g.
    const noScenes = assertResAccepted("no scenes, empty g", (p) => {
      p.r.s = [];
      p.g = "";
    });
    assert.deepEqual(noScenes.ratings, []);
    assertResRejected("no scenes but g not empty", (p) => {
      p.r.s = [];
      p.g = "g";
    });
    // s absent entirely counts as no scenes.
    assertResAccepted("s absent, empty g", (p) => {
      delete p.r.s;
      p.g = "";
    });
  });

  test("results validation: vehicle (veh) and evaluator (who)", () => {
    assertResAccepted("veh 80", (p) => (p.veh = "v".repeat(80)));
    assertResRejected("veh 81", (p) => (p.veh = "v".repeat(81)));
    assertResAccepted("who 60", (p) => (p.who = "w".repeat(60)));
    assertResRejected("who 61", (p) => (p.who = "w".repeat(61)));
    assertResAccepted("veh empty", (p) => (p.veh = ""));
    assertResRejected("veh missing", (p) => delete p.veh);
    assertResRejected("who missing", (p) => delete p.who);
    assertResRejected("veh number", (p) => (p.veh = 5));
    assertResRejected("who object", (p) => (p.who = {}));
    assertResRejected("veh control char", (p) => (p.veh = "a\u0001b"));
    assertResRejected("who control char", (p) => (p.who = "a\u0000b"));
  });

  test("results validation: sim must be exactly 0 or 1", () => {
    assertResAccepted("sim 0", (p) => (p.sim = 0));
    assertResAccepted("sim 1", (p) => (p.sim = 1));
    assertResRejected("sim 2", (p) => (p.sim = 2));
    assertResRejected("sim -1", (p) => (p.sim = -1));
    assertResRejected('sim "1"', (p) => (p.sim = "1"));
    assertResRejected("sim true", (p) => (p.sim = true));
    assertResRejected("sim false", (p) => (p.sim = false));
    assertResRejected("sim null", (p) => (p.sim = null));
    assertResRejected("sim 0.5", (p) => (p.sim = 0.5));
    assertResRejected("sim missing", (p) => delete p.sim);
    assert.equal(assertResAccepted("sim 1", (p) => (p.sim = 1)).simulated, true);
    assert.equal(assertResAccepted("sim 0", (p) => (p.sim = 0)).simulated, false);
  });

  test("results validation: t (drive start time)", () => {
    assertResAccepted("t 0", (p) => (p.t = 0));
    assertResAccepted("t max", (p) => (p.t = 4102444800000));
    assertResRejected("t max+1", (p) => (p.t = 4102444800001));
    assertResRejected("t negative", (p) => (p.t = -1));
    assertResRejected("t NaN", (p) => (p.t = NaN));
    assertResRejected("t Infinity", (p) => (p.t = Infinity));
    assertResRejected("t 1.5", (p) => (p.t = 1.5));
    assertResRejected("t string", (p) => (p.t = "1700000000000"));
    assertResRejected("t null", (p) => (p.t = null));
    assertResRejected("t missing", (p) => delete p.t);
    assertResRejected("t huge", (p) => (p.t = 1e300));
  });

  test("results validation: r (the route) reuses every route rule", () => {
    assertResRejected("r missing", (p) => delete p.r);
    assertResRejected("r null", (p) => (p.r = null));
    assertResRejected("r string", (p) => (p.r = "route"));
    assertResRejected("r array", (p) => (p.r = []));
    assertResRejected("r wrong version", (p) => (p.r.v = 2));
    assertResRejected("r no waypoints", (p) => (p.r.w = []));
    assertResRejected("r bad latitude", (p) => (p.r.w[0][0] = 91));
    assertResRejected("r bad scene type", (p) => (p.r.s[0][0] = "Nope"));
    assertResRejected("r short scene tuple", (p) => p.r.s[0].pop());
    assertResRejected("r control char in name", (p) => (p.r.n = "a\u0001b"));
    assertResRejected("r 101 scenes", (p) => {
      p.r.s = Array.from({ length: 101 }, () => SCENE_A.slice());
      p.g = "g".repeat(101);
    });
    assertResAccepted("r 100 scenes", (p) => {
      p.r.s = Array.from({ length: 100 }, () => SCENE_A.slice());
      p.g = "g".repeat(100);
    });
  });

  test("results validation: wrong top level", () => {
    assertResRejected("v 2", (p) => (p.v = 2));
    assertResRejected("v 0", (p) => (p.v = 0));
    assertResRejected('v "1"', (p) => (p.v = "1"));
    assertResRejected("v missing", (p) => delete p.v);
    [null, undefined, 5, "x", true, [], [1]].forEach((bad) => {
      let error = null;
      try {
        C.validateResultsPayload(bad);
      } catch (err) {
        error = err;
      }
      assert.ok(error instanceof C.LinkError, `top level ${JSON.stringify(bad)}`);
      assert.equal(error.code, "bad-data");
    });
  });

  test("results validation: unknown keys are dropped, not copied; __proto__ is harmless", () => {
    const res = assertResAccepted("extras", (p) => {
      p.extra = "boo";
      p.r.extra = 1;
      p.r.vh = ["Ariya"];
      p.constructor = { bad: 1 };
    });
    assert.deepEqual(Object.keys(res).sort(), ["evaluator", "ratings", "route", "simulated", "startedAt", "vehicle"]);
    assert.deepEqual(Object.keys(res.route).sort(), ["name", "scenes", "waypoints"]);
    assert.equal(res.extra, undefined);

    // JSON.parse makes "__proto__" an ordinary own key; it must go nowhere.
    const hostile = JSON.parse(JSON.stringify(baseResults()).replace(/^\{/, '{"__proto__":{"polluted":true},'));
    assert.ok(Object.prototype.hasOwnProperty.call(hostile, "__proto__"), "test setup: own __proto__ key");
    const out = C.validateResultsPayload(hostile);
    assert.equal(out.polluted, undefined);
    assert.equal(({}).polluted, undefined, "Object.prototype untouched");
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
  });

  test("results validation: returns fresh objects (no aliasing of the input)", () => {
    const p = baseResults();
    const res = C.validateResultsPayload(p);
    p.r.w[0][2] = "CHANGED";
    p.r.s[0][2] = "CHANGED";
    assert.equal(res.route.waypoints[0].name, "Start");
    assert.equal(res.route.scenes[0].label, "Rough road");
  });

  // ---- results: hash parsing and independence ------------------------

  test("results hash: #r= and #res= never match each other", () => {
    assert.equal(C.parseHash("#res=dABC"), null, "parseHash ignores #res=");
    assert.equal(C.parseResultsHash("#r=dABC"), null, "parseResultsHash ignores #r=");
    assert.equal(C.parseResultsHash("#res=dABC"), "dABC");
    assert.equal(C.parseHash("#r=dABC"), "dABC");
    [null, undefined, 5, "", "#", "#re", "#res", "#res?x", "res=dABC", "#RES=dABC", "#rez=dABC"].forEach((h) => {
      assert.equal(C.parseResultsHash(h), null, String(h));
    });
    assert.equal(C.RES_PREFIX, "#res=");
  });

  test("results hash: the whole-hash cap is exact (100000 ok, 100001 too-long)", async () => {
    assert.equal(C.parseResultsHash("#res=" + "A".repeat(L.MAX_HASH_CHARS - 5)).length, L.MAX_HASH_CHARS - 5);
    let error = null;
    try {
      C.parseResultsHash("#res=" + "A".repeat(L.MAX_HASH_CHARS - 4));
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof C.LinkError);
    assert.equal(error.code, "too-long");
    await assertCode(() => C.decodeResults("d" + "A".repeat(L.MAX_HASH_CHARS)), "too-long", "decodeResults of an oversized string");
  });

  test("results link: buildResultsLink puts the payload in the fragment", () => {
    const link = C.buildResultsLink("dABC", { origin: "https://example.test", pathname: "/app/" });
    assert.equal(link, "https://example.test/app/#res=dABC");
    assert.equal(C.parseResultsHash("#" + link.split("#")[1]), "dABC");
  });

  test("results: a route link body is not a results payload, and vice versa", async () => {
    const routeLink = await C.encode(appRoute());
    await assertCode(() => C.decodeResults(routeLink), "bad-data", "route payload as results");
    const resLink = await C.encodeResults(session());
    await assertCode(() => C.decode(resLink), "bad-data", "results payload as route");
  });

  test("results: decodeResults error codes for bad encodings", async () => {
    await assertCode(() => C.decodeResults(5), "not-link", "non-string");
    await assertCode(() => C.decodeResults(""), "bad-encoding", "empty");
    await assertCode(() => C.decodeResults("xABCD"), "bad-encoding", "unknown marker");
    await assertCode(() => C.decodeResults("pAB*D"), "bad-encoding", "bad charset");
    await assertCode(() => C.decodeResults("pA"), "bad-encoding", "length % 4 == 1 after the marker");
    await assertCode(() => C.decodeResults("p" + b64u(utf8("not json"))), "bad-data", "not JSON");
    await assertCode(() => C.decodeResults("p" + b64u(new Uint8Array([0xff, 0xfe, 0xfd]))), "bad-data", "invalid UTF-8");
  });

  test("results: a decompression bomb (10 MB of zeros) on a #res= body is rejected as too-big", async () => {
    const bomb = "d" + b64u(await deflate(new Uint8Array(10 * 1024 * 1024)));
    assert.ok(bomb.length < 60000, `the bomb link is small (${bomb.length} chars)`);
    const t0 = performance.now();
    await assertCode(() => C.decodeResults(bomb), "too-big", "bomb");
    assert.ok(performance.now() - t0 < 5000, "rejected quickly");
  });

  // ---- results: encode-side limits -----------------------------------

  function hugeSession(noteFor, label) {
    // 100 scenes (the maximum) with maximum-length notes.
    const scenes = [];
    for (let i = 0; i < 100; i++) {
      scenes.push({
        type: "NVH",
        typeLabel: "NVH",
        label: label(i),
        notes: noteFor(i),
        startLat: 36.1 + i * 0.0001,
        startLng: -115.1,
        endLat: 36.1 + i * 0.0001 + 0.00005,
        endLng: -115.1,
      });
    }
    const waypoints = Array.from({ length: 50 }, (_, i) => ({ lat: 36 + i * 0.001, lng: -115, name: "", detail: "" }));
    return session({
      routePayload: C.buildPayload({ name: "Big", waypoints, scenes }),
      ratings: [],
    });
  }

  test("results: a maximum-size route with multi-byte notes is too-big on encode (never another error)", async () => {
    // Two UTF-8 bytes per unit: 100 scenes x 2000 units is far over 256 KB.
    await assertCode(() => C.encodeResults(hugeSession(() => "\u00e9".repeat(2000), () => "L")), "too-big");
  });

  test("results: a route that fits in bytes but not in the hash is too-long on encode", async () => {
    const rand = prng(777);
    const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const text = (len) => {
      let s = "";
      for (let i = 0; i < len; i++) s += ALNUM[Math.floor(rand() * ALNUM.length)];
      return s;
    };
    // Random text barely compresses, so the base64 body passes 100000 chars
    // while the inflated JSON stays under 256 KB.
    await assertCode(() => C.encodeResults(hugeSession(() => text(2000), () => text(100))), "too-long");
  });

  test("results: a maximum-size route with short text still encodes and decodes", async () => {
    const big = hugeSession(() => "n", () => "L");
    big.ratings = [{ sceneIndex: 99, rating: "bad" }];
    const res = await C.decodeResults(await C.encodeResults(big));
    assert.equal(res.route.scenes.length, 100);
    assert.equal(res.ratings[99], "bad");
    assert.equal(res.ratings[0], null);
  });

  // ---- fuzz ----------------------------------------------------------

  test("fuzz: results links (garbage, truncated, corrupted) only ever throw LinkError", async () => {
    const rand = prng(4242);
    const alphabets = [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-+/=!@#$%^&*() \t\n<>\"'\\{}[]:;,.\u00e9\u4e2d",
    ];
    const good = await C.encodeResults(session());
    const inputs = [];
    for (let i = 0; i < 150; i++) {
      const alpha = alphabets[i % 2];
      const len = Math.floor(rand() * 200);
      let s = ["d", "p", "x", ""][Math.floor(rand() * 4)];
      for (let j = 0; j < len; j++) s += alpha[Math.floor(rand() * alpha.length)];
      inputs.push(s);
    }
    for (let i = 0; i < 60; i++) inputs.push(good.slice(0, Math.floor(rand() * good.length)));
    for (let i = 0; i < 60; i++) {
      const chars = good.split("");
      for (let k = 0; k < 3; k++) chars[Math.floor(rand() * chars.length)] = "A_-9zQ"[Math.floor(rand() * 6)];
      inputs.push(chars.join(""));
    }
    // Structurally valid JSON with the wrong shape.
    [null, 5, "x", [], {}, { v: 1 }, { v: 1, r: 5 }, { v: 1, r: baseRoutePayload() }, baseRoutePayload()].forEach((shape) => {
      inputs.push(plainLink(shape));
    });
    const other = [];
    for (const input of inputs) {
      try {
        await C.decodeResults(input);
      } catch (err) {
        if (!(err instanceof C.LinkError)) other.push(`${JSON.stringify(input).slice(0, 40)} -> ${err}`);
      }
    }
    assert.equal(other.length, 0, `non-LinkError failures: ${other.slice(0, 3).join(" | ")}`);
  });

  test("fuzz: validateResultsPayload only ever throws LinkError, for random mutations", () => {
    const rand = prng(99);
    const junk = [null, undefined, 0, 1, -1, 1.5, NaN, "", "g", "x".repeat(100), true, false, [], {}, [1], { a: 1 }, "\u0001"];
    const keys = ["v", "r", "veh", "who", "t", "sim", "g"];
    const other = [];
    for (let i = 0; i < 300; i++) {
      const p = baseResults();
      const n = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const key = keys[Math.floor(rand() * keys.length)];
        p[key] = junk[Math.floor(rand() * junk.length)];
      }
      try {
        C.validateResultsPayload(p);
      } catch (err) {
        if (!(err instanceof C.LinkError)) other.push(String(err));
      }
    }
    assert.equal(other.length, 0, `non-LinkError failures: ${other.slice(0, 3).join(" | ")}`);
  });
})();
