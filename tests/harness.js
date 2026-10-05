/**
 * harness.js — a tiny dependency-free test runner for tests/run.html.
 *
 * Usage in a *.test.js file:
 *   test("does a thing", () => { assert.equal(1 + 1, 2); });
 *   test("async thing", async () => { await assert.rejects(somePromise); });
 *
 * After all tests have run it writes the report into <pre id="results">,
 * ending with `RESULT: PASS (N tests)` or `RESULT: FAIL (k of N)`, and sets
 * document.body.dataset.done so tests/run-tests.ps1 (which dumps the DOM of
 * a headless browser) can tell the run finished.
 */
(function () {
  const tests = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  function _fail(message) {
    const err = new Error(message);
    err.isAssertion = true;
    throw err;
  }

  function _show(v) {
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }

  function _deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && _deepEqual(a[k], b[k]));
  }

  const assert = {
    equal(actual, expected, msg) {
      if (!Object.is(actual, expected)) {
        _fail(`${msg || "equal"}: expected ${_show(expected)}, got ${_show(actual)}`);
      }
    },
    deepEqual(actual, expected, msg) {
      if (!_deepEqual(actual, expected)) {
        _fail(`${msg || "deepEqual"}: expected ${_show(expected)}, got ${_show(actual)}`);
      }
    },
    ok(value, msg) {
      if (!value) _fail(msg || `expected a truthy value, got ${_show(value)}`);
    },
    /** fn must throw; optional `match` is a substring of the error message. */
    throws(fn, match, msg) {
      try {
        fn();
      } catch (err) {
        if (match && !String(err && err.message).includes(match)) {
          _fail(`${msg || "throws"}: message ${_show(err && err.message)} does not include ${_show(match)}`);
        }
        return;
      }
      _fail(msg || "throws: expected the function to throw");
    },
    /** Takes a promise or a function returning one; it must reject. */
    async rejects(promiseOrFn, match, msg) {
      try {
        await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
      } catch (err) {
        if (match && !String(err && err.message).includes(match)) {
          _fail(`${msg || "rejects"}: message ${_show(err && err.message)} does not include ${_show(match)}`);
        }
        return;
      }
      _fail(msg || "rejects: expected the promise to reject");
    },
  };

  async function run() {
    const out = document.getElementById("results");
    const lines = [];
    const failed = [];

    for (const t of tests) {
      try {
        await t.fn();
        lines.push(`ok   - ${t.name}`);
      } catch (err) {
        failed.push(t.name);
        lines.push(`FAIL - ${t.name}`);
        lines.push(`       ${err && err.message ? err.message : err}`);
      }
    }

    lines.push("");
    if (tests.length === 0) {
      // A page that loaded no tests must not look like a pass.
      lines.push("RESULT: FAIL (no tests ran)");
    } else if (failed.length === 0) {
      lines.push(`RESULT: PASS (${tests.length} tests)`);
    } else {
      lines.push(`RESULT: FAIL (${failed.length} of ${tests.length}): ${failed.join("; ")}`);
    }
    out.textContent = lines.join("\n");
    document.body.dataset.done = "1";
  }

  window.test = test;
  window.assert = assert;

  window.addEventListener("error", (e) => {
    // A script that failed to load/parse should surface in the report.
    const out = document.getElementById("results");
    if (out && !document.body.dataset.done) {
      out.dataset.errors = (out.dataset.errors || "") + (e.message || "script error") + "\n";
    }
  });

  window.addEventListener("load", () => {
    run().catch((err) => {
      document.getElementById("results").textContent = `RESULT: FAIL (harness error: ${err && err.message})`;
      document.body.dataset.done = "1";
    });
  });
})();
