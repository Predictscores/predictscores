// FILE: public/sw.js
// v4 — network-first za HTML (/, navigacije), cache-first za statiku
const CACHE = "ps-v4";

// statična imovina koju sme da kešira unapred (NE keširamo "/" da ne držimo star HTML)
const ASSETS = ["/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) HTML / navigacije -> NETWORK FIRST (reši "stari header" problem)
  const isHTML =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isHTML && url.origin === location.origin) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 2) Statika Next-a, ikone, manifest -> CACHE FIRST
  if (
    url.origin === location.origin &&
    (url.pathname.startsWith("/_next/") ||
      url.pathname.startsWith("/icons/") ||
      url.pathname === "/manifest.json")
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return resp;
        });
      })
    );
    return;
  }

  // 3) API -> NETWORK FIRST (pa cache ako smo offline)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // 4) Ostalo -> TRY CACHE THEN NETWORK
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
