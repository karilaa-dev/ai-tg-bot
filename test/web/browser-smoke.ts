import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { checkPwaUpdate } from "./pwa-update-browser.js";
import type { WebHistory } from "../../src/web/types.js";
import { chromium, type BrowserContext } from "playwright-core";

/** Exercise both website routes with service workers disabled and a real HTTP cache. */
async function checkBrowserCache(signedIn: BrowserContext, origin: string, history: WebHistory) {
  const context = await browser.newContext({ serviceWorkers: "block", storageState: await signedIn.storageState() });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const revalidated = new Set<string>();
  cdp.on("Network.responseReceivedExtraInfo", event => {
    if (event.statusCode === 304) revalidated.add(new Headers(event.headers).get("etag") ?? "");
  });
  const picture = history.messages.flatMap(message => message.attachments).find(file => file.name === "route-preview.png");
  assert(picture);
  try {
    for (const route of ["/", "/admin"]) {
      const target = new URL(route, origin).href;
      const cold = await page.goto(target);
      const tag = await cold!.headerValue("etag");
      assert(tag);
      await page.goto("about:blank");
      revalidated.clear();
      await page.goto(target);
      assert(revalidated.has(tag), `The browser revalidated ${route} without downloading the page again`);
      const styles = await page.evaluate(() => {
        const href = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!.href;
        return performance.getEntriesByName(href).some(entry => (entry as PerformanceResourceTiming).transferSize === 0);
      });
      assert(styles, `The browser reused the stylesheet on ${route}`);

      const chat = route === "/";
      const mediaUrl: string = `/api${chat ? "/chat" : ""}/threads/${history.thread.id}/files/${picture.id}?mode=download`;
      const read = () => page.evaluate(async ({ mediaUrl, user }) => {
        const response = await fetch(mediaUrl, { headers: user ? { "X-Chat-User": user } : {} });
        return { status: response.status, bytes: (await response.arrayBuffer()).byteLength, etag: response.headers.get("etag") };
      }, { mediaUrl, user: chat ? String(history.user.id) : "" });
      const first = await read();
      assert.equal(first.status, 200);
      assert.equal(first.bytes, picture.size);
      assert(first.etag);
      revalidated.clear();
      assert.deepEqual(await read(), first);
      assert(revalidated.has(first.etag), `The browser revalidated the private file on ${route}`);
      await context.setOffline(true);
      await assert.rejects(read());
      await context.setOffline(false);
    }
  } finally { await context.close(); }
}

