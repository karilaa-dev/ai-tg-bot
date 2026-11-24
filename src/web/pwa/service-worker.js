// revision and precache are generated from the production build.
const prefix = "ai-tg-bot-web-";
const cacheName = prefix + revision;
const paths = new Set(precache.map(entry => entry.url));

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(precache.map(({ url, integrity }) => new Request(url, {
      integrity, credentials: "omit", redirect: "error",
      cache: url === "/chat/" || url === "/chat.webmanifest" ? "no-cache" : "default",
    })));
  })());
});

// Wait for existing clients to finish using their build before retiring it.
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(prefix) && key !== cacheName).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !paths.has(url.pathname)) return;
  // Query parameters select a chat view; every navigation uses this worker's verified shell.
  const shell = url.pathname === "/chat/";
  if (shell ? request.mode !== "navigate" : url.search) return;
  event.respondWith(caches.match(shell ? url.pathname : request, { cacheName })
    .then(cached => cached || fetch(request)));
});
