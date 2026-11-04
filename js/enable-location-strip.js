/**
 * enable-location-strip.js — the "Enable location" strip above Start drive
 * (KPR.enableLocationStrip).
 *
 * Why it exists: during a group trial several people missed the browser's
 * one-shot location prompt and had no clear way back. This strip is a visible,
 * in-panel path to turn location on. It is hidden when permission is 'granted'
 * (or 'unsupported') and only appears for 'prompt' and 'denied':
 *   - 'prompt'  — tapping the button calls KPR.map.requestLocation(), which
 *                 triggers the native popup. When the user grants it, the
 *                 Permissions API 'change' event re-runs render() and the strip
 *                 hides itself.
 *   - 'denied'  — the browser will NOT re-prompt from the page, so the button
 *                 instead reveals inline, device-specific re-enable steps (an
 *                 iOS Safari path vs. a generic site-settings path). It never
 *                 calls requestLocation() in this state.
 *
 * State comes from the shared source of truth KPR.geoPermission (FEAT-001):
 * render() is subscribed to its live 'change' notifications, so granting from
 * anywhere (even the browser chrome) hides the strip. render(state) is exported
 * so it can be unit-tested directly, mirroring browse-routes' renderList.
 *
 * All help text goes in through textContent, never innerHTML (DOM-safety
 * audit, tests/render-audit.test.js).
 */
window.KPR = window.KPR || {};

KPR.enableLocationStrip = (function () {
  const $ = (id) => document.getElementById(id);

  const IOS_STEPS =
    "Settings \u203A Privacy \u203A Location Services \u203A Safari Websites";
  const GENERIC_STEPS =
    "Allow location for this site in your browser's site settings, then reload.";

  /** Paint the strip for a permission state. Exported so tests call it directly.
   * 'granted'/'unsupported' hide the strip (and its help); 'prompt'/'denied'
   * show it. The help sub-region stays hidden until the button is tapped in
   * the 'denied' state. */
  function render(state) {
    const strip = $("enable-location");
    const help = $("enable-location-help");
    if (!strip) return;

    if (state === "granted" || state === "unsupported") {
      strip.classList.add("hidden");
      if (help) {
        help.classList.add("hidden");
        help.textContent = "";
      }
      return;
    }

    // 'prompt' or 'denied': the strip is visible. The help region only opens
    // on a tap while denied, so collapse it on every (re)paint.
    strip.classList.remove("hidden");
    if (help) help.classList.add("hidden");
  }

  /** Button handler reads the CURRENT permission state each time. In 'prompt'
   * it triggers the native popup; in 'denied' it toggles the device-specific
   * re-enable steps and never re-prompts. */
  function _onClick() {
    const state = KPR.geoPermission.getState();
    if (state === "prompt") {
      if (KPR.map && typeof KPR.map.requestLocation === "function") {
        KPR.map.requestLocation();
      }
      return;
    }
    if (state === "denied") {
      const help = $("enable-location-help");
      if (!help) return;
      const hidden = help.classList.contains("hidden");
      if (hidden) {
        help.textContent = KPR.geoPermission.isIOS() ? IOS_STEPS : GENERIC_STEPS;
        help.classList.remove("hidden");
      } else {
        help.classList.add("hidden");
      }
    }
  }

  function init() {
    const btn = $("enable-location-btn");
    if (btn) btn.addEventListener("click", _onClick);
    // React live: granting from anywhere flips state and hides the strip.
    KPR.geoPermission.subscribe(render);
    // Initial paint from whatever state geoPermission currently holds.
    render(KPR.geoPermission.getState());
  }

  return { init, render };
})();
