// Radio Markec service worker -- PWA installability + instant app shell.
//
// Strategy, stated plainly so the next reader doesn't have to reverse it:
//  - the app shell (page, css, js, logo, icons, manifest) is cached
//    PRECACHE-first and refreshed in the background on every fetch
//    (stale-while-revalidate): the page opens instantly and heals itself,
//    while app.js's own polling re-renders live data when the network
//    returns
//  - EVERYTHING else -- /stream plus its optional sibling mounts
//    /stream.opus and /stream.flac (an infinite audio connection must
//    never be cached), /api/* (live data; app.js already renders explicit
//    offline states), /studio (owner's authenticated views) -- passes
//    straight through untouched, no caching, no auth interference
//
// The cache name carries a version; bumping it is the whole update story.
// v2: push + notificationclick handlers (P5 #4) -- existing installs pick
// up the new SW on their next visit (stale-while-revalidate shell + claim).
const VERSION = 'rc-pwa-v2';
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
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/studio') ||
      url.pathname === '/stream' || url.pathname.startsWith('/stream.')) return;

  // Stale-while-revalidate for the precached shell: serve the cached copy
  // immediately, refresh it in the background so the NEXT load is current.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(url.pathname);
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
  // Non-shell same-origin GETs (dj-photos and other non-shell files) pass
  // through -- small, often uncacheable, not worth pinning.
});

// ---------- P5 #4: push obvestila ob zaciku terminirane oddaje ----------
//
// Streznik poslje sifriran JSON { title, body, tag, url } (push/dispatch.js).
// tag zamenja starejse obvestilo istega termina, zato ponovno poslano
// sporocilo ne kupi kupice zastarelih obvestil v triku. Neuspel JSON pars
// NI tih propad: pokazemo splosno obvestilo z besedilom, ki je prislo.
self.addEventListener('push', (event) => {
  let data = {};
  let text = '';
  try {
    text = event.data ? event.data.text() : '';
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {}; // spodaj pade na surovi text
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Radio Markec';
  const body = typeof data.body === 'string' && data.body ? data.body : text || '';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof data.tag === 'string' && data.tag ? data.tag : 'markec-push',
      icon: '/logo.png',
      badge: '/favicon.svg',
      data: { url: typeof data.url === 'string' && data.url ? data.url : '/' },
    })
  );
});

// Klik na obvestilo: osredotoce obstojeci zavihek, ce obstaja, sicer odpri
// novega na url iz sporocila. Brez toga bi klik naredil mlakav nov zavihek
// ob vsakem obvestilu -- nihce tega noce.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
