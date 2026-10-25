import assert from "node:assert/strict";
import path from "node:path";
import tailwind from "bun-plugin-tailwind";
import { chromium } from "playwright-core";
import openUiBrowserPlugin from "../../scripts/openui-browser-plugin.js";

const build = await Bun.build({
  entrypoints: ["test/web/openui-browser-fixture.tsx"], target: "browser",
  define: { "process.env.NODE_ENV": JSON.stringify(process.argv.includes("--development") ? "development" : "production") }, plugins: [tailwind, openUiBrowserPlugin],
});
if (!build.success) throw new AggregateError(build.logs, "OpenUI fixture build failed");
const javascript = build.outputs.find(output => output.path.endsWith(".js"));
const css = build.outputs.find(output => output.path.endsWith(".css"));
assert(javascript && css);
const assets = new Map(build.outputs.map(output => [`/${path.basename(output.path)}`, output]));
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const picture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=", "base64");
const requests: { path: string; method: string; user: string | null }[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const asset = assets.get(url.pathname);
  if (asset) return new Response(asset);
  if (url.pathname.startsWith("/api/")) {
    requests.push({ path: url.pathname + url.search, method: request.method, user: request.headers.get("X-Chat-User") });
    if (request.headers.get("X-Chat-User") !== "1001") return Response.json({ error: "Wrong account" }, { status: 401 });
    if (url.pathname === "/api/chat/threads/7/files/42") return new Response(picture, { headers: { "Content-Type": "image/png" } });
    if (url.pathname.endsWith("/43")) return new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>window.injected=true</script></svg>', { headers: { "Content-Type": "image/svg+xml" } });
    if (url.pathname.endsWith("/44")) return Response.json({ error: "Not visible in this thread" }, { status: 404 });
    if (url.pathname.endsWith("/45")) return Response.json({ error: "Account changed" }, { status: 401 });
    if (url.pathname.endsWith("/46")) { await Bun.sleep(500); return new Response(picture, { headers: { "Content-Type": "image/png" } }); }
    if (url.pathname.endsWith("/47")) return Response.json({ code: "sandbox_consent_required", error: "Manual consent required" }, { status: 409 });
    if (url.pathname.endsWith("/48")) return Response.json({ error: "Load this attachment manually" }, { status: 413 });
    if (url.pathname.endsWith("/49")) return new Response("not an image", { headers: { "Content-Type": "image/png" } });
    return new Response("Not found", { status: 404 });
  }
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenUI fixture</title><link rel="stylesheet" href="/${path.basename(css.path)}"></head><body><div id="root"></div><script type="module" src="/${path.basename(javascript.path)}"></script></body></html>`, { headers: { "Content-Type": "text/html", "Content-Security-Policy": csp } });
} });

if (process.argv.includes("--preview")) {
  console.log(`OpenUI preview: ${server.url}`);
} else {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    const remote: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(server.url.href) && !request.url().startsWith("blob:")) remote.push(request.url()); });
    await page.addInitScript(() => {
      const created: string[] = [];
      const revoked: string[] = [];
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const url = create(value); created.push(url); return url; };
      URL.revokeObjectURL = value => { revoked.push(value); revoke(value); };
      Reflect.set(window, "openUiBlobs", { created, revoked });
    });
    await page.goto(server.url.href);
    const fallback = page.getByText("Complete fallback:", { exact: false });
    await fallback.waitFor();
    const picture = page.locator('img[alt="A saved route photograph"]');
    await picture.waitFor();
    await picture.evaluate(async image => { if (!(image instanceof HTMLImageElement)) throw new Error("Expected image"); await image.decode(); });
    assert((await picture.getAttribute("src"))?.startsWith("blob:"));
    await page.getByRole("button", { name: "Compare the climbs", exact: true }).click();
    assert.equal(await page.getByRole("status", { name: "Last action" }).textContent(), "Compare the elevation gain of these routes.");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow at ${width}px`);
    }
    const example = page.getByLabel("Example", { exact: true });
    await example.selectOption("restaurants");
    const comparison = page.getByRole("table", { name: "Downtown Bellevue, WA · Quick picks", exact: true });
    await comparison.waitFor();
    assert.deepEqual(await comparison.locator("th").allTextContents(), ["Restaurant", "Cuisine", "Best for", "Area"]);
    assert.deepEqual(await comparison.locator("td").allTextContents(), [
      "Din Tai Fung", "Taiwanese / dumplings", "All-around pick; shared meal", "Lincoln Square",
      "Monsoon", "Contemporary Vietnamese", "Relaxed dinner; weekend brunch", "Main Street",
      "Carmine’s", "Upscale Italian", "Date night; special occasion", "Near Downtown Park",
      "Seastar", "Seafood / raw bar", "Seafood; business dinner", "205 108th Ave NE",
    ]);
    assert.equal(await comparison.locator("tbody tr").count(), 4);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await comparison.isVisible(), `Saved comparison remains visible at ${width}px`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Saved comparison does not overflow at ${width}px`);
    }
    assert(await fallback.isVisible());
    await example.selectOption("explanation");
    const flow = page.getByRole("figure", { name: "How the weak keys became trusted", exact: true });
    await flow.waitFor();
    assert.equal(await flow.locator("ol > li").count(), 4);
    await flow.getByText("Failure point", { exact: true }).waitFor();
    assert.equal(await page.getByRole("figure", { name: "Actual private key values", exact: true }).locator("li").count(), 8);
    const picks = page.getByRole("region", { name: "Other places worth trying", exact: true });
    assert.equal(await picks.locator(":scope > ul > li").count(), 3);
    const thumbnail = picks.locator('img[alt="Broiler Bay Hamburgers"]');
    await thumbnail.waitFor();
    assert((await thumbnail.getAttribute("src"))?.startsWith("blob:"));
    const source = picks.getByRole("link", { name: /Example guide/u });
    assert.equal(await source.getAttribute("href"), "https://www.example.org/broiler-bay");
    assert.equal(await source.getAttribute("target"), "_blank");
    assert.equal(await source.getAttribute("rel"), "noopener noreferrer nofollow");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Explanation visuals do not overflow at ${width}px`);
      if (process.env.OPENUI_SCREENSHOTS) await page.screenshot({ path: `${process.env.OPENUI_SCREENSHOTS}/explanation-${width}.png`, fullPage: true });
    }
    if (process.env.OPENUI_SCREENSHOTS) {
      await page.evaluate(() => { document.documentElement.dataset.mode = "dark"; document.body.style.background = "#111"; document.body.style.color = "#eee"; });
      await page.setViewportSize({ width: 390, height: 900 });
      await page.screenshot({ path: `${process.env.OPENUI_SCREENSHOTS}/explanation-dark-390.png`, fullPage: true });
      await page.evaluate(() => { delete document.documentElement.dataset.mode; document.body.removeAttribute("style"); });
    }
    const beforeUnsafe = requests.length;
    await example.selectOption("malicious");
    assert.equal(await page.getByLabel("Interactive response").count(), 0);
    assert.equal(requests.length, beforeUnsafe);
    assert(await fallback.isVisible());
    await example.selectOption("partial");
    assert.equal(await page.getByLabel("Interactive response").count(), 0);
    assert.equal(requests.length, beforeUnsafe);
    await example.selectOption("literal");
    await page.getByText("<script>window.injected = true</script>", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Reflect.get(window, "injected")), undefined);
    // Fetched bytes that cannot be previewed stay saveable; refused or unfetched files offer nothing to save.
    for (const [name, alt] of [["unsafe", "Unsafe format"], ["denied", "Private picture"], ["sandbox", "Sleeping sandbox"], ["large", "Large picture"], ["broken", "Broken picture"]] as const) {
      const ready = name === "unsafe" || name === "broken";
      await example.selectOption(name);
      await page.getByText(ready ? "Preview unavailable" : "Picture unavailable", { exact: true }).waitFor();
      assert.equal(await page.locator("img").count(), 0);
      const save = page.getByRole("link", { name: `Save: ${alt}`, exact: true });
      assert.equal(await save.count(), ready ? 1 : 0, `${name}: download only for fetched bytes`);
      if (ready) assert((await save.getAttribute("href"))?.startsWith("blob:") && await save.getAttribute("download") !== null);
      assert(await fallback.isVisible());
      assert.equal(await page.evaluate(() => Reflect.get(window, "injected")), undefined);
    }
    await example.selectOption("expired");
    await page.getByText("Picture unavailable", { exact: true }).waitFor();
    assert.equal(await page.getByRole("status", { name: "Session status" }).textContent(), "expired");
    const pending = page.waitForRequest(request => request.url().includes("/files/46"));
    await example.selectOption("slow");
    await pending;
    await page.getByLabel("Show UI", { exact: true }).uncheck();
    await page.waitForTimeout(600);
    assert.equal(await page.locator("img").count(), 0);
    assert(await page.evaluate(() => { const blobs = Reflect.get(window, "openUiBlobs"); return blobs.created.every((url: string) => blobs.revoked.includes(url)); }), "Every created blob is revoked on disposal, including failed formats");
    await page.getByLabel("Image access", { exact: true }).uncheck();
    const beforeUnscoped = requests.length;
    await example.selectOption("visuals");
    await page.getByLabel("Show UI", { exact: true }).check();
    await page.getByText("Picture unavailable", { exact: true }).waitFor();
    assert.equal(requests.length, beforeUnscoped, "No implicit admin file loader");
    assert(requests.every(request => request.path.startsWith("/api/chat/threads/7/files/") && request.path.endsWith("?mode=auto") && request.method === "GET" && request.user === "1001"), "Images use scoped chat auth, bounded auto reads and no implicit sandbox startup");
    assert.deepEqual(remote, []);
    assert.deepEqual(errors, []);
    console.log("OpenUI browser smoke passed: visuals, actions, scoped image auth, CSP, failures, fallback, cleanup and responsive layout");
  } finally {
    await browser.close();
    await server.stop(true);
  }
}
