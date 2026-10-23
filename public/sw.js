// Radio Clyde service worker -- PWA installability + instant app shell.
//
// Strategy, stated plainly so the next reader doesn't have to reverse it:
//  - the app shell (page, css, js, logo, icons, manifest) is cached
//    PRECACHE-first and refreshed in the background on every fetch
//    (stale-while-revalidate): the page opens instantly and heals itself,
//    while app.js's own polling re-renders live data when the network
//    returns
//  - EVERYTHING else -- /stream (an infinite audio connection must never
//    be cached), /api/* (live data; app.js already renders explicit
//    offline states), /studio (owner's authenticated views) -- passes
//    straight through untouched, no caching, no auth interference
//
// The cache name carries a version; bumping it is the whole update story.
const VERSION = 'rc-pwa-v1';
const PRECACHE = [
  '/',
  '/app.js',
  '/style.css',
  '/logo.png',
  '/favicon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Live data and audio never touch the cache; the page's own error
  // rendering is the offline story for these, as it already is today.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/studio') || url.pathname === '/stream') return;

  // Stale-while-revalidate for the precached shell: serve the cached copy
  // immediately, refresh it in the background so the NEXT load is current.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(url.pathname === '/' ? '/' : url.pathname);
        const refresh = fetch(event.request)
          .then((res) => {
            if (res && res.ok) cache.put(url.pathname, res.clone());
            return res;
          })
          .catch(() => cached); // offline: the cached copy is the answer
        return cached || refresh;
      })
    );
  }
  // Non-shell same-origin GETs (dj-photos, /api/art under its own routes,
  // embed.html) pass through -- small, often uncacheable, not worth pinning.
});
