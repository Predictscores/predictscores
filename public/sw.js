// FILE: public/sw.js
// Minimalni SW: kešira statiku i manifest; network-first za API
const CACHE = "ps-v1";
const ASSETS = [
  "/", "/manifest.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Cache-first za statiku
  if (url.origin === location.origin && (url.pathname.startsWith("/_next/") || url.pathname === "/" || url.pathname.startsWith("/icons/") || url.pathname==="/manifest.json")) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return resp;
      }))
    );
    return;
  }
  // Network-first za API
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  // default: try cache then network
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
