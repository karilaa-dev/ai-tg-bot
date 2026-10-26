import { fixtureUuid } from "./uuid-fixtures.js";
import assert from "node:assert/strict";
import path from "node:path";
import tailwind from "bun-plugin-tailwind";
import { deferred } from "../helpers/async.js";
import { chromium } from "playwright-core";
import openUiBrowserPlugin from "../../scripts/openui-browser-plugin.js";
import type { ChatHistory, ChatThread } from "../../src/web/chat-types.js";
import type { WebMessage } from "../../src/web/types.js";

// The actual chat client and renderers, with a local authenticated API and an enforced server file limit.
const build = await Bun.build({ entrypoints: ["src/web/client/index.html"], target: "browser", minify: true,
  define: { "process.env.NODE_ENV": '"production"' }, plugins: [tailwind, openUiBrowserPlugin] });
if (!build.success) throw new AggregateError(build.logs, "Chat media fixture build failed");
const assets = new Map(build.outputs.map(output => [`/${path.basename(output.path)}`, output]));
const html = build.outputs.find(output => output.path.endsWith(".html"));
assert(html);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAHgAAABICAIAAACyfKYoAAADKUlEQVR42u3XR3baUBTG8buwjE2T4LmA0E6yA+OWzNJ7770X94J7L3u4GWSQBYQTHRTMZ8fmSboY557zG+vd7z8CujDKSgBdHGUlgC6NsRJAl8dYCaAr46wE0NVxVgLo2gQrAXR9gpUAujHJSgDdnGQlgG5NsRJAt6dYCaA706wE0N1pVgLo3gwrAXR/hpUAejDLSgA9nGUlgB7NsRJAj+dYCaAnVVYC6GmVlQB6Ns9KAD2fZyWAXiywEkAvF1gJoFeLrATQ60VWAujNEisB9HaJlQB6t8xKAL1fZiWAPqywEkAfV1gJoE+rrATQ51VWAujLGisB9HWNlQD6ts5KAH1fZyWARjdY2I+fvxrJH9CWvTS2wTKa+iKxS9qyl8Y3OVFH9kVJn9SWvTSxyUmw6IsSuq0te2lyi2MUS18U75Ft2UtTWxxdQn1RLNe2ZS9Nb3MUFk86/Sbk9huLL0S8WXiv329qaGabLVi8l2vo2xg6ZPFNu+Nl9gZ9QzS7w8dn07diQg5wQb5iU7ylFYnuLVdMjQ9oboePZPFetqFvq6FDFu8eZ04Se4O+oQNCV3f5MHZ9Q9FDBwpWxf+xK8a9XsV4+xMfGnp+l5tYvJcZMFmQAw5wQR4UGljchgOj7/UGTKMy8AEt7HHA7vdWLXFAJrR17ppwaZS9pf2JWwi9uMdR+rYltKmzuNxub61vyDJ0S++lB00gA7IgBxzggjwoAAMS+n9UHDQl4IEy8AG11PfEhu6ui6tvSCJ0atAEOih0lOJ9DX0lQqeGTJM0yIAsyAEHuCAPCsCAbtBTd3TfIRMqghLwQBn44G/oriET6OjQZ85Wo0sqdJi4Q0PHEvcwsYXuGjZNUiANMiALcsABLsiDAjB/JNr3gOLDJuCBMvBBp4YWrtzYWkOf8NAjpkkKpEEGZEEOOMAFeVAAZqRNoUdMjQfKwAedGlq+dVD5fwxtRIqHfSOHPmeapEAaZEAW5IADXJAHBWBAd108v6PPmVAJeKAMfHDaQod6QC/oA0WgoTsu9HnTJAXSIAOyIAcc4II8KAADukEP6AV9oAhKwANl4AMNraFPV+jfNCfbk4IrgtIAAAAASUVORK5CYII=", "base64");
const fileIndices = [168, 169, 170, 171];
const gallery = `root = Stack([Grid([${fileIndices.map(index => `Image("file:${fixtureUuid(index)}", "Restaurant ${index}", "Bellevue")`).join(",")}])])`;
let source = gallery;
// "shared" adds a separate ordinary message with the same file, the only remaining second view of a gallery image.
type RecoveryScenario = { name: string; view: "ordinary" | "gallery" | "shared"; failure: "temporary" | "oversized" | "disabled" | "sandbox"; trigger: "gallery" | "attachment" };
let recovery: RecoveryScenario | null = null;
let completeRecovery: ReturnType<typeof deferred<void>> | null = null;
let historyRevision = 0;
let userId: number | null = 1001;
let active = 0;
let maxActive = 0;
let rejected = 0;
let firstBackoff = true;
let slow = false;
const requests: { user: string | null; fileId: string; url: string; method: string }[] = [];
const profile = (id: number) => ({ id, name: id === 1001 ? "Alice" : "Bob", username: null });
const thread = (id: string): ChatThread => ({ id, userId: userId ?? 1001, title: id === fixtureUuid(157) ? "Bellevue gallery" : "Other conversation", origin: "web", topicId: null,
  parentThreadId: null, forkPointMessageId: null, archived: false, lastActivity: 1, activity: null, unread: false, lastMessageId: id === fixtureUuid(157) ? 320 : null });
