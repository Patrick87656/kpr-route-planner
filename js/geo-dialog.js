/**
 * geo-dialog.js — the pre-drive location permission backstop (KPR.geoDialog).
 *
 * Why it exists: during a group trial several people missed the browser's
 * one-shot location prompt and started a drive with no location tracking.
 * This dialog is a backstop: when the user taps Start drive and permission is
 * NOT 'granted', it appears FIRST, explains the drive follows their location,
 * and offers an action before the normal drive-start flow continues.
 *
 * It is prompt-and-explain, NEVER a hard gate. Whatever the user does — Allow,
 * Not now, Escape, or a backdrop click — the drive-start flow continues via
 * the onDone callback. The only thing the dialog changes is giving the user a
 * clear chance to turn location on first.
 *   - 'prompt' — Allow calls KPR.map.requestLocation() (the native popup),
 *                then continues.
 *   - 'denied' — the browser will NOT re-prompt from the page, so Allow is
 *                hidden; the body shows device-specific re-enable steps and the
 *                only action is to dismiss (which still continues the drive).
 *
 * State comes from the shared source of truth KPR.geoPermission (FEAT-001).
 * It cooperates with the FEAT-002 strip through that shared state: granting
 * there flips the state to 'granted', so Start drive skips this dialog.
 *
 * Structure and a11y mirror evaluation.js's #vehicle-dialog: store lastFocus,
 * show by removing 'hidden', Escape + backdrop-click close, Tab trap over the
 * focusable buttons, restore focus on close. Body text goes in through
 * textContent, never innerHTML (DOM-safety audit, tests/render-audit.test.js).
 */
window.KPR = window.KPR || {};

KPR.geoDialog = (function () {
  const $ = (id) => document.getElementById(id);

  const PROMPT_BODY =
    "This drive follows your location on the route. Tap Allow to turn it on.";
  const IOS_DENIED_BODY =
    "Location is blocked. Turn it on in Settings \u203A Privacy \u203A Location Services \u203A Safari Websites, then reload.";
  const GENERIC_DENIED_BODY =
    "Location is blocked. Allow it for this site in your browser's site settings, then reload.";

  let dialogState = null; // { onDone, lastFocus } while open, else null
  let wired = false;

  function isOpen() {
    return dialogState !== null;
  }

  /** Show the dialog for the current permission state and store the
   * continue-the-drive callback. No-op if already open. `onDone` always runs
   * once the user responds (Allow, Not now, Escape, or backdrop). */
  function open(onDone) {
    if (dialogState) return;
    _wire();

    const state = KPR.geoPermission.getState();
    const body = $("geo-dialog-body");
    const allow = $("geo-dialog-allow");

    if (state === "denied") {
      body.textContent = KPR.geoPermission.isIOS()
        ? IOS_DENIED_BODY
        : GENERIC_DENIED_BODY;
      // A denied geolocation can't be re-prompted from the page, so there is
      // no Allow action — leave only the dismiss button.
      allow.classList.add("hidden");
    } else {
      body.textContent = PROMPT_BODY;
      allow.classList.remove("hidden");
    }

    dialogState = { onDone, lastFocus: document.activeElement };
    $("geo-dialog").classList.remove("hidden");
    // Focus the primary actionable button: Allow when shown, else dismiss.
    const focusTarget = allow.classList.contains("hidden")
      ? $("geo-dialog-dismiss")
      : allow;
    focusTarget.focus();
  }

  /** Hide the dialog, restore focus, and run the stored onDone exactly once.
   * Clears dialogState before calling onDone so a re-entrant start() sees the
   * dialog as closed. */
  function _close() {
    if (!dialogState) return;
    const { onDone, lastFocus } = dialogState;
    dialogState = null;
    $("geo-dialog").classList.add("hidden");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    if (typeof onDone === "function") onDone();
  }

  /** Allow: in 'prompt' trigger the native popup, then continue. In 'denied'
   * (Allow shouldn't be visible, but guard anyway) just continue. */
  function _onAllow() {
    if (!dialogState) return;
    if (KPR.geoPermission.getState() === "prompt") {
      if (KPR.map && typeof KPR.map.requestLocation === "function") {
        KPR.map.requestLocation();
      }
    }
    _close();
  }

  function _trapTab(e) {
    const items = Array.from(
      $("geo-dialog").querySelectorAll("button")
    ).filter((el) => !el.disabled && el.getClientRects().length > 0);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function _wire() {
    if (wired) return;
    wired = true;
    $("geo-dialog-allow").addEventListener("click", _onAllow);
    $("geo-dialog-dismiss").addEventListener("click", _close);
    $("geo-dialog").addEventListener("click", (e) => {
      if (e.target === $("geo-dialog")) _close(); // backdrop, not the box
    });
    document.addEventListener("keydown", (e) => {
      if (!dialogState) return;
      if (e.key === "Escape") _close();
      else if (e.key === "Tab") _trapTab(e);
    });
  }

  function init() {
    _wire();
  }

  return { init, open, isOpen };
})();
