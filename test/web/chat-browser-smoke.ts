import { fixtureUuid } from "./uuid-fixtures.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { chromium, type Route } from "playwright-core";
import type { ChatHistory, ChatSettings, ChatThread } from "../../src/web/chat-types.js";
import { MAX_FILE_BYTES } from "../../src/files/limits.js";
import { deferred } from "../helpers/async.js";
import { savedRestaurantOpenUi } from "./openui-saved-fixture.js";

// Real Bun HTTP assets; only the authenticated chat API uses controlled fixtures.
const development = !process.argv.includes("--production");
const browser = await chromium.launch({ headless: true });
const server = spawn(process.execPath, ["test/web/http-smoke.ts", "--browser", ...(development ? ["--web-dev"] : [])], {
  stdio: ["ignore", "pipe", "inherit"], timeout: 120_000,
});
const stopped = once(server, "exit");
try {
  let preview: string | undefined;
  for await (const line of createInterface({ input: server.stdout })) {
    if (line.startsWith("Preview: ")) { preview = line.slice("Preview: ".length); break; }
  }
  assert.ok(preview);
  const root = new URL("/", preview).href;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  const remoteRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith(root)) remoteRequests.push(request.url()); });

  let userId: number | null = 1001;
  let sessionReads = 0;
  let posts = 0;
  let holdSend: ReturnType<typeof deferred<Route>> | undefined;
  let holdCreate: ReturnType<typeof deferred<Route>> | undefined;
  let holdFork: ReturnType<typeof deferred<Route>> | undefined;
  let holdLogout: ReturnType<typeof deferred<Route>> | undefined;
  const profile = (id: number) => ({ id, name: id === 1001 ? "Alice" : "Bob", username: null });
  const settings = new Map<number, ChatSettings>();
  const reads: Array<{ userId: number; threadId: string; messageId: number }> = [];
  const thread = (index: number, owner: number): ChatThread => ({
    id: fixtureUuid(index), userId: owner, title: `Chat ${index}`, origin: "web", topicId: null, parentThreadId: null, forkPointMessageId: null,
    archived: false, lastActivity: Date.now(), activity: null,
    unread: index === 1 && !reads.some(read => read.userId === owner && read.messageId >= 284), lastMessageId: index === 1 ? 284 : null,
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/chat/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/chat/session") {
      if (request.method() === "DELETE") {
        if (holdLogout) { holdLogout.resolve(route); return; }
        userId = null;
        return json(route, { authenticated: false, loginAvailable: true });
      }
      sessionReads++;
      return json(route, userId === null ? { authenticated: false, loginAvailable: true }
        : { authenticated: true, user: profile(userId), botUsername: "preview_bot", admin: false });
    }
    if (userId === null || request.headers()["x-chat-user"] !== String(userId)) return json(route, { error: "Account changed." }, 401);
    if (url.pathname === "/api/chat/avatar") return route.fulfill({ status: 204 });
    if (url.pathname === "/api/chat/settings") {
      const current = settings.get(userId) ?? { language: "en", timeZone: null, timezoneOffsetMinutes: null, streaming: true, memoryEnabled: true };
      if (request.method() === "PATCH") {
        assert.equal(request.headers()["x-chat-request"], "1");
        settings.set(userId, { ...current, ...request.postDataJSON() });
      }
      return json(route, settings.get(userId) ?? current);
    }
    if (url.pathname === "/api/chat/threads") {
      if (request.method() === "POST") {
        assert.ok(holdCreate, "Unexpected new-chat submission");
        holdCreate.resolve(route);
        return;
      }
      return json(route, { items: [thread(1, userId)], nextOffset: null });
    }
    if (url.pathname.endsWith("/read")) {
      assert.equal(request.method(), "POST");
      assert.equal(request.headers()["x-chat-request"], "1");
      const { messageId } = request.postDataJSON() as { messageId: number };
      assert.ok(Number.isSafeInteger(messageId) && messageId > 0 && messageId <= 284, `Acknowledged an unrendered message: ${messageId}`);
      reads.push({ userId, threadId: url.pathname.split("/")[4]!, messageId });
      return json(route, { readMessageId: messageId, unread: messageId < 284 });
    }
    if (url.pathname.endsWith("/fork")) {
      assert.ok(holdFork, "Unexpected fork");
      holdFork.resolve(route);
      return;
    }
    if (url.pathname.endsWith("/messages")) {
      if (request.method() === "POST") {
        posts++;
        assert.ok(holdSend, "A revoked new-chat callback must not submit its first message");
        holdSend.resolve(route);
        return;
      }
      const history: ChatHistory = {
        user: { ...profile(userId), lastActivity: Date.now(), threadCount: 1 }, thread: thread(1, userId), chain: [],
        messages: [
          { id: 1, threadId: fixtureUuid(1), role: "user", text: "A saved message", thinking: null, attachments: [], createdAt: Date.now(), telegramSyncFailed: true },
          { id: 284, threadId: fixtureUuid(1), role: "assistant", text: "Restaurant comparison fallback", thinking: null, attachments: [], createdAt: Date.now(), openui: savedRestaurantOpenUi },
        ],
        olderCursor: null, newerCursor: null, autoLoadMaxBytes: 0, maxFileBytes: MAX_FILE_BYTES,
        draft: { text: "**Live answer** <script>window.leaked = true</script>", thinking: "Thinking about the answer", toolActivity: { version: 1, omittedCalls: 0, reasoning: [],
          calls: [{ id: "tool-1", name: "web_search", status: "running", durationMs: null, args: { format: "json", text: JSON.stringify({ query: "<img src=x onerror=leaked=1>" }), truncated: false }, result: null }] } },
      };
      return json(route, history);
    }
    throw new Error(`Unexpected fixture request: ${request.method()} ${url.pathname}`);
  });
  await page.goto(root);
  const account = (name: string) => page.getByRole("button", { name: `Account: ${name}`, exact: true });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const signOut = async (name: string) => {
    await account(name).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  };
  const recheck = async (id: number) => {
    userId = id;
    await page.evaluate(() => window.dispatchEvent(new Event("chat-session-expired")));
    await account(profile(id).name).waitFor();
  };
  await account("Alice").waitFor();
  assert.equal(await page.evaluate(() => typeof Reflect.get(globalThis, "process")), "undefined");
  assert.equal(await page.locator("[data-openui-devtools-auto-mount]").count(), 0);
  const scripts = await page.locator("script[src]").evaluateAll(nodes => nodes.map(node => node.getAttribute("src")!));
  for (const script of scripts) {
    const source = await (await page.request.get(new URL(script, root).href)).text();
    assert(!source.includes('process.env["NODE_ENV"]'), "Dev bundle must not reference a Node-only global");
    assert(!source.includes("cdn.jsdelivr.net/npm/@openuidev/devtools"), "Devtools must not enter the browser bundle");
  }

  await composer.fill("Alice home draft");
  await page.locator('input[type="file"]').setInputFiles({ name: "alice-private.txt", mimeType: "text/plain", buffer: Buffer.from("Alice private file") });
  await page.getByRole("button", { name: "Chat 1", exact: false }).click();
  await page.getByRole("article", { name: "Assistant response in progress" }).waitFor();
  await page.getByRole("note").filter({ hasText: "Could not sync this message to Telegram." }).waitFor();
  const comparison = page.getByRole("table", { name: "Downtown Bellevue, WA · Quick picks", exact: true });
  await comparison.waitFor();
  assert.equal(await comparison.locator("tbody tr").count(), 4);
  assert.equal(await comparison.locator("td").count(), 16);
  assert(await page.getByText("Restaurant comparison fallback", { exact: true }).isVisible());
  assert.equal(await page.evaluate(() => Reflect.get(window, "leaked")), undefined);
  // Live tool calls use the finished-response renderer with readable names.
  const live = page.getByRole("article", { name: "Assistant response in progress" });
  // Collapsed, the chain names the running step; expanded, it lists that call.
  await live.locator(".chain-label", { hasText: "Search the web" }).waitFor();
  await live.locator("button.chain-trigger").click();
  await live.locator(".tool-call-name", { hasText: "Search the web" }).waitFor();
  await live.getByText("Running", { exact: true }).waitFor();
  assert.equal(await live.getByText("web_search", { exact: true }).count(), 0);
  // Opening the chat in a focused tab acknowledges only the newest rendered stored message, for this account.
  await page.waitForFunction(() => !document.querySelector(".chat-thread.is-unread"));
  assert.deepEqual(reads.filter(read => read.userId === 1001), [{ userId: 1001, threadId: fixtureUuid(1), messageId: 284 }]);
  holdSend = deferred<Route>();
  await composer.fill("Alice delayed message");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const pendingSend = await holdSend.promise;

  // A private 401 cannot race a successful logout back into an authenticated view.
  holdLogout = deferred<Route>();
  await signOut("Alice");
  const pendingLogout = await holdLogout.promise;
  const readsBefore = sessionReads;
  await page.evaluate(() => window.dispatchEvent(new Event("chat-session-expired")));
  assert.equal(sessionReads, readsBefore);
  userId = null;
  await json(pendingLogout, { authenticated: false, loginAvailable: true });
  holdLogout = undefined;
  await page.getByRole("link", { name: "Sign in with Telegram", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("chat-draft:"))), []);

  // Reauthenticate in the same document so a module-level Map cannot hide behind a reload.
  await recheck(1002);
  await json(pendingSend, { error: "Delayed Alice send failed." }, 500);
  holdSend = undefined;
  await page.getByRole("button", { name: "Chat 1", exact: false }).click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), "");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  assert.equal(await composer.inputValue(), "");
  assert.equal(await page.getByText("alice-private.txt", { exact: true }).count(), 0);
  assert(!JSON.stringify(await page.evaluate(() => ({ ...sessionStorage }))).includes("Alice"));

  // A late new-chat response cannot queue or auto-send the previous user's draft.
  await recheck(1001);
  holdCreate = deferred<Route>();
  await composer.fill("Alice queued first message");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const pendingCreate = await holdCreate.promise;
  await signOut("Alice");
  await page.getByRole("link", { name: "Sign in with Telegram", exact: true }).waitFor();
  await recheck(1002);
  const bobUrl = page.url();
  await json(pendingCreate, thread(20, 1001), 201);
  holdCreate = undefined;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(page.url(), bobUrl);
  assert.equal(posts, 1);
  assert.equal(await composer.inputValue(), "");

  // A completed fork must not navigate the next user's workspace either.
  await recheck(1001);
  await page.getByRole("button", { name: "Chat 1", exact: false }).click();
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Fork chat", exact: true }).click();
  holdFork = deferred<Route>();
  await page.getByRole("button", { name: "Fork chat", exact: true }).click();
  const pendingFork = await holdFork.promise;
  // The modal keeps the account menu inert; session expiration exercises the same revocation.
  await recheck(1002);
  const beforeFork = page.url();
  await json(pendingFork, thread(30, 1001), 201);
  holdFork = undefined;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(page.url(), beforeFork);
  assert.equal(await page.getByRole("button", { name: "Chat 30", exact: false }).count(), 0);

  // Another tab can replace the cookie while this document still belongs to Alice.
  await recheck(1001);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await composer.fill("Alice draft before another tab changed accounts");
  userId = 1002;
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await account("Bob").waitFor();
  assert.equal(await composer.inputValue(), "");
  assert.equal(posts, 1);

  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, []);
  console.log(`Chat browser smoke passed (${development ? "development" : "production"}): real HTTP bundle, no process global/CDN, live draft, logout race, user-scoped drafts/files, late send/create/fork callbacks, changed account assertion`);
} finally {
  server.kill("SIGTERM");
  await stopped;
  await browser.close();
}
