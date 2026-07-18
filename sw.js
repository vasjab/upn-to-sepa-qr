/*
 * Service worker — offline capability WITHOUT staleness.
 *
 * Strategy:
 *  - Navigations / HTML  → network-first (always fresh app shell when online;
 *    cached copy only as an offline fallback). This is what keeps updates from
 *    getting "stuck" the way a naive cache-first SW would.
 *  - Other same-origin assets → cache-first (they're versioned via ?v=, so a new
 *    release requests new URLs the cache doesn't have yet and fetches them fresh).
 *  - Cross-origin requests are never touched.
 *
 * Bump VERSION on each release to roll the cache; old caches are pruned on activate.
 * skipWaiting + clients.claim make a new worker take over immediately.
 */
var VERSION = 'v10';
var CACHE = 'upn-sepa-' + VERSION;
var CORE = [
  './', './index.html',
  './styles.css?v=10', './convert.js?v=10', './app.js?v=10',
  './vendor/jsQR.js', './vendor/qrcode-generator.js',
  './manifest.webmanifest', './og.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // Don't let one missing asset fail the whole install.
    return Promise.all(CORE.map(function (u) {
      return c.add(u).catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('upn-sepa-') === 0 && k !== CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return; // ignore cross-origin

  var isNav = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isNav) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (m) { return m || caches.match('./index.html'); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (m) {
      return m || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      });
    })
  );
});
