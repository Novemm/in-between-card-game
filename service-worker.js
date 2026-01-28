// Simple PWA cache for static assets.
// Note: multiplayer requires network; this mainly makes install + load snappier.

const CACHE_NAME = "in-between-pwa-v1";
const ASSETS = [
  "/",               // main page
  "/index.html",
  "/manifest.json",
  "/service-worker.js",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // For navigation requests, try network first (keeps multiplayer working),
  // fall back to cached page if offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // For other assets, cache-first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
