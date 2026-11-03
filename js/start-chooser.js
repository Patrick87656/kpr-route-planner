/**
 * start-chooser.js — the "Start with" chooser at the top of the planner panel.
 *
 * Two large choice cards when the route is empty — "Browse library" (opens the
 * saved-routes dialog) and "New route" (clears the current route through the
 * one shared confirm-and-clear path) — plus a quiet "Open a shared link" row.
 * Once the route has stops the whole thing collapses to a slim bar that still
 * reaches Browse library / New route through small buttons.
 *
 * The collapse/expand decision is driven by the SAME signal that updates
 * #waypoint-count and the itinerary empty-hint: app.js calls sync() from the
 * end of _refreshWaypointList(), which runs on the waypoints onChange callback.
 * No polling, no extra map listeners.
 *
 * The pure decision helper shouldCollapse(count) is exported so the collapse
 * rule can be unit-tested without Mapbox (mirrors open-link.js's extractHash).
 *
 * This module never re-binds #open-link-btn: open-link.js already wires that
 * element's click wherever it lives, so the chooser only relocates it in the
 * markup. Browse library / New route are wired to KPR.browseRoutes.open() and
 * KPR.waypoints.confirmClearAll() respectively.
 */
window.KPR = window.KPR || {};

KPR.startChooser = (function () {
  const $ = (id) => document.getElementById(id);

  /** Collapse once the route has at least one stop. Pure, unit-tested. */
  function shouldCollapse(count) {
    return Number(count) > 0;
  }

  function _browse() {
    if (KPR.browseRoutes && typeof KPR.browseRoutes.open === "function") {
      KPR.browseRoutes.open();
    }
  }

  function _newRoute() {
    if (KPR.waypoints && typeof KPR.waypoints.confirmClearAll === "function") {
      KPR.waypoints.confirmClearAll();
    }
  }

  /** Read the live stop count and toggle the collapsed presentation. */
  function sync() {
    const root = $("start-chooser");
    if (!root) return;
    const count = KPR.waypoints && typeof KPR.waypoints.count === "function" ? KPR.waypoints.count() : 0;
    root.classList.toggle("is-collapsed", shouldCollapse(count));
  }

  function init() {
    // Big (expanded) cards and the slim-bar compact buttons all drive the same
    // two actions. Each is guarded so a missing element is a no-op.
    [["chooser-browse", _browse], ["chooser-browse-compact", _browse],
     ["chooser-new", _newRoute], ["chooser-new-compact", _newRoute]].forEach(([id, fn]) => {
      const el = $(id);
      if (el) el.addEventListener("click", fn);
    });
    // #open-link-btn (relocated into the chooser) is wired by open-link.js;
    // the chooser must not re-bind it or it would open twice.
    sync();
  }

  return { init, sync, shouldCollapse };
})();
