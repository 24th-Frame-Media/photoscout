// PhotoScout's service worker. It does one thing: keep the app shell (the page
// and its scripts, styles and icons) so an installed copy opens with no signal.
// Everything else, above all /api, goes to the network and is never stored:
// spots, photos and sign-in state must come from the server, not from here.

const CACHE = 'photoscout-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
// Built scripts and styles have a new name each build, so old ones pile up; keep the newest.
const MAX_ASSETS = 80;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // The page names its own scripts and styles; fetch those too, so the very
    // first launch offline has everything, not only what a later visit adds.
    const page = await fetch('/', { cache: 'reload' });
    if (!page.ok) throw new Error(`/ answered ${page.status}`);
    const html = await page.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    await cache.put('/', page);
    await cache.addAll([...SHELL.slice(1), ...assets]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function trim(cache) {
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith('/assets/'));
  for (const r of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(r);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // map tiles and other people's servers: not ours to keep
  if (url.pathname.startsWith('/api/')) return; // never answered from here, never stored

  if (req.mode === 'navigate') {
    // Online: the live page, and keep it as the shell. Offline: the shell.
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put('/', copy)));
        }
        return res;
      } catch {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    // Named by content, so a stored copy is the right one: look here first.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        event.waitUntil(cache.put(req, res.clone()).then(() => trim(cache)));
      }
      return res;
    })());
  }
});
