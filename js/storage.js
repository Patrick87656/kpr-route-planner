/**
 * storage.js — save/load a route (waypoints + scene tags) to/from a local
 * JSON file. No backend: uses a Blob download for save, and a file input
 * + FileReader for load.
 */
window.KPR = window.KPR || {};

KPR.storage = (function () {
  const FORMAT_VERSION = 1;

  function init() {
    document.getElementById("save-route").addEventListener("click", saveRoute);

    const loadBtn = document.getElementById("load-route");
    const loadInput = document.getElementById("load-route-input");
    loadBtn.addEventListener("click", () => loadInput.click());
    loadInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) loadRoute(file);
      loadInput.value = ""; // allow re-selecting the same file later
    });
  }

  function saveRoute() {
    const name = document.getElementById("route-name").value.trim() || "Untitled route";
    // Includes each stop's display name/detail so a reloaded route shows the
    // itinerary right away without repeating the name lookups. Files saved
    // before names existed still load fine (names get looked up then).
    const waypoints = KPR.waypoints.getSaveData();

    if (waypoints.length === 0) {
      alert("Nothing to save yet — add some waypoints first.");
      return;
    }

    const scenes = KPR.scenes.getAll().map((s) => ({
      type: s.type,
      typeLabel: s.typeLabel,
      label: s.label,
      notes: s.notes,
      startIdx: s.startIdx,
      endIdx: s.endIdx,
    }));

    const payload = {
      formatVersion: FORMAT_VERSION,
      name,
      savedAt: new Date().toISOString(),
      waypoints,
      routeCoords: KPR.routing.getRouteCoords() || [],
      routeSummary: KPR.routing.getSummary(),
      scenes,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = name.replace(/[^a-z0-9\-_ ]/gi, "").trim() || "route";
    a.href = url;
    a.download = `${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function loadRoute(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.waypoints || !Array.isArray(data.waypoints)) {
          throw new Error("File doesn't look like a KPR route (missing waypoints).");
        }

        document.getElementById("route-name").value = data.name || "Untitled route";
        KPR.waypoints.loadFrom(data.waypoints);
        await KPR.routing.recalculate();
        if (Array.isArray(data.scenes) && data.scenes.length > 0) {
          KPR.scenes.loadFrom(data.scenes);
        }
        KPR.app.refreshLists();
      } catch (err) {
        console.error("Failed to load route:", err);
        alert(`Could not load route file: ${err.message}`);
      }
    };
    reader.onerror = () => alert("Could not read that file.");
    reader.readAsText(file);
  }

  return { init, saveRoute, loadRoute };
})();
