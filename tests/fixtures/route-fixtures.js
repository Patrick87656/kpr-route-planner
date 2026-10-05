/**
 * Hand-made fixtures for the tests, NOT real data. The coordinates are an
 * invented straight road (constant longitude, latitude rising north) so the
 * expected snapping results are easy to work out by hand:
 *   0.001 degrees of latitude is about 111 m.
 */
(function () {
  const BASE_LAT = 42.0;
  const LNG = -83.0;

  /** `count` points from BASE_LAT northwards, `step` degrees apart. */
  function line(count, step) {
    const pts = [];
    for (let i = 0; i < count; i++) {
      pts.push({ lat: Number((BASE_LAT + i * step).toFixed(6)), lng: LNG });
    }
    return pts;
  }

  // The route a v1 file was saved against: 11 points, 0.001 apart.
  const oldRoute = line(11, 0.001);
  // Same road, recalculated with more / fewer points.
  const denseRoute = line(21, 0.0005);
  const sparseRoute = line(6, 0.002);

  // Out and back along the same road: it revisits the same coordinates.
  // Indices 0..5 go north, 6..10 come back south (lat of idx 4, 3, 2, 1, 0).
  const loopRoute = oldRoute.slice(0, 6).concat(oldRoute.slice(0, 5).reverse());

  // A format v1 file: scenes are indices only, no coordinates.
  const v1File = {
    formatVersion: 1,
    name: "Fixture loop",
    savedAt: "2025-01-01T00:00:00.000Z",
    waypoints: [
      { lat: oldRoute[0].lat, lng: LNG, name: "Start Road", detail: "Testville, Michigan" },
      { lat: oldRoute[3].lat, lng: LNG, name: "Second Road", detail: "Testville, Michigan" },
      { lat: oldRoute[7].lat, lng: LNG, name: "Third Road", detail: "Testville, Michigan" },
      { lat: oldRoute[10].lat, lng: LNG, name: "End Road", detail: "Testville, Michigan" },
    ],
    routeCoords: oldRoute.map((p) => ({ lat: p.lat, lng: p.lng })),
    routeSummary: { distanceMeters: 1110, durationSeconds: 120 },
    scenes: [
      { type: "NVH", typeLabel: "NVH", label: "Rough patch", notes: "Expansion joints", startIdx: 2, endIdx: 5 },
      { type: "Custom", typeLabel: "Infotainment", label: "Dead zone", notes: "", startIdx: 6, endIdx: 9 },
      // endIdx 9 is past the end of a shorter (6-point) recalculated route.
      { type: "Braking", typeLabel: "Braking", label: "Hard stop", notes: "From 50 mph", startIdx: 3, endIdx: 9 },
    ],
  };

  window.KPR_FIXTURES = { v1File, oldRoute, denseRoute, sparseRoute, loopRoute };
})();
