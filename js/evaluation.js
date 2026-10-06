/**
 * evaluation.js — the planner's "Evaluation setup" section and the vehicle
 * picker shown when a drive starts.
 *
 * Planning happens on a PC: the organizer types the vehicles that will be
 * evaluated (one per line). The list travels with the route (saved file,
 * share link), so the evaluator who opens the route on a phone or iPad picks
 * their vehicle from a drop-down instead of typing it.
 *
 * Everything here is behind KPR.beta: the section stays hidden and the drive
 * never asks for a vehicle unless the beta switch is on (see beta.js and the
 * check in drive.js).
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

  /** Show the Evaluation setup section (only when the beta switch is on) and
   * wire its controls. */
  function init() {
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
    if (KPR.beta.isOn()) section.classList.remove("hidden");
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

  return {
    init,
    getVehicles,
    setVehicles,
    useLastList,
    renderVehicleOptions,
    openVehicleDialog,
    isVehicleDialogOpen,
  };
})();
