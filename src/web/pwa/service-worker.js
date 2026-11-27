// revision and precache are generated from the production build.
const prefix = "ai-tg-bot-web-";
const cacheName = prefix + revision;
const resources = new Map(precache.map(entry => [entry.url, entry]));

function verifiedRequest({ url, integrity }) {
  return new Request(url, {
    integrity, credentials: "omit", redirect: "error",
    cache: url === "/chat/" || url === "/chat.webmanifest" ? "no-cache" : "default",
  });
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const existed = await caches.has(cacheName);
    const cache = await caches.open(cacheName);
    try {
      await cache.addAll(precache.map(verifiedRequest));
    } catch (error) {
      // A rollback can reinstall the revision currently serving open windows.
      if (!existed) await caches.delete(cacheName).catch(() => {});
      throw error;
    }
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
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const entry = resources.get(url.pathname);
  if (!entry) return;
  // Query parameters select a chat view; every navigation uses this worker's verified shell.
  const shell = url.pathname === "/chat/";
  if (shell ? request.mode !== "navigate" : url.search) return;
  event.respondWith(caches.match(entry.url, { cacheName, ignoreVary: true })
    .then(async cached => {
      if (cached) return cached;
      const response = await fetch(verifiedRequest(entry));
      return response.ok ? response : Response.error();
    }));
});