const browser = await chromium.launch({ headless: true });
const server = spawn(process.execPath, ["test/web/http-smoke.ts", "--browser", ...process.argv.filter(arg => arg === "--web-dev")], {
  stdio: ["ignore", "pipe", "inherit"], timeout: 120_000,
});
const stopped = once(server, "exit");
try {
  let url: string | undefined;
  for await (const line of createInterface({ input: server.stdout })) {
    if (line.startsWith("Preview: ")) { url = line.slice("Preview: ".length); break; }
  }
  assert.ok(url, "The browser fixture must start successfully");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const adminUrl = new URL(url);
  adminUrl.pathname = "/admin/";
  await page.goto(adminUrl.href);
  assert.equal(page.url(), url, "The trailing admin slash redirects while preserving the selected chat");
  const signIn = page.getByRole("link", { name: "Sign in with Telegram", exact: true });
  await signIn.waitFor();
  assert.equal(await page.locator("input").count(), 0, "Admins sign in with Telegram, not a token");
  assert.equal(new URL(await signIn.getAttribute("href") ?? "", url).search, "?return=/admin");
  await signIn.click();
  await page.waitForURL(new URL("/admin", url).href);
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.waitFor();
  assert.equal(await navigation.getByRole("link", { name: "Back to chat", exact: true }).getAttribute("href"), "/");
  await page.goto(url);
  await navigation.waitFor();

  const thinking = page.getByRole("button", { name: "3 tool calls", exact: true });
  await thinking.waitFor();
  assert.equal(await thinking.getAttribute("aria-expanded"), "false");
  await thinking.focus();
  await thinking.press("Enter");
  const toolDetails = page.getByRole("region", { name: "Thinking and tool details" });
  await toolDetails.waitFor();
  const reply = page.locator(".message").filter({ has: thinking });
  await reply.locator(".message-usage > button").click();
  const usageDetails = reply.getByRole("region", { name: "Usage details" });
  await usageDetails.getByRole("button", { name: "1 recorded call", exact: true }).click();
  const call = usageDetails.locator(".usage-call");
  assert.equal(await call.getAttribute("open"), null);
  assert.equal(await call.getByText("Requested tier", { exact: true }).isVisible(), false);
  await call.locator("summary").focus();
  await page.keyboard.press("Enter");
  await call.getByText("Requested tier", { exact: true }).waitFor();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const region of [toolDetails, usageDetails]) {
      const bounds = await region.evaluate(node => ({ height: node.getBoundingClientRect().height, scroll: node.scrollHeight, client: node.clientHeight, width: node.scrollWidth, clientWidth: node.clientWidth }));
      assert(bounds.height <= 320, `Details stay compact at ${width}px`);
      assert(bounds.scroll > bounds.client, "Long details scroll internally");
      assert(bounds.width <= bounds.clientWidth, `Details have no horizontal overflow at ${width}px`);
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No transcript overflow at ${width}px`);
  }
  await thinking.click();
  await toolDetails.waitFor({ state: "hidden" });

  // Let the visible preview finish its single download slot before testing HTTP revalidation.
  await page.locator(".image-attachment").first().scrollIntoViewIfNeeded();
  await page.locator(".image-attachment img").first().waitFor();
  await page.getByRole("button", { name: "Usage", exact: true }).first().click();
  await page.getByRole("img", { name: "Daily stacked token counts", exact: false }).waitFor();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => [...document.querySelectorAll<SVGSVGElement>(".usage-chart svg")].every(svg => Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 1));
    const labels = await page.locator(".usage-chart text").evaluateAll(nodes => nodes.map(node => {
      if (!(node instanceof SVGTextElement)) throw new Error("Chart labels must be SVG text");
      const scale = node.getScreenCTM();
      const bounds = node.getBoundingClientRect();
      const chart = node.closest("svg")!.getBoundingClientRect();
      return {
        size: parseFloat(getComputedStyle(node).fontSize) * (scale?.a ?? 0),
        inside: bounds.left >= chart.left - 1 && bounds.right <= chart.right + 1 && bounds.top >= chart.top - 1 && bounds.bottom <= chart.bottom + 1,
      };
    }));
    assert.equal(labels.length, 10);
    assert(labels.every(label => Math.abs(label.size - 14) < 0.1), `Readable chart labels at ${width}px`);
    assert(labels.every(label => label.inside), `Unclipped chart labels at ${width}px`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}px`);
  }
  const slider = page.getByRole("slider", { name: "Inspect day", exact: false });
  await slider.focus();
  const selectedDay = await slider.getAttribute("aria-valuetext");
  await slider.press("ArrowLeft");
  assert.notEqual(await slider.getAttribute("aria-valuetext"), selectedDay);
  if (!process.argv.includes("--web-dev")) {
    assert.equal(await page.locator('link[rel="manifest"]').count(), 0);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null);
    const context = page.context();
    const cdp = await context.newCDPSession(page);
    const threadId = new URL(url).searchParams.get("thread");
    const historyResponse = await context.request.get(new URL(`/api/threads/${threadId}/messages`, url).href);
    await checkBrowserCache(context, url, await historyResponse.json() as WebHistory);
    await page.goto(new URL("/", url).href);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistration("/chat/").then(Boolean)), false);
    const rootInstall = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(rootInstall.installabilityErrors, []);
    await context.clearCookies();
    await page.goto(new URL("/chat/", url).href);
    await page.getByRole("link", { name: "Sign in with Telegram", exact: true }).click();
    await page.waitForURL(new URL("/chat/", url).href);
    const account = page.getByRole("button", { name: /^Account:/ });
    await account.click();
    await page.getByRole("menuitem", { name: "Admin", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    const draft = "Keep this unsent draft across an offline reload.";
    await composer.fill(draft);
    await context.setOffline(true);
    assert((await page.reload())?.fromServiceWorker());
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await retry.waitFor();
    assert.equal(await composer.count(), 0, "The workspace stays gated until the session is verified");
    await context.setOffline(false);
    await retry.click();
    assert.equal(await composer.inputValue(), draft, "Reconnecting restores the signed-in user's draft");
    await context.setOffline(true);
    assert.equal(await page.evaluate(() => fetch("/api/chat/session").then(() => true, () => false)), false);
    const response = await page.goto(new URL(`/chat/?thread=${threadId}`, url).href);
    assert(response?.fromServiceWorker(), "Offline navigation loads the public chat shell");
    await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
    const manifest = await cdp.send("Page.getAppManifest");
    assert.deepEqual(manifest.errors, []);
    const app = JSON.parse(manifest.data!);
    assert.equal(app.start_url, "/chat/");
    assert.equal(app.scope, "/chat/");
    const installability = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installability.installabilityErrors, []);
    await context.setOffline(false);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistration("/admin").then(Boolean)), false);
    await page.goto(new URL("/admin", url).href);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null);
    const cachePaths = await page.evaluate(async () => {
      const [name] = (await caches.keys()).filter(name => name.startsWith("ai-tg-bot-web-"));
      return (await (await caches.open(name!)).keys()).map(request => new URL(request.url).pathname);
    });
    assert(cachePaths.every(path => !path.startsWith("/admin")));
    assert(cachePaths.some(path => path.startsWith("/chat-app-")));
    assert(cachePaths.every(path => !path.startsWith("/api/")));
    await checkPwaUpdate(browser);
  }
  assert.deepEqual(errors, []);
  console.log("Browser smoke passed: Telegram admin sign-in, compact tool and usage details, keyboard disclosures, responsive charts, and keyboard day selection");
} finally {
  server.kill("SIGTERM");
  await stopped;
  await browser.close();
}
