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

function chatRecoveryPage(url) {
  const russian = navigator.language.toLowerCase().startsWith("ru");
  const query = url.searchParams.toString().replaceAll("&", "&amp;");
  const href = query ? `/?${query}` : "/";
  return new Response(`<!doctype html>
<html lang="${russian ? "ru" : "en"}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AI KaRiLaA</title>
<style>body{font:1rem/1.5 system-ui,sans-serif;margin:0}main{max-width:28rem;margin:12vh auto;padding:1.25rem}a{display:inline-block;padding:.65rem 0}</style>
<main>
<h1>AI KaRiLaA</h1>
<p>${russian ? "Не удалось открыть чат. Проверьте подключение и попробуйте открыть его в браузере." : "Chat couldn’t open. Check your connection and try opening it in the browser."}</p>
<a href="${href}">${russian ? "Открыть чат в браузере" : "Open chat in browser"}</a>
</main>
</html>`, { status: 503, headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  } });
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
      if (!response.ok) throw new Error("Could not load the verified asset");
      return response;
    })
    .catch(() => shell ? chatRecoveryPage(url) : Response.error()));
});
