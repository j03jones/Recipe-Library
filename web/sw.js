// Service worker: caches the whole app (including the recipe data) so it works with no signal.
// VERSION is stamped with the commit id by the GitHub Pages workflow; bump it by hand if you
// deploy some other way, otherwise phones keep the old cached copy.
const VERSION = 'dev';
const CACHE = `recipelib-${VERSION}`;
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/units.js', 'js/unitdata.js', 'js/groups.js', 'js/model.js', 'js/store.js', 'js/ui.js', 'js/config.js', 'js/cloud.js', 'js/account.js',
  'fonts/poppins-Medium.woff', 'fonts/poppins-Bold.woff',
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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('recipelib-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
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
