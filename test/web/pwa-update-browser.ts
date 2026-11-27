import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Browser } from "playwright-core";

export async function checkPwaUpdate(browser: Browser) {
  const worker = await Bun.file("src/web/pwa/service-worker.js").text();
  let release = "first";
  let unavailable = false;
  let mismatchedShell = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const headers = { "Cache-Control": "no-cache" };
      const shell = `<!doctype html><title>${release}</title>`;
      const manifest = JSON.stringify({ name: release });
      if (path === "/chat/service-worker.js") {
        const precache = [["/chat/", shell], ["/chat.webmanifest", manifest]].map(([url, body]) => ({
          url, integrity: "sha256-" + createHash("sha256").update(body!).digest("base64"),
        }));
        return new Response(`const revision = ${JSON.stringify(release)}; const precache = ${JSON.stringify(precache)};\n${worker}`, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      }
      if (path === "/chat.webmanifest") return new Response(manifest, { headers: { ...headers, "Content-Type": "application/manifest+json" } });
      if (path === "/chat/" && unavailable) return new Response("Temporarily unavailable", { status: 503, headers });
      return new Response(mismatchedShell ? "The previous server is still serving chat." : shell, { headers: { ...headers, "Content-Type": "text/html" } });
    },
  });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const url = new URL("/chat/", server.url).href;
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.register("/chat/service-worker.js"));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    release = "rejected";
    mismatchedShell = true;
    const failedState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const installed = new Promise<ServiceWorkerState>(resolve => registration.addEventListener("updatefound", () => {
        const installing = registration.installing!;
        installing.addEventListener("statechange", () => {
          if (installing.state === "redundant" || installing.state === "installed") resolve(installing.state);
        });
      }, { once: true }));
      await registration.update();
      return installed;
    });
    assert.equal(failedState, "redundant");
    assert(!await page.evaluate(async () => (await caches.keys()).includes("ai-tg-bot-web-rejected")));
    await page.reload();
    assert.equal(await page.title(), "first");
    assert.equal(await page.evaluate(async () => {
      const cache = await caches.open("ai-tg-bot-web-first");
      await cache.delete("/chat.webmanifest");
      return fetch("/chat.webmanifest").then(response => response.ok, () => false);
    }), false, "A cache miss rejects the wrong revision's manifest");

    release = "second";
    mismatchedShell = false;
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
    await page.waitForFunction(async () => (await navigator.serviceWorker.ready).waiting?.state === "installed");
    await page.reload();
    assert.equal(await page.title(), "first", "Open chat clients stay on their verified build during rollout");

    await page.goto(new URL("/outside", server.url).href);
    await page.waitForFunction(async () => {
      const keys = await caches.keys();
      return keys.includes("ai-tg-bot-web-second") && !keys.includes("ai-tg-bot-web-first");
    });
    unavailable = true;
    const response = await page.goto(url + "?view=settings");
    assert(response?.fromServiceWorker());
    assert.equal(await page.title(), "second", "The new build opens while the origin returns 503");
  } finally {
    await context.close();
    await server.stop(true);
  }
}
