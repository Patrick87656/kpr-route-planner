/**
 * Tests for saving scenes by coordinates and snapping them back onto a
 * recalculated route (js/scenes.js). See tests/fixtures/route-fixtures.js.
 */
(function () {
  const F = window.KPR_FIXTURES;
  const S = KPR.scenes;

  // The behaviour before coordinates existed: indices clamped to the route.
  const legacyClamp = (route, idx) => Math.min(idx, route.length - 1);

  // ---- (a) format v1 (indices only) still loads as it always did ----------

  test("v1 fixture: index-only scenes resolve exactly like the old clamp", () => {
    const data = KPR.storage.normalizeFileData(JSON.parse(JSON.stringify(F.v1File)));
    assert.equal(data.scenes.length, 3);
    [F.oldRoute, F.sparseRoute].forEach((route) => {
      data.scenes.forEach((s) => {
        assert.equal(s.startLat, undefined, "v1 scene has no coordinates");
        const r = S.resolveSceneRange(route, s);
        assert.deepEqual(r, {
          startIdx: legacyClamp(route, s.startIdx),
          endIdx: legacyClamp(route, s.endIdx),
        });
      });
    });
  });

  test("v1 fixture: indices past a shorter route are clamped to its last point", () => {
    const [nvh, infotainment, braking] = F.v1File.scenes;
    assert.deepEqual(S.resolveSceneRange(F.sparseRoute, nvh), { startIdx: 2, endIdx: 5 });
    assert.deepEqual(S.resolveSceneRange(F.sparseRoute, infotainment), { startIdx: 5, endIdx: 5 });
    assert.deepEqual(S.resolveSceneRange(F.sparseRoute, braking), { startIdx: 3, endIdx: 5 });
  });

  test("v1 records: negative and reversed indices are tidied up", () => {
    assert.deepEqual(S.resolveSceneRange(F.oldRoute, { startIdx: -4, endIdx: 3 }), { startIdx: 0, endIdx: 3 });
    assert.deepEqual(S.resolveSceneRange(F.oldRoute, { startIdx: 7, endIdx: 2 }), { startIdx: 2, endIdx: 7 });
  });

  test("malformed records are skipped, not thrown", () => {
    const bad = [null, undefined, {}, { startIdx: "a", endIdx: 3 }, { startIdx: 1 }, { startIdx: 1.5, endIdx: 3 }];
    bad.forEach((rec) => assert.equal(S.resolveSceneRange(F.oldRoute, rec), null));
    assert.equal(S.resolveSceneRange(null, { startIdx: 1, endIdx: 2 }), null);
    assert.equal(S.resolveSceneRange([], { startIdx: 1, endIdx: 2 }), null);
  });

  test("scenes.loadFrom returns {loaded, skipped} and never throws", () => {
    // No route yet: everything is skipped.
    S.onRouteUpdated(null);
    assert.deepEqual(S.loadFrom(F.v1File.scenes), { loaded: 0, skipped: 3 });
    // With a route, records that can't be placed (or whose map layer can't
    // be built, as here where there is no map) are counted, not thrown.
    S.onRouteUpdated(F.oldRoute);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const result = S.loadFrom([{}, null, { startIdx: 1, endIdx: 3, type: "NVH" }]);
      assert.deepEqual(result, { loaded: 0, skipped: 3 });
      assert.deepEqual(S.loadFrom(undefined), { loaded: 0, skipped: 0 });
    } finally {
      console.warn = warn;
      S.onRouteUpdated(null);
    }
  });

  // ---- (b) format v2 round trip -------------------------------------------

  function plainScene(startIdx, endIdx, type, typeLabel) {
    return { type, typeLabel, label: "L" + startIdx, notes: "n", startIdx, endIdx };
  }

  test("buildSaveRecord: keeps indices and adds coordinates of those route points", () => {
    const rec = S.buildSaveRecord(plainScene(2, 5, "NVH", "NVH"), F.oldRoute);
    assert.equal(rec.startIdx, 2);
    assert.equal(rec.endIdx, 5);
    assert.equal(rec.startLat, F.oldRoute[2].lat);
    assert.equal(rec.startLng, F.oldRoute[2].lng);
    assert.equal(rec.endLat, F.oldRoute[5].lat);
    assert.equal(rec.endLng, F.oldRoute[5].lng);
    assert.equal(rec.label, "L2");
    assert.equal(rec.notes, "n");
  });

  test("buildSaveRecord: indices are clamped and the drawn segment wins for coordinates", () => {
    const clamped = S.buildSaveRecord(plainScene(3, 99, "NVH", "NVH"), F.sparseRoute);
    assert.equal(clamped.endIdx, 5);
    assert.equal(clamped.endLat, F.sparseRoute[5].lat);

    // The segment is what is really on the map, even if the route changed since.
    const scene = plainScene(1, 2, "NVH", "NVH");
    scene.segment = [F.oldRoute[6], F.oldRoute[7], F.oldRoute[8]];
    const rec = S.buildSaveRecord(scene, F.sparseRoute);
    assert.equal(rec.startLat, F.oldRoute[6].lat);
    assert.equal(rec.endLat, F.oldRoute[8].lat);

    // No route at all: still a usable index-only record, no coordinates.
    const bare = S.buildSaveRecord(plainScene(1, 2, "NVH", "NVH"), null);
    assert.equal(bare.startIdx, 1);
    assert.equal(bare.startLat, undefined);
  });

  test("v2 round trip: file keeps everything and resolves to the original indices", () => {
    const scenes = [plainScene(2, 5, "NVH", "NVH"), plainScene(6, 9, "Custom", "Infotainment")].map((s) =>
      S.buildSaveRecord(s, F.oldRoute)
    );
    const file = KPR.storage.buildSaveData({
      name: "Round trip",
      waypoints: F.v1File.waypoints,
      scenes,
      routeCoords: F.oldRoute,
      routeSummary: F.v1File.routeSummary,
      now: 0,
    });
    assert.equal(file.formatVersion, 3);
    assert.equal(file.savedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(file.routeCoords.length, F.oldRoute.length);
    assert.deepEqual(file.routeSummary, F.v1File.routeSummary);
    file.scenes.forEach((s) => {
      assert.equal(s.startLat, F.oldRoute[s.startIdx].lat);
      assert.equal(s.endLat, F.oldRoute[s.endIdx].lat);
    });

    const back = KPR.storage.normalizeFileData(JSON.parse(JSON.stringify(file)));
    assert.equal(back.scenes.length, 2);
    assert.deepEqual(S.resolveSceneRange(F.oldRoute, back.scenes[0]), { startIdx: 2, endIdx: 5 });
    assert.deepEqual(S.resolveSceneRange(F.oldRoute, back.scenes[1]), { startIdx: 6, endIdx: 9 });
    assert.equal(back.scenes[1].typeLabel, "Infotainment");
  });

  // ---- (c) snapping onto a route with a different number of points --------

  function rec(route, a, b) {
    return S.buildSaveRecord(plainScene(a, b, "NVH", "NVH"), route);
  }

  test("snap: old route 3..8 lands on the same road stretch of a denser route", () => {
    // Index-only would say 3..8 (the wrong place on a 21-point route).
    assert.deepEqual(S.resolveSceneRange(F.denseRoute, rec(F.oldRoute, 3, 8)), { startIdx: 6, endIdx: 16 });
  });

  test("snap: old route lands on the nearest points of a sparser route", () => {
    assert.deepEqual(S.resolveSceneRange(F.sparseRoute, rec(F.oldRoute, 4, 8)), { startIdx: 2, endIdx: 4 });
  });

  test("snap: result is in bounds with start < end", () => {
    [F.denseRoute, F.sparseRoute, F.loopRoute].forEach((route) => {
      const r = S.resolveSceneRange(route, rec(F.oldRoute, 2, 9));
      assert.ok(r.startIdx >= 0 && r.endIdx <= route.length - 1 && r.startIdx < r.endIdx);
    });
  });

  test("snap: a reversed scene is swapped into travel order", () => {
    const reversed = Object.assign({}, rec(F.oldRoute, 3, 8), {
      startLat: F.oldRoute[8].lat,
      endLat: F.oldRoute[3].lat,
    });
    assert.deepEqual(S.resolveSceneRange(F.oldRoute, reversed), { startIdx: 3, endIdx: 8 });
  });

  test("snap: identical start and end gives end = start + 1", () => {
    assert.deepEqual(S.resolveSceneRange(F.oldRoute, rec(F.oldRoute, 4, 4)), { startIdx: 4, endIdx: 5 });
  });

  test("snap: a scene starting on the last point moves back one", () => {
    assert.deepEqual(S.resolveSceneRange(F.oldRoute, rec(F.oldRoute, 10, 10)), { startIdx: 9, endIdx: 10 });
  });

  test("snap: on a loop the end is found forward of the start", () => {
    // Start at the lat of idx 2, end at the lat that occurs at idx 1 (going
    // out) and idx 9 (coming back): the end must be the later one.
    const r = S.resolveSceneRange(F.loopRoute, {
      startLat: F.oldRoute[2].lat,
      startLng: F.oldRoute[2].lng,
      endLat: F.oldRoute[1].lat,
      endLng: F.oldRoute[1].lng,
    });
    assert.deepEqual(r, { startIdx: 2, endIdx: 9 });
  });

  test("snap: empty and one-point routes give null without throwing", () => {
    const r = rec(F.oldRoute, 2, 5);
    assert.equal(S.snapToRoute([], r), null);
    assert.equal(S.snapToRoute([F.oldRoute[0]], r), null);
    assert.equal(S.snapToRoute(null, r), null);
    assert.equal(S.resolveSceneRange([F.oldRoute[0]], r), null);
  });

  test("snap: NaN or string coordinates fall back to the saved indices", () => {
    const base = { startIdx: 2, endIdx: 5 };
    const nan = Object.assign({}, base, { startLat: NaN, startLng: -83, endLat: 42.005, endLng: -83 });
    const str = Object.assign({}, base, { startLat: "42.002", startLng: "-83", endLat: "42.005", endLng: "-83" });
    const outOfRange = Object.assign({}, base, { startLat: 142, startLng: -83, endLat: 42.005, endLng: -83 });
    [nan, str, outOfRange].forEach((bad) => {
      assert.deepEqual(S.resolveSceneRange(F.oldRoute, bad), { startIdx: 2, endIdx: 5 });
    });
    assert.equal(S.snapToRoute(F.oldRoute, nan), null);
    assert.equal(S.snapToRoute(F.oldRoute, str), null);
    assert.equal(S.snapToRoute(F.oldRoute, null), null);
    assert.equal(S.nearestIndex(F.oldRoute, NaN, 0), -1);
  });

  test("snap: always start < end and in bounds for any point pair", () => {
    const twoPoint = F.oldRoute.slice(0, 2);
    const routes = [F.oldRoute, F.denseRoute, F.sparseRoute, F.loopRoute, twoPoint];
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    routes.forEach((route) => {
      for (let i = 0; i < 200; i++) {
        const r = S.snapToRoute(route, {
          startLat: 41.99 + rand() * 0.03,
          startLng: -83 + (rand() - 0.5) * 0.001,
          endLat: 41.99 + rand() * 0.03,
          endLng: -83 + (rand() - 0.5) * 0.001,
        });
        assert.ok(r.startIdx >= 0 && r.endIdx <= route.length - 1 && r.startIdx < r.endIdx, JSON.stringify(r));
      }
    });
  });

  test("nearestIndex: finds the closest point, honours `from`, ties go to the earliest", () => {
    assert.equal(S.nearestIndex(F.oldRoute, 42.0041, -83), 4);
    assert.equal(S.nearestIndex(F.oldRoute, 42.0041, -83, 6), 6);
    assert.equal(S.nearestIndex(F.loopRoute, 42.002, -83), 2);
    assert.equal(S.nearestIndex([], 42, -83), -1);
  });
})();