const attachment = (index: number) => ({ id: fixtureUuid(index), name: `restaurant-${index}.png`, size: recovery?.failure === "oversized" ? 3 * 1024 * 1024 : png.length, mimeType: "image/png", kind: "image" as const, caption: null });
const message = (id: number, text: string): WebMessage => ({ id, threadId: fixtureUuid(157), role: "assistant", text, thinking: null, createdAt: 1, attachments: [] });
const history = (id: string): ChatHistory => ({ user: { ...profile(userId ?? 1001), lastActivity: 1, threadCount: 2 }, thread: thread(id), chain: [],
  messages: id !== fixtureUuid(157) ? [] : [{ ...message(291, recovery ? `Recovery revision ${historyRevision}` : "Four Bellevue restaurant photographs."),
    openui: recovery ? recovery.view !== "ordinary" ? `root = Stack([Image("file:${fixtureUuid(168)}", "Restaurant 168", "Bellevue")])` : undefined : source,
    attachments: (recovery ? [168] : fileIndices).map(attachment) },
    ...recovery?.view === "shared" ? [{ ...message(292, "The same photograph as an ordinary attachment."), attachments: [attachment(168)] }] : [],
    ...Array.from({ length: 20 }, (_, index) => message(300 + index, `Later message ${index}.\n\nA paragraph that keeps the older gallery outside the current viewport.`)),
    message(320, "Latest conversation message.")], draft: null, olderCursor: null, newerCursor: null, autoLoadMaxBytes: recovery?.failure === "disabled" ? 0 : 2 * 1024 * 1024, maxFileBytes: 50 * 1024 * 1024 });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const asset = assets.get(url.pathname);
  if (asset) return new Response(asset);
  if (url.pathname === "/api/chat/session") {
    if (request.method === "DELETE") userId = null;
    return Response.json(userId === null ? { authenticated: false, loginAvailable: true } : { authenticated: true, user: profile(userId), botUsername: "fixture_bot", admin: false });
  }
  if (url.pathname.startsWith("/api/chat/")) {
    if (userId === null || request.headers.get("X-Chat-User") !== String(userId)) return Response.json({ error: "Session ended" }, { status: 401 });
    if (url.pathname === "/api/chat/settings") return Response.json({ language: "en", timeZone: null, timezoneOffsetMinutes: null, streaming: true, memoryEnabled: true });
    if (url.pathname === "/api/chat/avatar") return new Response(null, { status: 204 });
    if (url.pathname === "/api/chat/threads") return Response.json({ items: [thread(fixtureUuid(157)), thread(fixtureUuid(158))], nextOffset: null });
    if (url.pathname.endsWith("/messages")) { historyRevision++; return Response.json(history(url.pathname.split("/")[4]!)); }
    if (url.pathname.endsWith("/read")) return Response.json({ readMessageId: 320, unread: false });
    if (url.pathname.includes("/files/")) {
      const fileId = url.pathname.split("/").at(-1)!;
      requests.push({ user: request.headers.get("X-Chat-User"), fileId, url: url.pathname + url.search, method: request.method });
      if (recovery) {
        if (url.searchParams.get("mode") === "auto") {
          return recovery.failure === "sandbox" ? Response.json({ code: "sandbox_consent_required" }, { status: 409 })
            : Response.json({ error: recovery.failure === "temporary" ? "Temporary error" : "Load this attachment manually." }, { status: recovery.failure === "temporary" ? 502 : 413 });
        }
        if (recovery.failure === "sandbox") {
          assert.equal(request.method, "POST", "A sandbox requires explicit approval");
          assert.equal(url.searchParams.get("sandbox"), "start");
          assert.equal(request.headers.get("X-Conversation-Sandbox-Consent"), "start");
          assert.equal(request.headers.get("X-Chat-Request"), "1");
        } else {
          assert.equal(request.method, "GET");
          assert.equal(url.searchParams.has("sandbox"), false);
        }
        assert(completeRecovery, "Explicit load is held until the test refreshes history");
        await completeRecovery.promise;
        return new Response(png, { headers: { "Content-Type": "image/png" } });
      }
      if (active >= 3) { rejected++; return Response.json({ error: "Other files are loading. Try again shortly." }, { status: 429, headers: { "Retry-After": "0.1" } }); }
      active++; maxActive = Math.max(active, maxActive);
      await Bun.sleep(slow ? 1_000 : 120);
      active--;
      if (fileId === fixtureUuid(170) && firstBackoff) { firstBackoff = false; return Response.json({ error: "Temporary busy" }, { status: 429, headers: { "Retry-After": "0.1" } }); }
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    }
    return Response.json({ error: "Unexpected fixture request" }, { status: 404 });
  }
  return new Response(html, { headers: { "Content-Type": "text/html" } });
} });

