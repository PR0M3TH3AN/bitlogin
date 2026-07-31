/** Generated at build time: the version and manifest cover the complete release graph. */
const CACHE_NAME = "bitlogin-demo-__BITLOGIN_BUILD_HASH__";
const PRECACHE_PATHS = ["__BITLOGIN_PRECACHE_MANIFEST__"];
const PRECACHE_URLS = new Set(
  PRECACHE_PATHS.map((path) => new URL(path, self.location.href).toString()),
);

self.addEventListener("install", (event) => {
  // Do not skipWaiting: an older page may still need lazy chunks and the
  // matching crypto worker from its own release. The new worker activates
  // only after those clients close, with its complete cache already present.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([...PRECACHE_URLS])),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("bitlogin-demo-") && key !== CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request, {
    cacheName: CACHE_NAME,
    ignoreSearch: true,
  });
  return cached ?? fetch(request);
}

async function navigationForThisRelease(request) {
  const url = new URL(request.url);
  const relativePath = url.pathname.slice(
    new URL("./", self.location.href).pathname.length,
  );
  const releasePath =
    relativePath === "" ? "./index.html" : `./${relativePath}`;
  const cached = await caches.match(new URL(releasePath, self.location.href), {
    cacheName: CACHE_NAME,
    ignoreSearch: true,
  });
  return cached ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin)
    return;

  if (event.request.mode === "navigate") {
    event.respondWith(navigationForThisRelease(event.request));
    return;
  }

  if (!PRECACHE_URLS.has(url.toString())) return;
  // Every controlled client stays on one complete release graph. This is
  // especially important for lazy chunks and the main/worker protocol pair.
  event.respondWith(cacheFirst(event.request));
});
