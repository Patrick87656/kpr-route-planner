/**
 * geo-permission.js — the shared source of truth for the browser's
 * geolocation permission state (KPR.geoPermission).
 *
 * Why it exists: during a group trial several people missed the browser's
 * one-shot location prompt, then had no clear way back. The UI needs to (a)
 * read the current permission state, (b) react live when it flips (the user
 * toggled it in site settings), and (c) ask for permission again — but only
 * when the browser will actually show a prompt. A browser never re-prompts
 * once location is "denied"; the only path back is the device/site settings,
 * so requestLocation() must refuse to call the requester in that case.
 *
 * This module is deliberately Mapbox-free and dependency-free so the headless
 * test harness (tests/run.html, which never loads map.js/drive.js because they
 * touch mapboxgl.*) can load and unit-test it.
 *
 * Test seam: the module reads navigator.permissions.query directly. The tests
 * temporarily replace navigator.permissions (and navigator.permissions.query)
 * with a fake whose query() resolves a fake PermissionStatus — an object with
 * a settable `.state` and an addEventListener('change', …) that the test can
 * fire by flipping `.state` and dispatching. isIOS() is tested the same way by
 * stubbing navigator.userAgent / navigator.platform / navigator.maxTouchPoints.
 */
window.KPR = window.KPR || {};

KPR.geoPermission = (function () {
  // Cached last-resolved state. One of 'granted' | 'prompt' | 'denied' |
  // 'unsupported'. Starts 'unsupported' until init()'s query resolves.
  let cachedState = "unsupported";
  // The live PermissionStatus object, once queried (so we can read its
  // .state on a 'change' event). Null until the first successful query.
  let status = null;
  // Subscriber callbacks, notified with the current state on every change
  // and after each refresh().
  const subscribers = new Set();
  // Requester registered by map.js (() => geolocateControl.trigger()).
  let requester = null;

  /** True only when the Permissions API is usable here. On a plain-http page
   * (not a secure context) the geolocation permission can't be queried. */
  function _supported() {
    return !!(
      navigator.permissions &&
      navigator.permissions.query &&
      window.isSecureContext
    );
  }

  function _notify() {
    subscribers.forEach((cb) => {
      try {
        cb(cachedState);
      } catch (err) {
        // A broken subscriber must not stop the others from being notified.
      }
    });
  }

  /** Current cached permission state. */
  function getState() {
    return cachedState;
  }

  /** Re-query the live permission state, update the cache, notify
   * subscribers, and resolve the new state. Resolves 'unsupported' when the
   * Permissions API isn't available or the query rejects. */
  function refresh() {
    if (!_supported()) {
      cachedState = "unsupported";
      return Promise.resolve("unsupported");
    }
    return navigator.permissions
      .query({ name: "geolocation" })
      .then((st) => {
        status = st;
        cachedState = st.state;
        _notify();
        return cachedState;
      })
      .catch(() => {
        // Some browsers reject the geolocation permission query; treat it as
        // if the Permissions API weren't there at all.
        cachedState = "unsupported";
        return "unsupported";
      });
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  function subscribe(cb) {
    subscribers.add(cb);
    return function unsubscribe() {
      subscribers.delete(cb);
    };
  }

  /** Query once at startup and, on the resolved PermissionStatus, listen for
   * live 'change' events (e.g. the user flips location in site settings).
   * Safe to call once at app start; a no-op when unsupported. */
  function init() {
    if (!_supported()) {
      cachedState = "unsupported";
      return;
    }
    refresh().then(() => {
      if (status && typeof status.addEventListener === "function") {
        status.addEventListener("change", () => {
          cachedState = status.state;
          _notify();
        });
      }
    });
  }

  /** Register the function that actually asks the browser for location
   * (map.js passes () => geolocateControl.trigger()). */
  function setRequester(fn) {
    requester = fn;
  }

  /** Ask for location — but only when the browser will really show a prompt.
   * Returns true if the requester was invoked, false otherwise. Never invoked
   * when 'denied' (the browser won't re-prompt from the page) or 'unsupported'.
   */
  function requestLocation() {
    if (getState() === "prompt" && typeof requester === "function") {
      requester();
      return true;
    }
    return false;
  }

  /** Shared iOS/iPadOS detection (iPadOS reports as "MacIntel" with touch).
   * Copied verbatim from drive.js _startGps() so both agree. */
  function isIOS() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }

  return { init, getState, refresh, subscribe, setRequester, requestLocation, isIOS };
})();
