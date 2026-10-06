/**
 * share.js — "Share" button and opening shared routes.
 *
 * Sharing: builds a link (route-codec.js) with the whole route inside the URL
 * fragment, shows it as a QR code (drawn locally with the vendored qrcodegen
 * library; nothing is sent to a QR service) plus a copyable link and, where
 * the device supports it, the system share sheet.
 *
 * Opening: when the app loads with #r=... in the address (or the hash
 * changes), the link is decoded and validated FIRST, then loaded through the
 * same KPR.storage.applyRoute the JSON "Load" button uses.
 *
 * Everything that comes out of a link is attacker-controlled text. It only
 * ever reaches the page through .value / .textContent / alert(); there is no
 * innerHTML here.
 */
window.KPR = window.KPR || {};

KPR.share = (function () {
  const QR_MIN_PX = 480; // canvas is at least this wide; CSS scales it down crisply
  const QR_MAX_PX = 2048;
  const QR_QUIET_ZONE = 4; // modules of white border the QR spec asks for
  const LONG_LINK_CHARS = 2000;
  // Shown under a link longer than LONG_LINK_CHARS (also exported, so other
  // dialogs that show a link can say the same thing).
  const LONG_LINK_HINT =
    "Some chat apps may cut long links. If this one gets cut, use Save and send the file instead.";

  const BAD_LINK_MSG = "That link doesn't look like a KPR route. Ask the sender to share it again.";
  const UNSUPPORTED_MSG =
    "This browser can't open this link. Try opening it in Safari or Chrome.";
  const TOO_BIG_MSG = "This route is too big to share as a link. Use Save and send the file instead.";

  let openSeq = 0; // bumped on every open/close so a slow encode can't repaint a closed dialog
  let statusTimer = null;
  let lastFocus = null;
  let loading = false;

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------
  // QR code
  // ---------------------------------------------------------------------

  /** QrCode for `text` (error correction Low = fewest, biggest modules =
   * easiest to scan off a screen), or null when it doesn't fit even the
   * biggest QR version (about 2950 bytes) or anything else goes wrong. */
  function buildQr(text) {
    try {
      const segs = qrcodegen.QrSegment.makeSegments(text);
      return qrcodegen.QrCode.encodeSegments(segs, qrcodegen.QrCode.Ecc.LOW, 1, 40, -1, false);
    } catch (err) {
      return null;
    }
  }

  /** Draw black modules on white with a 4-module quiet zone, at a whole
   * number of pixels per module so edges stay sharp. Returns the canvas width. */
  function drawQr(canvas, qr) {
    const modules = qr.size + QR_QUIET_ZONE * 2;
    let scale = Math.max(1, Math.ceil(QR_MIN_PX / modules));
    while (scale > 1 && modules * scale > QR_MAX_PX) scale--;
    const px = modules * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000000";
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) {
          ctx.fillRect((x + QR_QUIET_ZONE) * scale, (y + QR_QUIET_ZONE) * scale, scale, scale);
        }
      }
    }
    return px;
  }

  // ---------------------------------------------------------------------
  // Share dialog
  // ---------------------------------------------------------------------

  function _setStatus(text, clearAfterMs) {
    const el = $("share-status");
    clearTimeout(statusTimer);
    el.textContent = text || "";
    if (text && clearAfterMs) {
      statusTimer = setTimeout(() => {
        el.textContent = "";
      }, clearAfterMs);
    }
  }

  function _routeName() {
    return $("route-name").value.trim() || "Untitled route";
  }

  function _resetDialog() {
    _setStatus("");
    $("share-link").value = "";
    $("share-link").parentElement.classList.remove("hidden"); // the <label> around the field
    $("share-qr-wrap").classList.remove("hidden");
    $("share-qr-fallback").classList.add("hidden");
    $("share-long-hint").classList.add("hidden");
    $("share-long-hint").textContent = "";
    $("share-copy").disabled = true;
    $("share-send").classList.add("hidden");
  }

  async function _openDialog() {
    const seq = ++openSeq;
    lastFocus = document.activeElement;
    _resetDialog();
    $("share-dialog").classList.remove("hidden");
    $("share-copy").focus();

    const route = {
      name: _routeName(),
      waypoints: KPR.waypoints.getSaveData(),
      scenes: KPR.scenes.getSaveData(),
      // The planner's vehicle list travels with the route (absent when empty).
      vehicles: KPR.evaluation.getVehicles(),
    };

    let link;
    try {
      link = KPR.codec.buildLink(await KPR.codec.encode(route));
    } catch (err) {
      if (seq !== openSeq) return;
      // Too many stops/scenes or too much text to fit in a link.
      $("share-qr-wrap").classList.add("hidden");
      $("share-link").parentElement.classList.add("hidden");
      _setStatus(TOO_BIG_MSG);
      return;
    }
    if (seq !== openSeq) return;

    $("share-link").value = link;
    $("share-copy").disabled = false;

    const qr = buildQr(link);
    if (qr) {
      drawQr($("share-qr"), qr);
    } else {
      $("share-qr-wrap").classList.add("hidden");
      $("share-qr-fallback").classList.remove("hidden");
    }

    if (link.length > LONG_LINK_CHARS) {
      const hint = $("share-long-hint");
      hint.textContent = LONG_LINK_HINT;
      hint.classList.remove("hidden");
    }
    if (typeof navigator.share === "function") $("share-send").classList.remove("hidden");
  }

  function _closeDialog() {
    openSeq++;
    clearTimeout(statusTimer);
    $("share-dialog").classList.add("hidden");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    lastFocus = null;
  }

  function _isDialogOpen() {
    return !$("share-dialog").classList.contains("hidden");
  }

  /** Last-resort copy for browsers/contexts without the async clipboard API. */
  function _legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // 16px stops iOS zooming in; fixed + transparent keeps it out of the way.
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px;";
    document.body.appendChild(ta);
    let ok = false;
    try {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  /** Copy `text` to the clipboard: the async clipboard API where the page
   * allows it, else the legacy fallback. Resolves true when it worked. */
  async function copyText(text) {
    let copied = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function" && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (err) {
        copied = false;
      }
    }
    if (!copied) copied = _legacyCopy(text);
    return copied;
  }

  async function _copyLink() {
    const field = $("share-link");
    const link = field.value;
    if (!link) return;
    const copied = await copyText(link);
    if (copied) {
      _setStatus("Link copied", 2500);
    } else {
      field.focus();
      field.select();
      field.setSelectionRange(0, link.length);
      _setStatus("Press and hold the link to copy it");
    }
  }

  async function _sendLink() {
    const url = $("share-link").value;
    if (!url || typeof navigator.share !== "function") return;
    const name = _routeName().slice(0, 80);
    try {
      await navigator.share({ title: `KPR route: ${name}`, text: `KPR route: ${name}`, url });
    } catch (err) {
      if (err && err.name === "AbortError") return; // user closed the share sheet
      _setStatus("Couldn't open the share sheet. Use Copy link.");
    }
  }

  /** Keep Tab inside the open dialog. */
  function _trapTab(e) {
    const items = Array.from($("share-dialog").querySelectorAll("button, input"))
      .filter((el) => !el.disabled && el.getClientRects().length > 0);
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

  /** Enable/disable the Share button to match the stop count. It stays
   * clickable when "disabled" so it can explain what's missing. */
  function syncButton() {
    const btn = $("share-route");
    if (!btn) return;
    const enough = KPR.waypoints.count() >= 2;
    btn.setAttribute("aria-disabled", enough ? "false" : "true");
    btn.title = enough ? "Share this route as a link or QR code" : "Add at least 2 stops to share";
  }

  function init() {
    $("share-route").addEventListener("click", () => {
      if (KPR.waypoints.count() < 2) {
        alert("Add at least 2 stops to share a route.");
        return;
      }
      _openDialog();
    });
    $("share-close").addEventListener("click", _closeDialog);
    $("share-dialog").addEventListener("click", (e) => {
      if (e.target === $("share-dialog")) _closeDialog(); // backdrop, not the box
    });
    document.addEventListener("keydown", (e) => {
      if (!_isDialogOpen()) return;
      if (e.key === "Escape") _closeDialog();
      else if (e.key === "Tab") _trapTab(e);
    });
    $("share-link").addEventListener("focus", (e) => e.target.select());
    $("share-copy").addEventListener("click", _copyLink);
    $("share-send").addEventListener("click", _sendLink);
    window.addEventListener("hashchange", loadFromHash);
    syncButton();
  }

  // ---------------------------------------------------------------------
  // Opening a shared route
  // ---------------------------------------------------------------------

  /** Drop #r=... from the address so a reload or the back button doesn't
   * re-open the route. Keeps the path and any query string. */
  function _clearHash() {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (err) {
      // Nothing useful to do; the route is loaded either way.
    }
  }

  /**
   * If the address holds a share link, decode and validate it, then load it.
   * Order matters: validate first (don't prompt about junk), confirm before
   * replacing existing stops, wait for the map style, then applyRoute. The
   * hash is removed in every outcome.
   */
  async function loadFromHash() {
    if (loading) return;
    let encoded;
    try {
      encoded = KPR.codec.parseHash(location.hash);
    } catch (err) {
      _clearHash();
      alert(BAD_LINK_MSG);
      return;
    }
    if (encoded === null) return; // some other hash, not ours

    loading = true;
    const status = $("route-status");
    const previousStatus = status.textContent;
    let applied = false;
    try {
      status.textContent = "Opening shared route…";

      let route;
      try {
        route = await KPR.codec.decode(encoded);
      } catch (err) {
        alert(err && err.code === "unsupported" ? UNSUPPORTED_MSG : BAD_LINK_MSG);
        return;
      }

      if (KPR.waypoints.count() > 0 &&
          !confirm("Open this shared route? It will replace the stops and scenes you have now.")) {
        return;
      }

      if (!(await KPR.map.whenStyleReady())) {
        alert("The map is still loading. Reload the page and open the link again.");
        return;
      }

      applied = true;
      const result = await KPR.storage.applyRoute(route);
      if (!result.ok) {
        alert("The stops loaded, but the route couldn't be calculated. Check your connection and try Recalculate.");
      } else if (result.scenesSkipped > 0) {
        const n = result.scenesSkipped;
        alert(`${n} scene${n === 1 ? "" : "s"} couldn't be placed on the route.`);
      }
    } catch (err) {
      console.error("Failed to open shared route:", err);
      alert(applied ? "Something went wrong while opening the shared route." : BAD_LINK_MSG);
    } finally {
      // Routing writes its own status once a route is applied; otherwise put
      // back whatever the status said before.
      if (!applied) status.textContent = previousStatus;
      _clearHash();
      loading = false;
    }
  }

  return {
    init,
    syncButton,
    loadFromHash,
    buildQr,
    drawQr,
    clearHash: _clearHash,
    copyText,
    LONG_LINK_CHARS,
    longLinkHint: LONG_LINK_HINT,
  };
})();
