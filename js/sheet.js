/**
 * sheet.js — mobile bottom-sheet behavior for the planner panel.
 *
 * On phone-width screens the planner (#panel) is a bottom sheet instead of a
 * docked side panel. The drag handle (#sheet-handle) lets the user drag it
 * between three snap heights -- peek, half, full -- the way Google Maps and
 * onX do. On wider screens the sheet CSS doesn't apply and this module stays
 * dormant (the handle is display:none, so its listeners never fire).
 *
 * We set the panel height via the `--sheet-h` CSS variable so the CSS media
 * query stays the single source of truth for *when* the sheet layout is
 * active; JS only controls the height within it.
 */
window.KPR = window.KPR || {};

KPR.sheet = (function () {
  // Snap heights as a fraction of viewport height. "peek" roughly matches
  // the CSS --sheet-peek (just the handle + stats peeking above the map).
  const SNAPS = { peek: 0.16, half: 0.54, full: 0.9 };
  let current = "half";

  let handle = null;
  let panel = null;
  let dragging = false;
  let startY = 0;
  let startH = 0;

  function init() {
    handle = document.getElementById("sheet-handle");
    panel = document.getElementById("panel");
    if (!handle || !panel) return;

    // Pointer events cover mouse + touch + pen with one path.
    handle.addEventListener("pointerdown", _onDown);
    // A plain tap on the handle (no drag) cycles peek -> half -> full -> peek.
    handle.addEventListener("click", _onTap);

    _apply(current, false);

    // Rotation or the iOS toolbar showing/hiding change the visible height;
    // keep the sheet at the same snap point.
    // (Skipped mid-drag so it doesn't fight the finger.)
    const refit = () => { if (!dragging) _apply(current, false); };
    window.addEventListener("resize", refit);
    window.addEventListener("orientationchange", refit);
  }

  function _isSheet() {
    // The handle is only shown (display:block) inside the mobile media query.
    return getComputedStyle(handle).display !== "none";
  }

  function _vh() {
    // innerHeight tracks the iOS toolbar but not the on-screen keyboard
    // (visualViewport would shrink the sheet every time the search box is
    // focused).
    return window.innerHeight;
  }

  function _apply(snap, animate) {
    current = snap;
    // Pixels of the *visible* viewport, not vh: on iOS Safari vh ignores the
    // toolbar, so a "90vh" sheet would hide its bottom under it.
    panel.style.setProperty("--sheet-h", `${Math.round(SNAPS[snap] * _vh())}px`);
    panel.classList.toggle("dragging", !animate);
    if (!animate) {
      // force the no-transition height to stick, then allow transitions again
      // for the next programmatic change
      requestAnimationFrame(() => panel.classList.remove("dragging"));
    }
  }

  function _onDown(e) {
    if (!_isSheet()) return;
    dragging = true;
    movedPx = 0;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    panel.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", _onMove);
    handle.addEventListener("pointerup", _onUp);
    handle.addEventListener("pointercancel", _onUp);
    e.preventDefault();
  }

  let movedPx = 0;

  function _onMove(e) {
    if (!dragging) return;
    const dy = startY - e.clientY; // up = taller
    movedPx = Math.max(movedPx, Math.abs(dy));
    const h = Math.max(_vh() * 0.1, Math.min(_vh() * 0.92, startH + dy));
    panel.style.setProperty("--sheet-h", `${h}px`);
  }

  function _onUp(e) {
    if (!dragging) return;
    dragging = false;
    handle.removeEventListener("pointermove", _onMove);
    handle.removeEventListener("pointerup", _onUp);
    handle.removeEventListener("pointercancel", _onUp);

    // Snap to whichever height is closest to where they let go.
    const frac = panel.getBoundingClientRect().height / _vh();
    let best = "half";
    let bestD = Infinity;
    Object.keys(SNAPS).forEach((k) => {
      const d = Math.abs(SNAPS[k] - frac);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    _apply(best, true);
  }

  function _onTap() {
    // Only treat as a tap if the pointer barely moved (otherwise it was a
    // drag, already handled on pointerup).
    if (movedPx > 6) return;
    const order = ["peek", "half", "full"];
    const next = order[(order.indexOf(current) + 1) % order.length];
    _apply(next, true);
  }

  /** Open the sheet to at least half height (called when a search result or
   * action needs the user to see the list). */
  function expand() {
    if (_isSheet() && current === "peek") _apply("half", true);
  }

  return { init, expand };
})();
