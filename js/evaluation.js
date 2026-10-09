/**
 * evaluation.js — the planner's "Evaluation setup" section and the vehicle
 * picker shown when a drive starts.
 *
 * Planning happens on a PC: the organizer types the vehicles that will be
 * evaluated (one per line). The list travels with the route (saved file,
 * share link), so the evaluator who opens the route on a phone or iPad picks
 * their vehicle from a drop-down instead of typing it.
 *
 * The setup section is hidden only on phone-sized screens (routes are set up
 * on a PC/iPad); the vehicle list still loads with a route, so Start drive on
 * a phone offers the picker.
 *
 * Vehicle names can come from a file or a link, so they only ever reach the
 * page through .value / .textContent / createElement (no innerHTML).
 *
 * No DOM access at load time; init() and the dialog wire themselves on first
 * use.
 */
window.KPR = window.KPR || {};

KPR.evaluation = (function () {
  const MAX_EVALUATOR = 60;
  const PLACEHOLDER_TEXT = "Select vehicle";
  const DEFAULT_HINT = "One vehicle per line. Evaluators pick theirs from this list when they start a drive.";

  const $ = (id) => document.getElementById(id);

  let setupWired = false;
  let dialogWired = false;
  let dialogState = null; // {vehicles, onStart, lastFocus} while the dialog is open

  // ---------------------------------------------------------------------
  // Planner section: the vehicle list
  // ---------------------------------------------------------------------

  /** The vehicles typed in the planner, cleaned up. [] when there are none
   * (or the section is not on the page). */
  function getVehicles() {
    const box = $("eval-vehicles");
    return box ? KPR.codec.normalizeVehicles(box.value) : [];
  }

  /** True when `text` holds more distinct, usable names than `kept` has, i.e.
   * the 30-name limit cut something off. Uses the codec for the per-line
   * cleanup so the two can't disagree about what a name is. */
  function _wasCut(text, kept) {
    const have = new Set(kept.map((n) => n.toLowerCase()));
    return String(text)
      .split(/\r\n|\r|\n/)
      .some((line) => {
        const name = KPR.codec.normalizeVehicles([line])[0];
        return name !== undefined && !have.has(name.toLowerCase());
      });
  }

  function _setHint(text) {
    const el = $("eval-vehicles-hint");
    if (el) el.textContent = text;
  }

  function _countHint(list, cut) {
    if (list.length === 0) return DEFAULT_HINT;
    const n = list.length;
    const base = `${n} vehicle${n === 1 ? "" : "s"}.`;
    return cut ? `${base} Only the first ${n} were kept.` : base;
  }

  /** Replace the box content with `list` (an array or text). Does not touch
   * the remembered "last list". Does nothing when the box is not on the
   * page. */
  function setVehicles(list) {
    const box = $("eval-vehicles");
    if (!box) return;
    const clean = KPR.codec.normalizeVehicles(list);
    box.value = clean.join("\n");
    _setHint(_countHint(clean, false));
  }

  /** Fill the box from the list typed on this device last time. Returns
   * whether there was one. */
  function useLastList() {
    const last = KPR.ratings.getVehicleList();
    if (last.length === 0) {
      _setHint("No earlier list found on this device.");
      return false;
    }
    setVehicles(last);
    return true;
  }

  function _onInput() {
    // Remember what was typed (only ever a non-empty list) so "Use my last
    // list" has something to offer next time.
    const list = getVehicles();
    if (list.length > 0) KPR.ratings.setVehicleList(list);
  }

  function _onChange() {
    const box = $("eval-vehicles");
    const list = KPR.codec.normalizeVehicles(box.value);
    const cut = _wasCut(box.value, list);
    box.value = list.join("\n");
    _setHint(_countHint(list, cut));
  }

  /** Show the Evaluation setup section and wire its controls. (Hidden only on
   * phone-sized screens via CSS; routes are set up on a PC/iPad.) */
  function _initSetup() {
    const section = $("eval-setup");
    const box = $("eval-vehicles");
    if (!section || !box) return;
    if (!setupWired) {
      setupWired = true;
      box.addEventListener("input", _onInput);
      box.addEventListener("change", _onChange);
      const btn = $("eval-use-last");
      if (btn) btn.addEventListener("click", useLastList);
    }
    section.classList.remove("hidden");
  }

  // ---------------------------------------------------------------------
  // Vehicle picker dialog
  // ---------------------------------------------------------------------

  /** Fill a <select> with a disabled "Select vehicle" placeholder followed by
   * one option per vehicle. The option value is the list position (a number
   * as text), never the name, so a name can't carry anything into an
   * attribute. */
  function renderVehicleOptions(selectEl, vehicles) {
    selectEl.replaceChildren();
    const ph = document.createElement("option");
    ph.value = "";
    ph.disabled = true;
    ph.selected = true;
    ph.textContent = PLACEHOLDER_TEXT;
    selectEl.appendChild(ph);
    (Array.isArray(vehicles) ? vehicles : []).forEach((name, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = String(name);
      selectEl.appendChild(opt);
    });
    selectEl.value = "";
  }

  function isVehicleDialogOpen() {
    return dialogState !== null;
  }

  function _syncStart() {
    $("vehicle-start").disabled = $("vehicle-select").value === "";
  }

  function _closeDialog() {
    if (!dialogState) return;
    const { lastFocus } = dialogState;
    dialogState = null;
    $("vehicle-dialog").classList.add("hidden");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function _cleanEvaluator(text) {
    return String(text || "")
      .replace(/[\u0000-\u001F]/g, "")
      .trim()
      .slice(0, MAX_EVALUATOR);
  }

  function _startFromDialog() {
    if (!dialogState) return;
    const { vehicles, onStart } = dialogState;
    const idx = Number($("vehicle-select").value);
    if ($("vehicle-select").value === "" || !Number.isInteger(idx) || idx < 0 || idx >= vehicles.length) return;
    const evaluator = _cleanEvaluator($("evaluator-name").value);
    KPR.ratings.setEvaluator(evaluator);
    const choice = { vehicle: vehicles[idx], evaluator };
    _closeDialog();
    if (typeof onStart === "function") onStart(choice);
  }

  function _trapTab(e) {
    const items = Array.from($("vehicle-dialog").querySelectorAll("select, input, button"))
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

  function _wireDialog() {
    if (dialogWired) return;
    dialogWired = true;
    $("vehicle-select").addEventListener("change", _syncStart);
    $("vehicle-start").addEventListener("click", _startFromDialog);
    $("vehicle-cancel").addEventListener("click", _closeDialog);
    $("vehicle-dialog").addEventListener("click", (e) => {
      if (e.target === $("vehicle-dialog")) _closeDialog(); // backdrop, not the box
    });
    document.addEventListener("keydown", (e) => {
      if (!dialogState) return;
      if (e.key === "Escape") _closeDialog();
      else if (e.key === "Tab") _trapTab(e);
    });
  }

  /**
   * Ask which vehicle this drive is in. `vehicles` is the list to offer,
   * `fingerprint` identifies the route (its last vehicle is preselected when
   * still listed) and `routeName` is shown as context. `onStart({vehicle,
   * evaluator})` runs only when Start is pressed; Cancel, Escape and a click
   * on the backdrop close the dialog without calling it. Returns false when a
   * dialog is already open (nothing changes), else true.
   */
  function openVehicleDialog({ vehicles, fingerprint, routeName } = {}, onStart) {
    if (dialogState) return false;
    _wireDialog();
    const list = Array.isArray(vehicles) ? vehicles.filter((v) => typeof v === "string") : [];
    dialogState = { vehicles: list, onStart, lastFocus: document.activeElement };

    const select = $("vehicle-select");
    renderVehicleOptions(select, list);
    // Match by string in JS (not by building a CSS selector from a name).
    const last = KPR.ratings.getLastVehicle(fingerprint);
    const at = last ? list.findIndex((v) => v === last) : -1;
    if (at !== -1) select.value = String(at);

    $("vehicle-dialog-route").textContent = routeName ? String(routeName) : "";
    $("evaluator-name").value = KPR.ratings.getEvaluator();
    _syncStart();
    $("vehicle-dialog").classList.remove("hidden");
    select.focus();
    return true;
  }

  // ---------------------------------------------------------------------
  // Send results
  // ---------------------------------------------------------------------
  //
  // A finished drive is sent as a #res= link through the device share sheet
  // (Teams, Outlook, AirDrop...), or copied when there is no share sheet.
  // iOS only allows navigator.share straight from a tap, and building the link
  // is async, so the link is built ahead of time (prepareLink) and sendResults
  // calls navigator.share with nothing awaited before it when it is ready.

  const SHARE_TEXT = "KPR evaluation results. Open on a PC to see the route and ratings.";
  const TITLE_PART_MAX = 80;

  let linkCache = null; // {key, result:{link, length}} for the latest session
  let linkPending = null; // {key, promise} while a build is running
  let sending = null; // promise of the send in progress (a second share() would throw)
  let sendWired = false;
  let sendState = null; // {lastFocus} while the send dialog is open

  /** What the link depends on. Same key = same link. */
  function _linkKey(session) {
    return [
      session.id,
      KPR.ratings.buildG(session),
      session.vehicle || "",
      session.evaluator || "",
      session.simulated ? 1 : 0,
    ].join("|");
  }

  /**
   * Build (or reuse) the results link for `session`. Resolves to
   * {link, length}; rejects with the codec's LinkError. The latest result is
   * kept, so calling this when a card is shown makes the next tap instant.
   */
  function prepareLink(session) {
    const key = _linkKey(session);
    if (linkCache && linkCache.key === key) return Promise.resolve(linkCache.result);
    if (linkPending && linkPending.key === key) return linkPending.promise;
    const promise = KPR.codec.encodeResults(session).then((encoded) => {
      const link = KPR.codec.buildResultsLink(encoded);
      const result = { link, length: link.length };
      if (linkPending && linkPending.key === key) linkPending = null;
      linkCache = { key, result };
      return result;
    });
    linkPending = { key, promise };
    promise.catch(() => {
      if (linkPending && linkPending.promise === promise) linkPending = null;
    });
    return promise;
  }

  /** Text for the title line of the share: "KPR results - <vehicle> - <route>". */
  function _shareTitle(session) {
    const parts = ["KPR results"];
    const veh = String(session.vehicle || "").trim().slice(0, TITLE_PART_MAX);
    if (veh) parts.push(veh);
    const route = String(session.routeName || "").trim().slice(0, TITLE_PART_MAX);
    parts.push(route || "Untitled route");
    return parts.join(" - ");
  }

  function _linkError(err) {
    const code = err && err.code;
    return code === "too-big" || code === "too-long"
      ? "These results are too big to send as a link."
      : "Could not build the results link.";
  }

  /** Show `message` plus the link length (and the long-link hint when
   * needed) in a status element. */
  function _writeStatus(el, message, length) {
    if (!el) return;
    const parts = [message];
    if (typeof length === "number") {
      parts.push(`Link length: ${length} characters.`);
      if (length > KPR.share.LONG_LINK_CHARS) parts.push(KPR.share.longLinkHint);
    }
    el.textContent = parts.filter(Boolean).join(" ");
    el.classList.remove("hidden");
  }

  // ---- send dialog (fallback when sharing/copying is not possible) ----

  function _closeSendDialog() {
    if (!sendState) return;
    const { lastFocus } = sendState;
    sendState = null;
    $("send-dialog").classList.add("hidden");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function _trapSendTab(e) {
    const items = Array.from($("send-dialog").querySelectorAll("input, button"))
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

  function _selectSendLink() {
    const field = $("send-link");
    field.focus();
    field.select();
    field.setSelectionRange(0, field.value.length);
  }

  async function _copyFromDialog() {
    const link = $("send-link").value;
    if (!link) return;
    const copied = await KPR.share.copyText(link);
    if (copied) {
      _writeStatus($("send-status"), "Link copied. Paste it into Teams or an email.", link.length);
    } else {
      _selectSendLink();
      _writeStatus($("send-status"), "Press and hold the link to copy it.", link.length);
    }
  }

  function _wireSendDialog() {
    if (sendWired) return;
    sendWired = true;
    $("send-close").addEventListener("click", _closeSendDialog);
    $("send-copy").addEventListener("click", _copyFromDialog);
    $("send-dialog").addEventListener("click", (e) => {
      if (e.target === $("send-dialog")) _closeSendDialog(); // backdrop, not the box
    });
    document.addEventListener("keydown", (e) => {
      if (!sendState) return;
      if (e.key === "Escape") _closeSendDialog();
      else if (e.key === "Tab") _trapSendTab(e);
    });
  }

  function isSendDialogOpen() {
    return sendState !== null;
  }

  /** Show the link in the dialog so it can be copied by hand. */
  function _openSendDialog(result, message) {
    _wireSendDialog();
    if (!sendState) sendState = { lastFocus: document.activeElement };
    $("send-link").value = result.link;
    const hint = $("send-long-hint");
    if (result.length > KPR.share.LONG_LINK_CHARS) {
      hint.textContent = KPR.share.longLinkHint;
      hint.classList.remove("hidden");
    } else {
      hint.textContent = "";
      hint.classList.add("hidden");
    }
    _writeStatus($("send-status"), message, result.length);
    $("send-dialog").classList.remove("hidden");
    _selectSendLink();
  }

  /** Share or copy an already-built link. Everything up to navigator.share
   * is synchronous, so a warm tap keeps its user activation. */
  function _deliver(result, session, statusEl) {
    _writeStatus(statusEl, "", result.length);
    if (typeof navigator.share === "function") {
      let shared;
      try {
        shared = Promise.resolve(
          navigator.share({ title: _shareTitle(session), text: SHARE_TEXT, url: result.link })
        );
      } catch (err) {
        shared = Promise.reject(err);
      }
      return shared.then(
        () => undefined,
        (err) => {
          if (err && err.name === "AbortError") return; // the user closed the sheet
          _openSendDialog(result, "Could not open the share sheet. Copy the link below.");
        }
      );
    }
    return KPR.share.copyText(result.link).then((copied) => {
      if (copied) {
        _writeStatus(statusEl, "Link copied. Paste it into Teams or an email.", result.length);
      } else {
        _openSendDialog(result, "Press and hold the link to copy it.");
      }
    });
  }

  /**
   * Send the results of `session` (a fresh copy from KPR.ratings) through the
   * share sheet, else the clipboard, else a dialog. `statusEl` gets the
   * outcome. Call this straight from the tap handler. Returns a promise that
   * settles when the attempt is over (never rejects).
   */
  function sendResults(session, statusEl) {
    if (sending) return sending; // a second tap joins the attempt in progress
    if (!session) return Promise.resolve();
    const key = _linkKey(session);
    const done = () => {
      sending = null;
    };
    let p;
    if (linkCache && linkCache.key === key) {
      // Warm: nothing is awaited before navigator.share.
      p = _deliver(linkCache.result, session, statusEl);
    } else {
      _writeStatus(statusEl, "Preparing the link...");
      p = prepareLink(session).then(
        (result) => _deliver(result, session, statusEl),
        (err) => _writeStatus(statusEl, _linkError(err))
      );
    }
    sending = p.then(done, done);
    return sending;
  }

  // ---- planner card: "Last drive results" ----

  /** Fill `containerEl` with a short summary of a stored session. Pure DOM
   * building; every string goes in through textContent. */
  function renderLastResults(containerEl, session) {
    containerEl.replaceChildren();
    const add = (cls, text) => {
      const d = document.createElement("div");
      d.className = cls;
      d.textContent = text;
      containerEl.appendChild(d);
      return d;
    };
    const head = add("lr-vehicle", session.vehicle || "No vehicle");
    if (session.simulated) {
      const tag = document.createElement("span");
      tag.className = "lr-test";
      tag.textContent = "TEST";
      head.appendChild(tag);
    }
    add("lr-route", session.routeName || "Untitled route");
    add("lr-date", new Date(session.startedAt).toLocaleString());
    const c = KPR.ratings.countRatings(session);
    add("lr-counts", `${c.good} good, ${c.bad} bad, ${c.notRated} not rated`);
  }

  function _lastSession() {
    return KPR.ratings.lastNonEmpty();
  }

  /** Show or hide the planner card for the newest stored drive with ratings,
   * and build its link ahead of the tap. */
  function refreshLastResults() {
    const card = $("last-results");
    if (!card) return;
    const status = $("last-results-status");
    if (status) {
      status.textContent = "";
      status.classList.add("hidden");
    }
    const s = _lastSession();
    if (!s) {
      card.classList.add("hidden");
      return;
    }
    renderLastResults($("last-results-summary"), s);
    card.classList.remove("hidden");
    prepareLink(s).catch(() => {});
  }

  function _onLastSend() {
    const s = _lastSession();
    if (s) sendResults(s, $("last-results-status"));
  }

  function _onLastDelete() {
    const s = _lastSession();
    if (!s) return;
    if (!confirm("Delete these results from this device?")) return;
    KPR.ratings.deleteSession(s.id);
    refreshLastResults();
  }

  let lastWired = false;
  function _initLastResults() {
    if (!$("last-results")) return;
    if (!lastWired) {
      lastWired = true;
      $("last-results-send").addEventListener("click", _onLastSend);
      $("last-results-delete").addEventListener("click", _onLastDelete);
    }
    refreshLastResults();
  }

  return {
    init() {
      _initSetup();
      _initLastResults();
    },
    getVehicles,
    setVehicles,
    useLastList,
    renderVehicleOptions,
    openVehicleDialog,
    isVehicleDialogOpen,
    prepareLink,
    sendResults,
    isSendDialogOpen,
    renderLastResults,
    refreshLastResults,
  };
})();
