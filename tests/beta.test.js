/**
 * beta.test.js — the ?beta=1 / ?beta=0 switch. Fake location/history objects
 * are passed in, so the real address bar is never touched.
 */

(function () {
  // A fake location + history pair that records replaceState calls.
  function fakeEnv(search, hash) {
    const calls = [];
    return {
      loc: { search, hash: hash || "", pathname: "/app/index.html" },
      hist: { replaceState: (state, title, url) => calls.push(url) },
      calls,
    };
  }

  // Make Storage reads/writes throw, run fn, then put the originals back.
  function withThrowingStorage(fn) {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error("storage blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("storage blocked");
    };
    try {
      fn();
    } finally {
      Storage.prototype.getItem = getItem;
      Storage.prototype.setItem = setItem;
    }
  }

  function reset() {
    KPR.beta.set(false);
    try {
      localStorage.removeItem("kprBeta");
    } catch (err) {
      /* ignore */
    }
  }

  // Must stay first: nothing has set the flag yet, so this is the shipped default.
  test("beta: on by default (shipped default DEFAULT_ON=true)", () => {
    try {
      localStorage.removeItem("kprBeta");
    } catch (err) {
      /* ignore */
    }
    assert.equal(KPR.beta.isOn(), true);
  });

  test("beta: ?beta=1 turns it on, removes the param, keeps the #fragment and other params", () => {
    const env = fakeEnv("?beta=1&keep=yes", "#r=dABC");
    KPR.beta.initFromUrl(env.loc, env.hist);
    assert.equal(KPR.beta.isOn(), true);
    assert.deepEqual(env.calls, ["/app/index.html?keep=yes#r=dABC"]);
    assert.equal(localStorage.getItem("kprBeta"), "1", "remembered on the device");
    reset();
  });

  test("beta: ?beta=1 alone leaves no stray '?'", () => {
    const env = fakeEnv("?beta=1", "#res=pXYZ");
    KPR.beta.initFromUrl(env.loc, env.hist);
    assert.deepEqual(env.calls, ["/app/index.html#res=pXYZ"]);
    reset();
  });

  test("beta: ?beta=0 turns it off even when it was on", () => {
    KPR.beta.set(true);
    assert.equal(KPR.beta.isOn(), true);
    const env = fakeEnv("?beta=0&x=1");
    KPR.beta.initFromUrl(env.loc, env.hist);
    assert.equal(KPR.beta.isOn(), false);
    assert.equal(localStorage.getItem("kprBeta"), "0");
    assert.deepEqual(env.calls, ["/app/index.html?x=1"]);
    reset();
  });

  test("beta: a junk value is ignored and left in the address", () => {
    ["?beta=2", "?beta=true", "?beta=", "?beta=1%20", "?other=1"].forEach((search) => {
      // Pin the flag off first so this tests ONLY that a junk value changes
      // nothing -- it must not depend on the shipped default (now on).
      KPR.beta.set(false);
      const env = fakeEnv(search, "#r=dABC");
      KPR.beta.initFromUrl(env.loc, env.hist);
      assert.equal(KPR.beta.isOn(), false, search);
      assert.equal(env.calls.length, 0, `${search} must not rewrite the address`);
    });
    reset();
  });

  test("beta: throwing storage falls back to memory and never throws", () => {
    withThrowingStorage(() => {
      // reads survive even though every storage access throws
      KPR.beta.isOn();
      // a value set during the page's life is held in memory, since it
      // couldn't be written to storage
      KPR.beta.set(false);
      assert.equal(KPR.beta.isOn(), false, "memory holds a set value");
      KPR.beta.set(true);
      assert.equal(KPR.beta.isOn(), true, "memory holds the value");
      const env = fakeEnv("?beta=0");
      KPR.beta.initFromUrl(env.loc, env.hist);
      assert.equal(KPR.beta.isOn(), false);
    });
    reset();
  });

  test("beta: a throwing replaceState does not break the flag", () => {
    const loc = { search: "?beta=1", hash: "", pathname: "/" };
    const hist = {
      replaceState() {
        throw new Error("nope");
      },
    };
    KPR.beta.initFromUrl(loc, hist);
    assert.equal(KPR.beta.isOn(), true);
    reset();
  });
})();
