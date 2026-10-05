/**
 * codec.test.js — share-link codec (js/route-codec.js) and the QR helper.
 *
 * A shared link is attacker-controlled input, so most of these tests are
 * rejections: every limit is checked at the cap (accepted) and one past it
 * (rejected), and garbage input may only ever produce a LinkError.
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
  async function deflatedLink(obj) {
    return "d" + b64u(await deflate(utf8(typeof obj === "string" ? obj : JSON.stringify(obj))));
  }

  function basePayload() {
    return {
      v: 1,
      n: "Test route",
      w: [
        [36.1, -115.1, "Start", "1 Main St"],
        [36.2, -115.2, "End", "2 Main St"],
      ],
      s: [["NVH", "NVH", "Rough road", "Listen for rattles", 36.12, -115.12, 36.18, -115.18]],
    };
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  /** Mutate a copy of the base payload, then expect validatePayload to reject it. */
  function assertRejected(label, mutate) {
    const p = clone(basePayload());
    mutate(p);
    let error = null;
    try {
      C.validatePayload(p);
    } catch (err) {
      error = err;
    }
    assert.ok(error, `${label}: expected rejection`);
    assert.ok(error instanceof C.LinkError, `${label}: expected a LinkError, got ${error}`);
    assert.equal(error.code, "bad-data", label);
  }

  function assertAccepted(label, mutate) {
    const p = clone(basePayload());
    mutate(p);
    try {
      return C.validatePayload(p);
    } catch (err) {
      throw new Error(`${label}: expected acceptance, got ${err && err.code}`);
    }
  }

  async function assertDecodeCode(encoded, code, label) {
    let error = null;
    try {
      await C.decode(encoded);
    } catch (err) {
      error = err;
    }
    assert.ok(error, `${label || code}: expected rejection`);
    assert.ok(error instanceof C.LinkError, `${label || code}: expected a LinkError, got ${error}`);
    assert.equal(error.code, code, label || code);
  }

  // Deterministic PRNG so failures are reproducible.
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

  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ";
  function randomText(rand, len) {
    let s = "";
    for (let i = 0; i < len; i++) s += ALNUM[Math.floor(rand() * ALNUM.length)];
    return s;
  }

  function appRoute() {
    return {
      name: "Loop A",
      waypoints: [
        { lat: 36.123456789, lng: -115.987654321, name: "Start", detail: "1 Main St" },
        { lat: 36.2, lng: -115.2, name: "End", detail: "" },
      ],
      scenes: [
        {
          type: "NVH",
          typeLabel: "NVH",
          label: "Rough road",
          notes: "Listen",
          startIdx: 3,
          endIdx: 9,
          startLat: 36.12,
          startLng: -115.12,
          endLat: 36.18,
          endLng: -115.18,
        },
      ],
      routeCoords: [{ lat: 1, lng: 2 }],
      savedAt: "2020-01-01T00:00:00Z",
    };
  }

  // ---- round trips ---------------------------------------------------

  test("codec: encode -> decode round trip with deflate (marker d)", async () => {
    assert.ok(C.canCompress(), "this browser needs CompressionStream/DecompressionStream for the test suite");
    const encoded = await C.encode(appRoute());
    assert.equal(encoded.charAt(0), "d");
    assert.ok(/^[dp][A-Za-z0-9_-]*$/.test(encoded), "only base64url characters");
    const route = await C.decode(encoded);
    assert.equal(route.name, "Loop A");
    assert.equal(route.waypoints.length, 2);
    assert.deepEqual(route.waypoints[0], { lat: 36.123457, lng: -115.987654, name: "Start", detail: "1 Main St" });
    assert.equal(route.scenes.length, 1);
    assert.deepEqual(route.scenes[0], {
      type: "NVH",
      typeLabel: "NVH",
      label: "Rough road",
      notes: "Listen",
      startLat: 36.12,
      startLng: -115.12,
      endLat: 36.18,
      endLng: -115.18,
    });
  });

  test("codec: decoder accepts the plain format (marker p)", async () => {
    const route = await C.decode(plainLink(basePayload()));
    assert.equal(route.name, "Test route");
    assert.equal(route.waypoints.length, 2);
    assert.equal(route.scenes[0].label, "Rough road");
  });

  test("codec: decoder accepts a hand-made deflate link", async () => {
    const route = await C.decode(await deflatedLink(basePayload()));
    assert.equal(route.waypoints[1].name, "End");
  });

  test("codec: a missing scenes list means no scenes", async () => {
    const p = basePayload();
    delete p.s;
    const route = await C.decode(plainLink(p));
    assert.deepEqual(route.scenes, []);
  });

  test("codec: hostile text survives verbatim (it is only ever shown as text)", async () => {
    const evil = '"><img src=x onerror=alert(1)> \' onmouseover=\'x';
    const r = appRoute();
    r.name = evil;
    r.waypoints[0].name = evil;
    r.scenes[0].notes = evil;
    const route = await C.decode(await C.encode(r));
    assert.equal(route.name, evil);
    assert.equal(route.waypoints[0].name, evil);
    assert.equal(route.scenes[0].notes, evil);
  });

  // ---- payload shape and link format ---------------------------------

  test("codec: payload has no routeCoords/savedAt and rounds to 6 decimals", () => {
    const p = C.buildPayload(appRoute());
    assert.deepEqual(Object.keys(p).sort(), ["n", "s", "v", "w"]);
    const json = JSON.stringify(p);
    assert.ok(!json.includes("routeCoords"), "no routeCoords");
    assert.ok(!json.includes("savedAt"), "no savedAt");
    assert.ok(!json.includes("startIdx"), "no indices");
    assert.deepEqual(p.w[0], [36.123457, -115.987654, "Start", "1 Main St"]);
    assert.equal(p.w[0].length, 4);
    assert.equal(p.s[0].length, 8);
  });

  test("codec: scenes without usable coordinates are left out of the payload", () => {
    const r = appRoute();
    r.scenes.push({ type: "NVH", typeLabel: "NVH", label: "no coords", notes: "" });
    r.scenes.push({ type: "NVH", typeLabel: "NVH", label: "nan", notes: "", startLat: NaN, startLng: 0, endLat: 0, endLng: 0 });
    assert.equal(C.buildPayload(r).s.length, 1);
  });

  test("codec: link puts the route in the fragment, never the query string", async () => {
    const encoded = await C.encode(appRoute());
    const link = C.buildLink(encoded, { origin: "https://user.github.io", pathname: "/kpr-route-planner/" });
    assert.equal(link, "https://user.github.io/kpr-route-planner/#r=" + encoded);
    const url = new URL(link);
    assert.equal(url.search, "");
    assert.equal(url.hash, "#r=" + encoded);
    // Also with the page's real location (whatever this test page is).
    const real = C.buildLink(encoded);
    assert.ok(real.endsWith("#r=" + encoded), "ends with #r=<payload>");
    assert.ok(!real.includes("?"), "no query string");
  });

  test("codec: parseHash recognises only #r= links", () => {
    assert.equal(C.parseHash(""), null);
    assert.equal(C.parseHash("#other"), null);
    assert.equal(C.parseHash("#R=abc"), null);
    assert.equal(C.parseHash("r=abc"), null);
    assert.equal(C.parseHash("#r=dAbc"), "dAbc");
    assert.equal(C.parseHash("#r="), "");
    assert.equal(C.parseHash(null), null);
  });

  // ---- validation table ----------------------------------------------

  test("validate: rejects a wrong or missing version", () => {
    assertRejected("v=2", (p) => { p.v = 2; });
    assertRejected("v=0", (p) => { p.v = 0; });
    assertRejected('v="1"', (p) => { p.v = "1"; });
    assertRejected("no v", (p) => { delete p.v; });
  });

  test("validate: rejects a non-object top level", () => {
    for (const bad of [null, [], "x", 5, true, undefined]) {
      let error = null;
      try {
        C.validatePayload(bad);
      } catch (err) {
        error = err;
      }
      assert.ok(error instanceof C.LinkError, `top level ${JSON.stringify(bad)}`);
    }
  });

  test("validate: waypoint count must be 1..50", () => {
    assertRejected("0 waypoints", (p) => { p.w = []; });
    assertRejected("51 waypoints", (p) => { p.w = Array.from({ length: 51 }, () => [1, 2, "a", "b"]); });
    assertRejected("w not an array", (p) => { p.w = "nope"; });
    assertRejected("w is an object", (p) => { p.w = { 0: [1, 2, "a", "b"], length: 1 }; });
    assertRejected("w missing", (p) => { delete p.w; });
    assertAccepted("1 waypoint", (p) => { p.w = [[1, 2, "a", "b"]]; p.s = []; });
    const r = assertAccepted("50 waypoints", (p) => { p.w = Array.from({ length: 50 }, () => [1, 2, "a", "b"]); });
    assert.equal(r.waypoints.length, 50);
  });

  test("validate: scene count must be at most 100", () => {
    const scene = ["NVH", "NVH", "l", "n", 1, 2, 3, 4];
    assertRejected("101 scenes", (p) => { p.s = Array.from({ length: 101 }, () => scene.slice()); });
    const r = assertAccepted("100 scenes", (p) => { p.s = Array.from({ length: 100 }, () => scene.slice()); });
    assert.equal(r.scenes.length, 100);
    assertRejected("s not an array", (p) => { p.s = "x"; });
    assertRejected("s null", (p) => { p.s = null; });
  });

  test("validate: tuple lengths are exact", () => {
    assertRejected("waypoint 3 items", (p) => { p.w[0] = [1, 2, "a"]; });
    assertRejected("waypoint 5 items", (p) => { p.w[0] = [1, 2, "a", "b", "c"]; });
    assertRejected("waypoint not an array", (p) => { p.w[0] = { 0: 1, 1: 2, 2: "a", 3: "b", length: 4 }; });
    assertRejected("scene 7 items", (p) => { p.s[0].pop(); });
    assertRejected("scene 9 items", (p) => { p.s[0].push(0); });
    assertRejected("scene not an array", (p) => { p.s[0] = "NVH"; });
  });

  test("validate: string length caps (exact cap accepted, cap+1 rejected)", () => {
    const at = (n) => "x".repeat(n);
    assertAccepted("name 200", (p) => { p.n = at(L.MAX_NAME); });
    assertRejected("name 201", (p) => { p.n = at(L.MAX_NAME + 1); });
    assertAccepted("stop name 200", (p) => { p.w[0][2] = at(L.MAX_NAME); });
    assertRejected("stop name 201", (p) => { p.w[0][2] = at(L.MAX_NAME + 1); });
    assertAccepted("stop detail 200", (p) => { p.w[0][3] = at(L.MAX_NAME); });
    assertRejected("stop detail 201", (p) => { p.w[0][3] = at(L.MAX_NAME + 1); });
    assertAccepted("label 200", (p) => { p.s[0][2] = at(L.MAX_NAME); });
    assertRejected("label 201", (p) => { p.s[0][2] = at(L.MAX_NAME + 1); });
    assertAccepted("notes 2000", (p) => { p.s[0][3] = at(L.MAX_NOTES); });
    assertRejected("notes 2001", (p) => { p.s[0][3] = at(L.MAX_NOTES + 1); });
    assertAccepted("custom typeLabel 200", (p) => { p.s[0][0] = "Custom"; p.s[0][1] = at(L.MAX_NAME); });
    assertRejected("custom typeLabel 201", (p) => { p.s[0][0] = "Custom"; p.s[0][1] = at(L.MAX_NAME + 1); });
    assertRejected("custom typeLabel empty", (p) => { p.s[0][0] = "Custom"; p.s[0][1] = ""; });
  });

  test("validate: strings must be strings", () => {
    assertRejected("name number", (p) => { p.n = 5; });
    assertRejected("name null", (p) => { p.n = null; });
    assertRejected("name missing", (p) => { delete p.n; });
    assertRejected("stop name null", (p) => { p.w[0][2] = null; });
    assertRejected("stop detail object", (p) => { p.w[0][3] = {}; });
    assertRejected("scene label array", (p) => { p.s[0][2] = []; });
    assertRejected("scene notes number", (p) => { p.s[0][3] = 1; });
    assertRejected("scene type number", (p) => { p.s[0][0] = 1; });
  });

  test("validate: control characters are rejected, tab/newline/CR are fine", () => {
    assertRejected("NUL in name", (p) => { p.n = "a\u0000b"; });
    assertRejected("BEL in stop name", (p) => { p.w[0][2] = "a\u0007b"; });
    assertRejected("ESC in notes", (p) => { p.s[0][3] = "a\u001bb"; });
    assertRejected("VT in label", (p) => { p.s[0][2] = "a\u000bb"; });
    const r = assertAccepted("tab/lf/cr", (p) => { p.s[0][3] = "line1\nline2\r\n\tindented"; });
    assert.equal(r.scenes[0].notes, "line1\nline2\r\n\tindented");
  });

  test("validate: coordinates must be finite numbers in range", () => {
    assertRejected("lat 90.0001", (p) => { p.w[0][0] = 90.0001; });
    assertRejected("lat -90.0001", (p) => { p.w[0][0] = -90.0001; });
    assertRejected("lng -180.0001", (p) => { p.w[0][1] = -180.0001; });
    assertRejected("lng 180.0001", (p) => { p.w[0][1] = 180.0001; });
    assertAccepted("lat 90 lng -180", (p) => { p.w[0][0] = 90; p.w[0][1] = -180; });
    assertAccepted("lat -90 lng 180", (p) => { p.w[0][0] = -90; p.w[0][1] = 180; });
    assertRejected("null lat", (p) => { p.w[0][0] = null; });
    assertRejected("string lat", (p) => { p.w[0][0] = "36.1"; });
    assertRejected("NaN lat", (p) => { p.w[0][0] = NaN; });
    assertRejected("Infinity lng", (p) => { p.w[0][1] = Infinity; });
    assertRejected("boolean lng", (p) => { p.w[0][1] = true; });
    assertRejected("scene startLat 91", (p) => { p.s[0][4] = 91; });
    assertRejected("scene startLng 181", (p) => { p.s[0][5] = 181; });
    assertRejected("scene endLat -91", (p) => { p.s[0][6] = -91; });
    assertRejected("scene endLng -181", (p) => { p.s[0][7] = -181; });
    assertRejected("scene null coord", (p) => { p.s[0][6] = null; });
    assertRejected("scene string coord", (p) => { p.s[0][7] = "1"; });
  });

  test("validate: scene type must be one of the known types", () => {
    for (const bad of ["Nope", "nvh", "constructor", "__proto__", "toString", "hasOwnProperty", "", "NVH "]) {
      assertRejected(`type ${JSON.stringify(bad)}`, (p) => { p.s[0][0] = bad; });
    }
    for (const good of Object.keys(KPR.scenes.DEFAULT_SCENE_COLORS)) {
      assertAccepted(`type ${good}`, (p) => { p.s[0][0] = good; p.s[0][1] = "Label"; });
    }
  });

  test("validate: a non-Custom type forces typeLabel to the type", () => {
    const r = assertAccepted("forced label", (p) => { p.s[0][0] = "Braking"; p.s[0][1] = "<b>spoof</b>"; });
    assert.equal(r.scenes[0].typeLabel, "Braking");
    const c = assertAccepted("custom keeps label", (p) => { p.s[0][0] = "Custom"; p.s[0][1] = "Infotainment"; });
    assert.equal(c.scenes[0].typeLabel, "Infotainment");
  });

  test("validate: builds fresh objects and never copies unknown keys", () => {
    const p = basePayload();
    p.extra = { evil: true };
    const parsed = JSON.parse('{"v":1,"n":"x","w":[[1,2,"a","b"]],"s":[],"__proto__":{"polluted":true},"constructor":{"x":1}}');
    const r = C.validatePayload(parsed);
    assert.deepEqual(Object.keys(r).sort(), ["name", "scenes", "waypoints"]);
    assert.deepEqual(Object.keys(r.waypoints[0]).sort(), ["detail", "lat", "lng", "name"]);
    assert.equal({}.polluted, undefined);
    const full = C.validatePayload(p);
    assert.equal(full.extra, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });

  // ---- decode: encoding-level rejections -----------------------------

  test("decode: rejects bad markers, characters and lengths", async () => {
    await assertDecodeCode("", "bad-encoding", "empty");
    await assertDecodeCode("x" + b64u(utf8("{}")), "bad-encoding", "unknown marker");
    await assertDecodeCode("D" + b64u(utf8("{}")), "bad-encoding", "uppercase marker");
    await assertDecodeCode("p!!!", "bad-encoding", "invalid characters");
    await assertDecodeCode("pab+/", "bad-encoding", "standard base64 characters");
    await assertDecodeCode("pab=", "bad-encoding", "padding characters");
    await assertDecodeCode("p" + "a b", "bad-encoding", "space");
    await assertDecodeCode("pA", "bad-encoding", "length % 4 == 1");
    await assertDecodeCode("pAAAAA", "bad-encoding", "length % 4 == 1 (5 chars)");
    await assertDecodeCode("p\u00e9\u00e9\u00e9\u00e9", "bad-encoding", "non-ASCII");
    await assertDecodeCode(null, "not-link", "null");
    await assertDecodeCode(123, "not-link", "number");
  });

  test("decode: rejects data that is not a valid route", async () => {
    await assertDecodeCode("p", "bad-data", "empty body");
    await assertDecodeCode(plainLink("hello"), "bad-data", "not JSON");
    await assertDecodeCode(plainLink("[]"), "bad-data", "JSON array");
    await assertDecodeCode(plainLink("null"), "bad-data", "JSON null");
    await assertDecodeCode(plainLink("42"), "bad-data", "JSON number");
    await assertDecodeCode(plainLink('"text"'), "bad-data", "JSON string");
    const v2 = basePayload();
    v2.v = 2;
    await assertDecodeCode(plainLink(v2), "bad-data", "version 2");
    await assertDecodeCode("p" + b64u(new Uint8Array([0xff, 0xfe, 0xfd, 0x7b])), "bad-data", "invalid UTF-8");
    const tooMany = basePayload();
    tooMany.w = Array.from({ length: 51 }, () => [1, 2, "a", "b"]);
    await assertDecodeCode(await deflatedLink(tooMany), "bad-data", "51 waypoints via deflate");
  });

  test("decode: truncated or corrupted deflate data is rejected", async () => {
    const good = await deflatedLink(basePayload());
    // Depending on where it is cut, the length is invalid base64url
    // (bad-encoding) or the deflate data is incomplete (bad-data). Either way
    // it must be a LinkError and nothing may load.
    for (const cut of [good.length - 1, good.length - 8, good.length - 20, 7, 12]) {
      let error = null;
      try {
        await C.decode(good.slice(0, cut));
      } catch (err) {
        error = err;
      }
      assert.ok(error instanceof C.LinkError, `cut at ${cut}: LinkError`);
    }
    await assertDecodeCode("d", "bad-data", "marker only");
    // Flip characters in the middle.
    const mid = Math.floor(good.length / 2);
    const corrupted = good.slice(0, mid) + (good[mid] === "A" ? "B" : "A") + "A" + good.slice(mid + 2);
    let error = null;
    try {
      await C.decode(corrupted);
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof C.LinkError, "corruption yields a LinkError");
  });

  // ---- size limits ---------------------------------------------------

  test("limits: inflated size cap is exact (262144 ok to inflate, 262145 is too big)", async () => {
    // Zeros inflate fine but are not JSON -> bad-data (so they got past the cap).
    const atCap = "d" + b64u(await deflate(new Uint8Array(L.MAX_INFLATED_BYTES)));
    await assertDecodeCode(atCap, "bad-data", "exactly at the cap");
    const overCap = "d" + b64u(await deflate(new Uint8Array(L.MAX_INFLATED_BYTES + 1)));
    await assertDecodeCode(overCap, "too-big", "one byte over the cap");
  });

  test("limits: a decompression bomb (10 MB of zeros) is rejected fast as too-big", async () => {
    const bomb = "d" + b64u(await deflate(new Uint8Array(10 * 1024 * 1024)));
    assert.ok(bomb.length < 60000, `the bomb link is small (${bomb.length} chars)`);
    const t0 = performance.now();
    await assertDecodeCode(bomb, "too-big", "bomb");
    assert.ok(performance.now() - t0 < 5000, "rejected quickly");
  });

  test("limits: an oversized hash is rejected before any decoding", async () => {
    const calls = [];
    const realAtob = window.atob;
    const realDecomp = window.DecompressionStream;
    window.atob = function () {
      calls.push("atob");
      return realAtob.apply(window, arguments);
    };
    window.DecompressionStream = function () {
      calls.push("DecompressionStream");
      throw new Error("must not be constructed");
    };
    try {
      // 100000 chars including "#r=" is the largest accepted hash.
      assert.equal(C.parseHash("#r=" + "A".repeat(L.MAX_HASH_CHARS - 3)).length, L.MAX_HASH_CHARS - 3);
      let error = null;
      try {
        C.parseHash("#r=" + "A".repeat(L.MAX_HASH_CHARS - 2));
      } catch (err) {
        error = err;
      }
      assert.ok(error instanceof C.LinkError, "parseHash rejects");
      assert.equal(error.code, "too-long");
      await assertDecodeCode("d" + "A".repeat(L.MAX_HASH_CHARS), "too-long", "decode of an oversized string");
      assert.equal(calls.length, 0, `nothing was decoded (${calls.join(",")})`);
    } finally {
      window.atob = realAtob;
      window.DecompressionStream = realDecomp;
    }
  });

  test("limits: a 150,000 character hash is rejected", async () => {
    let error = null;
    try {
      C.parseHash("#r=d" + "A".repeat(150000));
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof C.LinkError);
    assert.equal(error.code, "too-long");
  });

  // ---- fuzz ----------------------------------------------------------

  test("fuzz: garbage, truncated and corrupted strings only ever throw LinkError", async () => {
    const rand = prng(12345);
    const alphabets = [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-+/=!@#$%^&*() \t\n<>\"'\\{}[]:;,.\u00e9\u4e2d",
    ];
    const good = await C.encode(appRoute());
    const inputs = [];
    for (let i = 0; i < 150; i++) {
      const alpha = alphabets[i % 2];
      const len = Math.floor(rand() * 200);
      let s = ["d", "p", "x", ""][Math.floor(rand() * 4)];
      for (let j = 0; j < len; j++) s += alpha[Math.floor(rand() * alpha.length)];
      inputs.push(s);
    }
    for (let i = 0; i < 60; i++) inputs.push(good.slice(0, Math.floor(rand() * good.length))); // truncated
    for (let i = 0; i < 60; i++) {
      // corrupted: overwrite a few characters
      const chars = good.split("");
      for (let k = 0; k < 3; k++) chars[Math.floor(rand() * chars.length)] = "A_-9zQ"[Math.floor(rand() * 6)];
      inputs.push(chars.join(""));
    }
    const other = [];
    for (const input of inputs) {
      try {
        await C.decode(input);
      } catch (err) {
        if (!(err instanceof C.LinkError)) other.push(`${JSON.stringify(input).slice(0, 40)} -> ${err}`);
      }
    }
    assert.equal(other.length, 0, "non-LinkError failures: " + other.slice(0, 3).join(" | "));
  });

  // ---- encoder -------------------------------------------------------

  test("encode: truncates long strings to the decoder caps", () => {
    const r = appRoute();
    r.name = "n".repeat(300);
    r.waypoints[0].name = "s".repeat(300);
    r.waypoints[0].detail = "d".repeat(300);
    r.scenes[0].label = "l".repeat(300);
    r.scenes[0].notes = "t".repeat(5000);
    r.scenes[0].type = "Custom";
    r.scenes[0].typeLabel = "c".repeat(300);
    const p = C.buildPayload(r);
    assert.equal(p.n.length, L.MAX_NAME);
    assert.equal(p.w[0][2].length, L.MAX_NAME);
    assert.equal(p.w[0][3].length, L.MAX_NAME);
    assert.equal(p.s[0][1].length, L.MAX_NAME);
    assert.equal(p.s[0][2].length, L.MAX_NAME);
    assert.equal(p.s[0][3].length, L.MAX_NOTES);
    C.validatePayload(clone(p)); // what we generate can be read back
  });

  test("encode: never leaves half of a surrogate pair at the cut", () => {
    const r = appRoute();
    r.name = "a".repeat(L.MAX_NAME - 1) + "\u{1F600}" + "tail"; // the emoji straddles the cap
    const name = C.buildPayload(r).n;
    assert.equal(name.length, L.MAX_NAME - 1);
    const last = name.charCodeAt(name.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no trailing high surrogate");
    // An emoji that fits entirely is kept.
    r.name = "a".repeat(L.MAX_NAME - 2) + "\u{1F600}" + "tail";
    assert.equal(C.buildPayload(r).n.length, L.MAX_NAME);
  });

  test("encode: strips control characters the decoder would reject", async () => {
    const r = appRoute();
    r.name = "a\u0000b\u0007c\td";
    r.waypoints[0].name = "x\u001by";
    const route = await C.decode(await C.encode(r));
    assert.equal(route.name, "abc\td");
    assert.equal(route.waypoints[0].name, "xy");
  });

  test("encode: Custom scene without a label gets a usable one; unknown types become Custom", () => {
    const r = appRoute();
    r.scenes[0].type = "constructor";
    r.scenes[0].typeLabel = "";
    const s = C.buildPayload(r).s[0];
    assert.equal(s[0], "Custom");
    assert.equal(s[1], "Custom");
    r.scenes[0].type = "Braking";
    r.scenes[0].typeLabel = "ignored";
    assert.equal(C.buildPayload(r).s[0][1], "Braking");
  });

  test("encode: refuses more than 50 stops, more than 100 scenes, and oversized routes", async () => {
    const stops = (n) => Array.from({ length: n }, (_, i) => ({ lat: 36 + i / 1000, lng: -115, name: "s" + i, detail: "" }));
    const scene = {
      type: "NVH",
      typeLabel: "NVH",
      label: "x",
      notes: "",
      startLat: 1,
      startLng: 2,
      endLat: 3,
      endLng: 4,
    };
    const expectCode = async (route, code, label) => {
      let error = null;
      try {
        await C.encode(route);
      } catch (err) {
        error = err;
      }
      assert.ok(error instanceof C.LinkError, `${label}: LinkError`);
      assert.equal(error.code, code, label);
    };

    await expectCode({ name: "x", waypoints: stops(51), scenes: [] }, "too-big", "51 stops");
    await C.encode({ name: "x", waypoints: stops(50), scenes: [] }); // 50 is fine
    await expectCode(
      { name: "x", waypoints: stops(2), scenes: Array.from({ length: 101 }, () => scene) },
      "too-big",
      "101 scenes"
    );

    // Incompressible text: the deflated link is longer than the 100,000 char hash cap.
    const rand = prng(99);
    const bigScenes = Array.from({ length: 100 }, () => Object.assign({}, scene, { notes: randomText(rand, 2000) }));
    await expectCode({ name: "x", waypoints: stops(2), scenes: bigScenes }, "too-long", "too long for a hash");

    // Multi-byte text: the JSON itself exceeds 256 KB.
    const wide = Array.from({ length: 100 }, () => Object.assign({}, scene, { notes: "\u20ac".repeat(2000) }));
    await expectCode({ name: "x", waypoints: stops(2), scenes: wide }, "too-big", "JSON over 256 KB");
  });

  test("encode: a maximum-size route (50 stops, 100 scenes) round-trips exactly", async () => {
    const rand = prng(7);
    const waypoints = Array.from({ length: 50 }, (_, i) => ({
      lat: 36 + rand() / 10,
      lng: -115 - rand() / 10,
      name: "Stop " + i + " " + randomText(rand, 20),
      detail: randomText(rand, 40),
    }));
    const scenes = Array.from({ length: 100 }, (_, i) => ({
      type: i % 7 === 6 ? "Custom" : Object.keys(KPR.scenes.DEFAULT_SCENE_COLORS)[i % 6],
      typeLabel: i % 7 === 6 ? "Custom " + i : "",
      label: randomText(rand, 30),
      notes: randomText(rand, 120),
      startLat: 36 + rand() / 10,
      startLng: -115 - rand() / 10,
      endLat: 36 + rand() / 10,
      endLng: -115 - rand() / 10,
    }));
    const route = { name: "Max route", waypoints, scenes };
    const encoded = await C.encode(route);
    assert.ok(encoded.length <= L.MAX_HASH_CHARS - 3, "fits the hash cap");
    const back = await C.decode(encoded);
    const expected = C.validatePayload(clone(C.buildPayload(route)));
    assert.deepEqual(back, expected);
    assert.equal(back.waypoints.length, 50);
    assert.equal(back.scenes.length, 100);
  });

  test("encode: falls back to the plain format when compression is unavailable", async () => {
    const real = window.CompressionStream;
    window.CompressionStream = undefined;
    let encoded;
    try {
      assert.equal(C.canCompress(), false);
      encoded = await C.encode(appRoute());
    } finally {
      window.CompressionStream = real;
    }
    assert.equal(encoded.charAt(0), "p");
    const route = await C.decode(encoded);
    assert.equal(route.name, "Loop A");
  });

  test("decode: a deflate link in a browser without DecompressionStream is 'unsupported'", async () => {
    const link = await deflatedLink(basePayload());
    const real = window.DecompressionStream;
    window.DecompressionStream = undefined;
    try {
      await assertDecodeCode(link, "unsupported", "no DecompressionStream");
    } finally {
      window.DecompressionStream = real;
    }
  });

  // ---- QR -------------------------------------------------------------

  test("qr: a normal link encodes at error-correction Low", async () => {
    const link = C.buildLink(await C.encode(appRoute()), { origin: "https://user.github.io", pathname: "/kpr-route-planner/" });
    const qr = qrcodegen.QrCode.encodeSegments(
      qrcodegen.QrSegment.makeSegments(link),
      qrcodegen.QrCode.Ecc.LOW,
      1,
      40,
      -1,
      false
    );
    assert.ok(Number.isInteger(qr.size) && qr.size > 0, "module size " + qr.size);
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.ok(qr.version <= 40);
    // The helper used by the share dialog gives the same thing.
    const helper = KPR.share.buildQr(link);
    assert.ok(helper, "helper returns a QR");
    assert.equal(helper.size, qr.size);
  });

  test("qr: an over-capacity string throws RangeError, and the share helper turns that into 'no QR'", () => {
    const tooLong = "https://example.test/#r=" + "a".repeat(3200);
    assert.throws(
      () =>
        qrcodegen.QrCode.encodeSegments(
          qrcodegen.QrSegment.makeSegments(tooLong),
          qrcodegen.QrCode.Ecc.LOW,
          1,
          40,
          -1,
          false
        ),
      "too long"
    );
    let rangeError = null;
    try {
      qrcodegen.QrCode.encodeSegments(
        qrcodegen.QrSegment.makeSegments(tooLong),
        qrcodegen.QrCode.Ecc.LOW,
        1,
        40,
        -1,
        false
      );
    } catch (err) {
      rangeError = err;
    }
    assert.ok(rangeError instanceof RangeError, "RangeError");
    assert.equal(KPR.share.buildQr(tooLong), null);
  });

  test("qr: drawn black on white with a 4-module quiet zone and at least 480 px", () => {
    const link = "https://user.github.io/kpr-route-planner/#r=dAbcdef";
    const qr = KPR.share.buildQr(link);
    const canvas = document.createElement("canvas");
    const px = KPR.share.drawQr(canvas, qr);
    assert.ok(px >= 480 && px <= 2048, "width " + px);
    assert.equal(canvas.width, px);
    assert.equal(canvas.height, px);
    const scale = px / (qr.size + 8);
    assert.ok(Number.isInteger(scale), "whole pixels per module");
    const ctx = canvas.getContext("2d");
    const pixel = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    assert.deepEqual(pixel(1, 1), [255, 255, 255, 255], "quiet zone corner is white");
    assert.deepEqual(pixel(Math.floor(3.5 * scale), Math.floor(3.5 * scale)), [255, 255, 255, 255], "still quiet zone");
    // The top-left finder pattern's corner module is always dark.
    assert.deepEqual(pixel(Math.floor(4.5 * scale), Math.floor(4.5 * scale)), [0, 0, 0, 255], "finder corner is black");
  });
})();
