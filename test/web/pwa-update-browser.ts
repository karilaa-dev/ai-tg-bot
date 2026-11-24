import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Browser } from "playwright-core";

export async function checkPwaUpdate(browser: Browser) {
  const worker = await Bun.file("src/web/pwa/service-worker.js").text();
  let release = "first";
  let unavailable = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const headers = { "Cache-Control": "no-cache" };
      const shell = `<!doctype html><title>${release}</title>`;
      if (path === "/chat/service-worker.js") {
        const precache = [{ url: "/chat/", integrity: "sha256-" + createHash("sha256").update(shell).digest("base64") }];
        return new Response(`const revision = ${JSON.stringify(release)}; const precache = ${JSON.stringify(precache)};\n${worker}`, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      }
      if (path === "/chat/" && unavailable) return new Response("Temporarily unavailable", { status: 503, headers });
      return new Response(shell, { headers: { ...headers, "Content-Type": "text/html" } });
    },
  });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const url = new URL("/chat/", server.url).href;
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.register("/chat/service-worker.js"));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    release = "second";
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