if (process.argv.includes("--preview")) {
  console.log(`Chat media preview: ${server.url}?thread=${fixtureUuid(157)}`);
} else {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const created: string[] = []; const revoked: string[] = [];
      const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const url = create(value); created.push(url); return url; };
      URL.revokeObjectURL = value => { revoked.push(value); revoke(value); };
      Reflect.set(window, "mediaBlobs", { created, revoked });
    });
    await page.goto(`${server.url}?thread=${fixtureUuid(157)}`);
    await page.getByText("Latest conversation message.", { exact: true }).waitFor();
    const viewport = page.locator(".chat-viewport");
    await page.waitForTimeout(300);
    assert.equal(requests.length, 0, "No blob fetch for gallery or ordinary previews before first visibility");
    const top = () => viewport.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
    await top();
    const images = page.locator('.chat-openui img');
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-openui img')].filter(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0).length === 4);
    assert.equal(await images.count(), 4);
    assert.deepEqual(await page.locator(".chat-openui a[download]").evaluateAll(links => links.map(link => link.getAttribute("download"))), fileIndices.map(index => `restaurant-${index}.png`));
    assert.equal(await page.locator('[data-message-id="291"] .chat-attachments').count(), 0, "Images the generated view mounted have no duplicate attachment rows or empty container");
    assert.equal(rejected, 0, "Four images never overflow the shared three-request server limit");
    assert.equal(maxActive, 3);
    assert.equal(requests.length, 5, "Four images plus one automatic retry, without manual clicks");
    assert(requests.every(request => request.user === "1001" && request.method === "GET" && request.url.endsWith("?mode=auto")));
    await page.screenshot({ path: "/tmp/ai-tg-gallery-cache.png", fullPage: true });
    const originalUrls = await images.evaluateAll(images => images.map(image => image.getAttribute("src")));
    const open = async (title: string) => { await page.getByRole("button", { name: new RegExp(`^${title} `) }).click(); };
    await open("Other conversation");
    await open("Bellevue gallery");
    await page.getByText("Latest conversation message.", { exact: true }).waitFor();
    await top();
    await page.waitForFunction(() => document.querySelectorAll('.chat-openui img').length === 4);
    assert.equal(requests.length, 5, "Remount and navigation reuse cached bytes");
    assert.deepEqual(await images.evaluateAll(images => images.map(image => image.getAttribute("src"))), originalUrls);
    assert(await page.evaluate(() => { const blobs = Reflect.get(window, "mediaBlobs"); return blobs.revoked.length === 0; }), "Remount does not revoke cached URLs");

    // A valid but unreferenced definition must not hide its corresponding ordinary attachment.
    source = `root = Stack([Text("An ordinary reply")])\nunused = Image("file:${fixtureUuid(168)}", "Unused", "")`;
    await open("Other conversation"); await open("Bellevue gallery");
    await page.getByText("Latest conversation message.", { exact: true }).waitFor(); await top();
    await page.waitForFunction(() => document.querySelectorAll('.chat-attachments img').length === 4);
    assert.equal(await images.count(), 0);
    source = 'root = Stack([Image("https://invalid.example/pixel", "Unsafe", "")])';
    await open("Other conversation"); await open("Bellevue gallery");
    await page.getByText("Latest conversation message.", { exact: true }).waitFor(); await top();
    await page.waitForFunction(() => document.querySelectorAll('.chat-attachments img').length === 4);
    assert.equal(await page.getByLabel("Interactive response").count(), 0, "Invalid UI preserves ordinary image fallback");
    assert.equal(requests.length, 5);

    source = gallery;
    await open("Other conversation");
    await page.evaluate(() => {
      const create = document.createElement.bind(document);
      Object.defineProperty(document, "createElement", { configurable: true, value: (tagName: string, options?: ElementCreationOptions) => {
        if (tagName === "figure") throw new Error("Fixture image render failure");
        return create(tagName, options);
      } });
      Reflect.set(window, "restoreCreateElement", () => { document.createElement = create; });
    });
    await open("Bellevue gallery");
    await page.getByText("Latest conversation message.", { exact: true }).waitFor(); await top();
    await page.waitForFunction(() => document.querySelectorAll('.chat-attachments img').length === 4);
    assert.equal(await page.getByLabel("Interactive response").count(), 0, "Runtime UI errors restore ordinary image fallback");
    await page.evaluate(() => Reflect.get(window, "restoreCreateElement")());

    await page.getByRole("button", { name: /Account.*Alice/ }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await page.getByRole("link", { name: "Sign in with Telegram", exact: true }).waitFor();
    assert(await page.evaluate(() => { const blobs = Reflect.get(window, "mediaBlobs"); return blobs.created.every((url: string) => blobs.revoked.includes(url)); }), "Logout revokes every cached and displayed object URL");
    assert.equal(await page.locator('img[src^="blob:"]').count(), 0);

    // Revalidate another account in this document, so a page reload cannot accidentally conceal cache leakage.
    userId = 2002;
    slow = true;
    await page.evaluate(() => window.dispatchEvent(new Event("chat-session-expired")));
    await page.getByRole("button", { name: /^Bellevue gallery / }).waitFor();
    await open("Bellevue gallery");
    await page.getByText("Latest conversation message.", { exact: true }).waitFor();
    const nextAccountRequest = page.waitForRequest(request => request.url().includes("/files/") && request.headers()["x-chat-user"] === "2002");
    await top(); await nextAccountRequest;
    assert.equal(await images.count(), 0, "New account cannot display prior account's cached blobs");
    await page.getByRole("button", { name: /Account.*Bob/ }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await page.getByRole("link", { name: "Sign in with Telegram", exact: true }).waitFor();
    await page.waitForTimeout(1_100);
    assert.equal(await page.locator('img[src^="blob:"]').count(), 0, "Late in-flight bytes after logout never render");
    assert(await page.evaluate(() => { const blobs = Reflect.get(window, "mediaBlobs"); return blobs.created.every((url: string) => blobs.revoked.includes(url)); }));
    assert.deepEqual(errors.filter(error => !error.includes("Fixture image render failure")), []);
    await page.close();
    const recoveries: RecoveryScenario[] = [
      { name: "ordinary retry", view: "ordinary", failure: "temporary", trigger: "attachment" },
      { name: "ordinary consent", view: "ordinary", failure: "sandbox", trigger: "attachment" },
      { name: "gallery oversized retry", view: "gallery", failure: "oversized", trigger: "gallery" },
      { name: "shared gallery oversized retry", view: "shared", failure: "oversized", trigger: "gallery" },
      { name: "shared attachment oversized retry", view: "shared", failure: "oversized", trigger: "attachment" },
      { name: "gallery disabled auto retry", view: "gallery", failure: "disabled", trigger: "gallery" },
      { name: "shared attachment disabled auto retry", view: "shared", failure: "disabled", trigger: "attachment" },
      { name: "gallery consent", view: "gallery", failure: "sandbox", trigger: "gallery" },
      { name: "shared attachment consent", view: "shared", failure: "sandbox", trigger: "attachment" },
    ];
    for (const scenario of recoveries) {
      recovery = scenario;
      completeRecovery = deferred<void>();
      userId = 1001;
      slow = false;
      requests.length = 0;
      const recoveryPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const failures: string[] = [];
      recoveryPage.on("requestfailed", request => { if (request.url().includes("/files/")) failures.push(request.failure()?.errorText ?? "File request failed"); });
      recoveryPage.on("pageerror", error => errors.push(error.message));
      const scrollTop = () => recoveryPage.locator(".chat-viewport").evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
      const refreshHistory = async () => {
        const next = historyRevision + 1;
        await recoveryPage.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await recoveryPage.getByText(`Recovery revision ${next}`, { exact: true }).waitFor();
        await recoveryPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      await recoveryPage.goto(`${server.url}?thread=${fixtureUuid(157)}`);
      await recoveryPage.getByText("Latest conversation message.", { exact: true }).waitFor();
      await scrollTop();
      const trigger = recoveryPage.locator(scenario.trigger === "gallery" ? ".chat-openui" : ".chat-attachments");
      const button = trigger.getByRole("button", { name: scenario.failure === "sandbox" ? "Start sandbox and load" : scenario.trigger === "gallery" ? "Try again" : "Retry", exact: true });
      await button.waitFor();
      assert.deepEqual(requests.map(item => item.method + " " + item.url), [`GET /api/chat/threads/${fixtureUuid(157)}/files/${fixtureUuid(168)}?mode=auto`], `${scenario.name}: first request respects auto policy`);
      const manualRequest = recoveryPage.waitForRequest(request => request.url().includes(`/files/${fixtureUuid(168)}?mode=download`));
      await button.click();
      await manualRequest;
      await refreshHistory();
      assert.equal(requests.length, 2, `${scenario.name}: history refresh must not start another load`);
      assert.deepEqual(failures, [], `${scenario.name}: refresh/rerender must not cancel explicit recovery`);
      completeRecovery.resolve();
      await recoveryPage.waitForFunction(() => [...document.querySelectorAll('img[src^="blob:"]')].some(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
      const download = recoveryPage.locator(`${scenario.view === "gallery" ? ".chat-openui" : ".chat-attachments"} a[download="restaurant-168.png"]`);
      await download.waitFor();
      const url = await download.getAttribute("href");
      assert(url?.startsWith("blob:"));
      if (scenario.view !== "ordinary") {
        assert.equal(await recoveryPage.locator('[data-message-id="291"] .chat-attachments').count(), 0, `${scenario.name}: the gallery image has no duplicate row`);
        assert.equal(await recoveryPage.locator(".chat-openui img").getAttribute("src"), url, `${scenario.name}: the gallery shows the recovered bytes`);
      }
      if (scenario.view === "shared") assert.equal(await recoveryPage.locator('[data-message-id="292"] .chat-attachments img').getAttribute("src"), url, `${scenario.name}: both consumers receive the same ready bytes`);
      assert.equal(await recoveryPage.getByRole("button", { name: /^(Try again|Retry|Start sandbox and load)$/ }).count(), 0, `${scenario.name}: neither view retains a stale error/consent prompt`);
      await refreshHistory();
      assert.equal(await download.getAttribute("href"), url, `${scenario.name}: refresh cannot demote ready data`);
      await recoveryPage.getByRole("button", { name: /^Other conversation / }).click();
      await recoveryPage.getByRole("button", { name: /^Bellevue gallery / }).click();
      await recoveryPage.getByText("Latest conversation message.", { exact: true }).waitFor();
      await scrollTop();
      await download.waitFor();
      assert.equal(await download.getAttribute("href"), url, `${scenario.name}: remount reuses manually recovered bytes`);
      assert.equal(requests.length, 2, `${scenario.name}: one automatic request and one explicit recovery only`);
      assert.equal(requests[1]?.method, scenario.failure === "sandbox" ? "POST" : "GET");
      assert(requests.every(request => request.user === "1001"));
      assert.deepEqual(failures, []);
      await recoveryPage.close();
    }
    assert.deepEqual(errors.filter(error => !error.includes("Fixture image render failure")), []);
    console.log(`Chat media browser smoke passed: first visibility, shared queue/cache, fallback and account isolation; ${recoveries.length} explicit recovery cases cover ordinary/gallery-only/shared 413, disabled auto, sandbox consent, inflight/ready history refresh, synchronized state and cached remounts`);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}
