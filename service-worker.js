/**
 * service-worker.js — makes the app installable and lets its shell load
 * instantly (and survive flaky signal) by caching the local files.
 *
 * Scope: caches ONLY the app's own files (same-origin). It deliberately does
 * NOT cache Mapbox requests -- tiles, the Directions/Search APIs, and the GL
 * JS bundle must stay live: a stale cached route or search result would be
 * wrong, and tiles would bloat storage fast. Anything not in the app shell
 * just goes to the network as normal.
 *
 * CACHE_VERSION: the GitHub Pages deploy workflow replaces "kpr-dev" with
 * the commit id, so every deploy gets a fresh cache (the activate handler
 * deletes old ones). Keep the literal "kpr-dev" here -- the workflow checks
 * that its stamp landed.
 */
const CACHE_VERSION = "kpr-dev";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/ocean-lut.js",
  "./js/map.js",
  "./js/waypoints.js",
  "./js/routing.js",
  "./js/scenes.js",
  "./js/vendor/qrcodegen-v1.8.0-es5.js",
  "./js/route-codec.js",
  "./js/beta.js",
  "./js/ratings.js",
  "./js/search.js",
  "./js/storage.js",
  "./js/share.js",
  "./js/open-link.js",
  "./js/evaluation.js",
  "./js/drive.js",
  "./js/results.js",
  "./js/sheet.js",
  "./js/app.js",
  "./config.local.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // addAll fails the whole install if any file 404s; add individually
      // and ignore misses so a renamed/absent optional file (e.g. a missing
      // config.local.js) doesn't block install.
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn("SW: skip caching", url, err && err.message))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Not our file (Mapbox tiles/APIs/CDN, Google Fonts, etc.) -> straight to
  // the network, never cached here.
  if (!sameOrigin) return;

  // App shell: serve from cache first for instant loads, fall back to the
  // network, and refresh the cache copy in the background when online.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fromNet = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // offline and not cached -> undefined
      return cached || fromNet;
    })
  );
});
