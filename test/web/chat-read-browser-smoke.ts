import { fixtureUuid } from "./uuid-fixtures.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { chromium, type Page, type Route } from "playwright-core";
import type { ChatHistory, ChatThread } from "../../src/web/chat-types.js";
import type { WebPage } from "../../src/web/types.js";
import { deferred } from "../helpers/async.js";

// Real client, isolated in-memory fixture; production assets can live outside dist/web.
const development = !process.argv.includes("--production");
const browser = await chromium.launch({ headless: true });
const server = spawn(process.execPath, ["--no-env-file", "test/web/chat-preview.ts", ...(development ? ["--dev"] : [])], {
  env: { ...process.env, CHAT_PREVIEW_PORT: "0" }, stdio: ["ignore", "pipe", "inherit"], timeout: 120_000,
});
const stopped = once(server, "exit");
const errors: string[] = [];

async function painted(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  let root: string | undefined;
  for await (const line of createInterface({ input: server.stdout })) {
    if (line.startsWith("Chat preview: ")) { root = line.slice("Chat preview: ".length).split(" ")[0]; break; }
  }
  assert.ok(root, "Preview must announce its private URL");
  const rootUrl = root;

  const openPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      if (route.request().url().startsWith(rootUrl)) return route.continue();
      errors.push(`Unexpected external request: ${route.request().url()}`);
      return route.abort();
    });
    return page;
  };
  const rowFor = (page: Page, title: string) => page.locator(".chat-sidebar .chat-thread").filter({ hasText: title });

  {
    const page = await openPage();
    await page.goto(root);
    await rowFor(page, "Weekly grocery list").waitFor();
    await page.getByRole("button", { name: "Search chats", exact: true }).click();
    await page.getByRole("option", { name: /Weekly grocery list.*unread.*started in Telegram/ }).waitFor();
    const readWeb = page.getByRole("option", { name: /Planning the autumn trip.*started on the web/ });
    await readWeb.waitFor();
    assert.equal(await readWeb.locator(".chat-unread-dot").count(), 0);
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
    console.log("PASS: search exposes unread and source information in accessible option names");
  }

  // The server can confirm a lower cursor when a pending delivery makes the old watermark unsafe.
  {
    const page = await openPage();
    const first = deferred<void>();
    const accepted = deferred<void>();
    const requested: number[] = [];
    let read = false;
    await page.route("**/api/chat/threads?**", async route => {
      const response = await route.fetch();
      const body: WebPage<ChatThread> = await response.json();
      for (const thread of body.items) if (thread.id === fixtureUuid(2)) thread.unread = !read;
      await route.fulfill({ response, json: body });
    });
    await page.route(`**/api/chat/threads/${fixtureUuid(2)}/read`, async route => {
      const { messageId } = route.request().postDataJSON() as { messageId: number };
      requested.push(messageId);
      assert.equal(route.request().headers()["x-chat-user"], "1001");
      assert.equal(route.request().headers()["x-chat-request"], "1");
      if (requested.length === 1) {
        await route.fulfill({ json: { readMessageId: messageId - 1, unread: true } });
        first.resolve();
      } else {
        read = true;
        await route.fulfill({ json: { readMessageId: messageId, unread: false } });
        accepted.resolve();
      }
    });
    await page.goto(`${root}?thread=${fixtureUuid(2)}`);
    await within(first.promise, "The visible unread message must be acknowledged");
    await painted(page);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await within(accepted.promise, "A lower confirmed cursor suppressed retry of the same visible message");
    await page.waitForFunction(() => [...document.querySelectorAll(".chat-sidebar .chat-thread")].some(row => row.textContent?.includes("Weekly grocery list") && !row.querySelector(".chat-unread-dot")));
    assert(requested.length >= 2);
    assert.equal(requested[0], requested[1], "Retry must acknowledge the same already-visible message");
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
    console.log("PASS: a lower server-confirmed cursor retries the same visible message");
  }

  // A list poll can learn of a later unread message while the older read response is in flight.
  {
    const page = await openPage();
    const held = deferred<Route>();
    const newerTitle = "Compare two laptop options — newer unread reply";
    let newer = false;
    let holdRefresh = false;
    const refreshes: Route[] = [];
    let target = 0;
    await page.route("**/api/chat/threads?**", async route => {
      if (holdRefresh) { refreshes.push(route); return; }
      const response = await route.fetch();
      const body: WebPage<ChatThread> = await response.json();
      for (const thread of body.items) if (thread.id === fixtureUuid(3) && newer) {
        thread.title = newerTitle; thread.lastMessageId = target + 1; thread.unread = true;
      }
      await route.fulfill({ response, json: body });
    });
    await page.route(`**/api/chat/threads/${fixtureUuid(3)}/read`, route => {
      target = (route.request().postDataJSON() as { messageId: number }).messageId;
      held.resolve(route);
    });
    await page.goto(`${root}?thread=${fixtureUuid(3)}`);
    const request = await within(held.promise, "The original unread reply must be acknowledged");
    newer = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const row = rowFor(page, newerTitle);
    await row.waitFor();
    await row.locator(".chat-unread-dot").waitFor();
    // Keep the follow-up poll pending so it cannot repair an incorrect immediate clear.
    holdRefresh = true;
    await request.fulfill({ json: { readMessageId: target, unread: false } });
    await painted(page);
    assert.equal(await row.locator(".chat-unread-dot").count(), 1, "Older acknowledgement must not clear the later unread reply");
    holdRefresh = false;
    await Promise.all(refreshes.map(route => route.abort()));
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
    console.log("PASS: a delayed acknowledgement preserves a newer unread dot");
  }

  // A safe watermark may stay behind an unfinished delivery while later content remains unread.
  {
    const page = await openPage();
    const held = deferred<Route>();
    const refreshedTitle = "Weekly grocery list — unread beyond safe watermark";
    let acknowledged = false;
    let target = 0;
    await page.route("**/api/chat/threads?**", async route => {
      const response = await route.fetch();
      const body: WebPage<ChatThread> = await response.json();
      for (const thread of body.items) if (thread.id === fixtureUuid(2) && acknowledged) {
        thread.title = refreshedTitle; thread.lastMessageId = target; thread.unread = true;
      }
      await route.fulfill({ response, json: body });
    });
    await page.route(`**/api/chat/threads/${fixtureUuid(2)}/messages*`, async route => {
      const response = await route.fetch();
      const body: ChatHistory = await response.json();
      body.thread.unread = true;
      await route.fulfill({ response, json: body });
    });
    await page.route(`**/api/chat/threads/${fixtureUuid(2)}/read`, route => {
      target = (route.request().postDataJSON() as { messageId: number }).messageId;
      held.resolve(route);
    });
    await page.goto(`${root}?thread=${fixtureUuid(2)}`);
    const request = await within(held.promise, "The safe watermark must be acknowledged");
    acknowledged = true;
    await request.fulfill({ json: { readMessageId: target, unread: true } });
    await painted(page);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const row = rowFor(page, refreshedTitle);
    await row.waitFor();
    assert.equal(await row.locator(".chat-unread-dot").count(), 1, "A fresh explicit unread=true survives an equal safe watermark");
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
    console.log("PASS: fresh unread state survives acknowledgement of the safe watermark");
  }

  assert.deepEqual(errors, []);
  console.log(`Chat read browser smoke passed (${development ? "development" : "production"})`);
} finally {
  server.kill("SIGTERM");
  await stopped;
  await browser.close();
}
