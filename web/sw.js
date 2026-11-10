// Service worker: caches the whole app (including the recipe data) so it works with no signal.
// VERSION is stamped with the commit id by the GitHub Pages workflow; bump it by hand if you
// deploy some other way, otherwise phones keep the old cached copy.
const VERSION = 'dev';
const CACHE = `recipelib-${VERSION}`;
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/units.js', 'js/unitdata.js', 'js/groups.js', 'js/linkdata.js', 'js/webimport.js', 'js/qr.js', 'js/model.js', 'js/store.js', 'js/ui.js', 'js/timers.js', 'js/config.js', 'js/cloud.js', 'js/account.js', 'js/photos.js', 'js/shopping.js', 'js/aisledata.js', 'js/planner.js', 'js/pantry.js', 'js/collections.js',
  'data/recipes.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // 'reload' skips the browser's own HTTP cache so a new version never installs from stale copies
  event.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(ASSETS.map((a) => c.add(new Request(a, { cache: 'reload' })))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('recipelib-') && k !== CACHE && k !== 'recipelib-fonts').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'GET' && (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com')) {
    // web fonts: serve the saved copy right away and refresh it quietly; kept across app versions
    event.respondWith((async () => {
      const cache = await caches.open('recipelib-fonts');
      const saved = await cache.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => null);
      return saved || (await fresh) || Response.error();
    })());
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
      throw err;
    }
  })());
});
