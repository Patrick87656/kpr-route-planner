/**
 * open-link.test.js - the "Open a shared link" paste dialog (js/open-link.js).
 *
 * The module pulls a "#r=..." / "#res=..." fragment out of pasted text and
 * sets location.hash, leaving all validation to the existing loaders. So the
 * tests cover (1) the pure extractor against messy and hostile pastes and
 * (2) the dialog wiring: a good paste sets the address fragment, a bad one
 * does not, and pasted text is never turned into HTML.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const O = KPR.openLink;

  // The real share/results hashchange handlers are wired by other test files
  // and would try to decode and apply anything we set. For the dialog tests we
  // only want to see WHAT hash got set, so capture it and put the address back.
  function captureHashSet(fn) {
    const seen = [];
    // The event's newURL is the address AT the moment of the change. Reading
    // location.hash instead would show what is left after the real share /
    // results handlers have already processed and cleared it.
    const onChange = (e) => {
      const i = e.newURL.indexOf("#");
      seen.push(i === -1 ? "" : e.newURL.slice(i));
    };
    window.addEventListener("hashchange", onChange);
    // Make the real loaders ignore this: they only act on a decodable link.
    const origAlert = window.alert;
    const origConfirm = window.confirm;
    window.alert = () => {};
    window.confirm = () => false;
    return Promise.resolve(fn())
      .then(() => new Promise((r) => setTimeout(r, 60)))
      .finally(() => {
        window.removeEventListener("hashchange", onChange);
        window.alert = origAlert;
        window.confirm = origConfirm;
        history.replaceState(null, "", location.pathname + location.search);
      })
      .then(() => seen);
  }

  function reset() {
    $("open-link-dialog").classList.add("hidden");
    $("open-link-input").value = "";
    $("open-link-msg").textContent = "";
    $("open-link-msg").classList.add("hidden");
  }

  O.init(); // wire the dialog once, like the app does

  // ---- extractHash ----------------------------------------------------

  test("open-link: a full route URL gives its #r= fragment", () => {
    assert.equal(O.extractHash("https://patrick87656.github.io/kpr-route-planner/#r=dABC_-123"), "#r=dABC_-123");
  });

  test("open-link: a results link gives its #res= fragment (not read as #r)", () => {
    assert.equal(O.extractHash("https://x.test/kpr/index.html#res=pXYZ-9_"), "#res=pXYZ-9_");
  });

  test("open-link: a bare fragment works", () => {
    assert.equal(O.extractHash("#r=dAAAA"), "#r=dAAAA");
  });

  test("open-link: words and line breaks around the link are ignored", () => {
    const pasted = "Here is the route for Friday:\nhttps://h.test/kpr/#r=dQWER_1\nSee you there!";
    assert.equal(O.extractHash(pasted), "#r=dQWER_1");
  });

  test("open-link: trailing punctuation is not pulled into the link", () => {
    assert.equal(O.extractHash("open https://h.test/#r=dAB12)."), "#r=dAB12");
    assert.equal(O.extractHash('"https://h.test/#res=pCD34",'), "#res=pCD34");
  });

  test("open-link: a link from another host or path still opens (only the fragment matters)", () => {
    assert.equal(O.extractHash("http://localhost:8000/index.html?beta=1#r=dLOCAL"), "#r=dLOCAL");
  });

  test("open-link: text with no link, or an empty paste, gives null", () => {
    ["", "   ", "hello world", "https://h.test/", "r=dAB", "#x=dAB", "#r=", "#res=", "#r=!!!"].forEach((s) => {
      assert.equal(O.extractHash(s), null, JSON.stringify(s));
    });
  });

  test("open-link: non-strings give null", () => {
    [null, undefined, 42, {}, []].forEach((v) => assert.equal(O.extractHash(v), null));
  });

  test("open-link: an absurdly long paste is refused before anything is done with it", () => {
    assert.equal(O.extractHash("#r=" + "A".repeat(200000)), null);
    assert.equal(O.extractHash("x".repeat(200000)), null);
  });

  test("open-link: markup and script text in a paste never survive into the result", () => {
    const hostile = '<img src=x onerror="window.__pwned=1">#r=dOK12<script>alert(1)</script>';
    const out = O.extractHash(hostile);
    assert.equal(out, "#r=dOK12");
    assert.ok(!/[<>"' ()]/.test(out), "only base64url characters remain");
  });

  // ---- dialog ---------------------------------------------------------

  test("open-link: the button opens the dialog with an empty box", () => {
    // (Focus can't be asserted here: the harness keeps the whole skeleton in
    // a hidden container, where browsers refuse focus. It is checked in the
    // real-browser run instead.)
    reset();
    $("open-link-input").value = "old text";
    $("open-link-btn").click();
    assert.ok(!$("open-link-dialog").classList.contains("hidden"));
    assert.equal($("open-link-input").value, "");
    reset();
  });

  test("open-link: Cancel, the backdrop and Escape all close it", () => {
    reset();
    $("open-link-btn").click();
    $("open-link-close").click();
    assert.ok($("open-link-dialog").classList.contains("hidden"), "Cancel");

    $("open-link-btn").click();
    $("open-link-dialog").click(); // backdrop = the dialog element itself
    assert.ok($("open-link-dialog").classList.contains("hidden"), "backdrop");

    $("open-link-btn").click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    assert.ok($("open-link-dialog").classList.contains("hidden"), "Escape");
    reset();
  });

  test("open-link: a good paste closes the dialog and sets the address fragment", async () => {
    reset();
    $("open-link-btn").click();
    $("open-link-input").value = "see https://h.test/kpr/#r=dGOOD_LINK1 thanks";
    const seen = await captureHashSet(() => $("open-link-go").click());
    assert.ok($("open-link-dialog").classList.contains("hidden"), "dialog closed");
    assert.deepEqual(seen, ["#r=dGOOD_LINK1"], "hash set exactly once, to the extracted fragment");
  });

  test("open-link: a results link paste sets #res=", async () => {
    reset();
    $("open-link-btn").click();
    $("open-link-input").value = "#res=pRESULT_1";
    const seen = await captureHashSet(() => $("open-link-go").click());
    assert.deepEqual(seen, ["#res=pRESULT_1"]);
  });

  test("open-link: pasting the same link twice still opens it again", async () => {
    reset();
    history.replaceState(null, "", location.pathname + location.search + "#r=dSAME_1");
    $("open-link-btn").click();
    $("open-link-input").value = "#r=dSAME_1";
    const seen = await captureHashSet(() => $("open-link-go").click());
    assert.deepEqual(seen, ["#r=dSAME_1"], "a hashchange still fires when the fragment is unchanged");
  });

  test("open-link: a bad paste shows a plain-text message, keeps the dialog open and sets nothing", async () => {
    reset();
    $("open-link-btn").click();
    $("open-link-input").value = "this is not a link";
    const seen = await captureHashSet(() => $("open-link-go").click());
    assert.deepEqual(seen, [], "no hashchange");
    assert.ok(!$("open-link-dialog").classList.contains("hidden"), "stays open to try again");
    assert.ok(!$("open-link-msg").classList.contains("hidden"), "message shown");
    assert.ok($("open-link-msg").textContent.length > 10);
    reset();
  });

  test("open-link: typing clears the error message", () => {
    reset();
    $("open-link-btn").click();
    $("open-link-input").value = "nope";
    $("open-link-go").click();
    assert.ok(!$("open-link-msg").classList.contains("hidden"));
    $("open-link-input").dispatchEvent(new Event("input"));
    assert.ok($("open-link-msg").classList.contains("hidden"));
    reset();
  });

  test("open-link: hostile pasted text is shown as plain text and runs nothing", async () => {
    reset();
    window.__pwned = undefined;
    $("open-link-btn").click();
    $("open-link-input").value = '<img src=x onerror="window.__pwned=1"><b>x</b>';
    await captureHashSet(() => $("open-link-go").click());
    assert.equal(window.__pwned, undefined, "nothing executed");
    assert.equal($("open-link-msg").querySelector("img, b, script"), null, "message holds no elements");
    assert.equal($("open-link-dialog").querySelector("img"), null, "no injected image");
    reset();
  });

  test("open-link: Paste fills the box from the clipboard and reports an unusable clipboard", async () => {
    reset();
    const real = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: () => Promise.resolve("copied https://h.test/#r=dCLIP_1") },
      });
      $("open-link-btn").click();
      $("open-link-paste").click();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal($("open-link-input").value, "copied https://h.test/#r=dCLIP_1");
      assert.ok($("open-link-msg").classList.contains("hidden"), "a usable link shows no error");

      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: () => Promise.reject(new Error("denied")) },
      });
      $("open-link-input").value = "";
      $("open-link-paste").click();
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(!$("open-link-msg").classList.contains("hidden"), "a blocked clipboard explains what to do");
      assert.ok($("open-link-msg").textContent.toLowerCase().includes("paste"));
    } finally {
      if (real) Object.defineProperty(navigator, "clipboard", real);
      else delete navigator.clipboard;
      reset();
    }
  });
})();
