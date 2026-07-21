/**
 * Static-asset-only cache (§22.3). This service worker never sees relay traffic
 * (Nostr relay I/O is WebSocket, not fetch) and never handles form submissions,
 * so there is nothing sensitive in its fetch path by construction. It precaches
 * a fixed, explicit list of public files and serves them cache-first; anything
 * not on that list passes straight through to the network untouched.
 */
const CACHE_NAME = "bitlogin-demo-v1";
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/docs.html",
  "/account.html",
  "/assets/site.css",
  "/assets/icon.svg",
  "/manifest.webmanifest",
  "/vendor/bitlogin/bitlogin.js",
  "/vendor/bitlogin/cryptoWorker.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (!PRECACHE_URLS.includes(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    })
  );
});
