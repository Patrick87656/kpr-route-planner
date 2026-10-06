/**
 * beta.js — the switch for the scene-rating / vehicle-picker / send-results
 * features. While the features are being tried out they stay hidden unless a
 * person opts in with  ?beta=1  (and back out with  ?beta=0 ). The choice is
 * remembered on that device.
 *
 * Why a flag that is read at page load (not a live toggle): it only changes
 * through the URL, so each gated module checks isOn() once in its own init /
 * entry point and nothing needs change notifications.
 *
 * No DOM access at load time.
 */
window.KPR = window.KPR || {};

KPR.beta = (function () {
  // Flip this to true to turn the evaluation features ON for everyone. It is
  // the only line that needs to change. An explicit ?beta=0 still turns the
  // features off on that device.
  const DEFAULT_ON = false;

  const KEY = "kprBeta"; // "1" = on, "0" = off, absent = DEFAULT_ON

  // Used when localStorage is unavailable or throws (private mode, blocked
  // storage), so a ?beta=1 link still works for the rest of the session.
  let memory = null; // null = not set, otherwise true/false

  function _read() {
    try {
      const v = localStorage.getItem(KEY);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch (err) {
      // fall through to the in-memory value
    }
    return null;
  }

  function isOn() {
    // A value set during this page's life wins (it is also what we tried to
    // store), so a failed write can't be masked by an older stored value.
    if (memory !== null) return memory;
    const stored = _read();
    return stored !== null ? stored : DEFAULT_ON;
  }

  function set(on) {
    memory = !!on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch (err) {
      // memory already holds the value
    }
  }

  /**
   * Handle ?beta=1 / ?beta=0 in the address. Only that one parameter is
   * removed (via replaceState, so there is no reload and no new history
   * entry); other parameters and the #fragment (a #r= or #res= link) are
   * kept. Any other value is ignored and left in place. `loc` and `hist` are
   * seams for tests.
   */
  function initFromUrl(loc = location, hist = history) {
    let params;
    try {
      params = new URLSearchParams(loc.search);
    } catch (err) {
      return;
    }
    const value = params.get("beta");
    if (value !== "1" && value !== "0") return;

    set(value === "1");
    params.delete("beta");
    const rest = params.toString();
    try {
      hist.replaceState(null, "", loc.pathname + (rest ? "?" + rest : "") + loc.hash);
    } catch (err) {
      // Address cleanup is cosmetic; the flag is already stored.
    }
  }

  return { isOn, set, initFromUrl };
})();
