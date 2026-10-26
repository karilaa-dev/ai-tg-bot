import { fixtureUuid } from "./uuid-fixtures.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { chromium, type Route } from "playwright-core";
import type { ChatHistory, ChatSettings } from "../../src/web/chat-types.js";
import { deferred } from "../helpers/async.js";

// Uses the real chat app and the in-memory preview on a private ephemeral port.
// CHAT_PREVIEW_ASSETS can point at a temporary production build without touching dist/web.
const development = !process.argv.includes("--production");
const browser = await chromium.launch({ headless: true });
const server = spawn(process.execPath, ["test/web/chat-preview.ts", ...(development ? ["--dev"] : [])], {
  env: { ...process.env, CHAT_PREVIEW_PORT: "0" }, stdio: ["ignore", "pipe", "inherit"], timeout: 180_000,
});
const stopped = once(server, "exit");
try {
  let preview: string | undefined;
  for await (const line of createInterface({ input: server.stdout })) {
    if (line.startsWith("Chat preview: ")) { preview = line.slice("Chat preview: ".length).split(" ")[0]; break; }
  }
  assert.ok(preview, "Preview must announce its private URL");
  const root = preview;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "UTC" });
  page.setDefaultTimeout(10_000);
  await page.clock.install();
  const errors: string[] = [];
  const remote: string[] = [];
  const requests: { path: string; method: string; user: string | undefined; write: string | undefined }[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (!request.url().startsWith(root) && !request.url().startsWith("blob:")) remote.push(request.url());
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push({ path: url.pathname + url.search, method: request.method(), user: request.headers()["x-chat-user"], write: request.headers()["x-chat-request"] });
  });
  // Put real usage data in the response, so its absence in the UI is meaningful.
  await page.route(`**/api/chat/threads/${fixtureUuid(1)}/messages*`, async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const history: ChatHistory = await response.json();
    if (!Array.isArray(history.messages)) return route.fulfill({ response, json: history });
    for (const message of history.messages) if (message.role === "assistant") message.usage = {
      inputTokens: 1200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1600,
      reasoningTokens: 0, cacheReadRatio: 0, recordedTurns: 1, missingUsageTurns: 0, unpricedTurns: 0,
      estimatedCostUsd: 12.34, fastModeCalls: 0, standardModeCalls: 1, unknownFastModeCalls: 0,
      cacheReadReportedCalls: 1, cacheWriteReportedCalls: 1, cacheReadUnreportedCalls: 0, cacheWriteUnreportedCalls: 0,
      aggregateUsageEntries: 0, models: [], modelCalls: 1,
    };
    await route.fulfill({ response, json: history });
  });
  await page.goto(root);
  await page.getByRole("button", { name: "Account: Alice Morgan", exact: true }).waitFor();
  const sidebar = page.locator(".chat-sidebar");
  for (const label of ["Today", "Yesterday", "Previous 7 days", "Last 30 days"]) {
    await sidebar.getByRole("list", { name: label, exact: true }).waitFor();
  }
  await sidebar.getByRole("button", { name: "Show more", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".chat-thread").length === 30);
  await sidebar.getByRole("button", { name: "Show more", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".chat-thread").length === 36);
  assert.equal(await sidebar.getByRole("button", { name: "Show more", exact: true }).count(), 0);
  assert(await sidebar.locator(".chat-thread-group").count() > 4, "Older chats have calendar month groups");
  const rows = await sidebar.locator(".chat-thread").evaluateAll(items => items.map(row => {
    const icon = row.querySelector(".chat-thread-origin svg");
    const title = row.querySelector(".chat-thread-title")!;
    const dot = row.querySelector(".chat-unread-dot");
    const time = row.querySelector("time");
    return { title: title.textContent, telegram: Boolean(icon), iconFirst: Boolean(icon && icon.getBoundingClientRect().right <= title.getBoundingClientRect().left),
      dot: Boolean(dot), dotBeforeTime: !dot || !time || dot.getBoundingClientRect().right <= time.getBoundingClientRect().left,
      sr: row.querySelector(".sr-only")?.textContent ?? "" };
  }));
  for (const row of rows) {
    assert.equal(row.telegram, row.sr.includes("started in Telegram"), `${row.title}: Telegram icon only for Telegram chats`);
    if (row.telegram) assert(row.iconFirst, `${row.title}: Telegram icon precedes the title`);
    assert.equal(row.dot, row.sr.includes("unread"), `${row.title}: blue dot only when unread`);
    assert(row.dotBeforeTime);
  }
  assert.deepEqual(rows.filter(row => row.dot).map(row => row.title).sort(), ["Compare two laptop options"]);
  assert(rows.some(row => !row.telegram) && rows.some(row => row.telegram));

  await sidebar.getByRole("button", { name: /Planning the autumn trip/ }).click();
  const reply = page.locator('article[data-role="assistant"]').filter({ hasText: "Here's a starting point" });
  await reply.getByRole("group", { name: "Response actions", exact: true }).waitFor();
  assert.equal(await page.getByText("Assistant", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Usage", { exact: true }).count(), 0);
  assert.equal(await page.locator(".message-usage").count(), 0);
  assert(!(await reply.innerText()).includes("12.34"));
  const actions = reply.getByRole("group", { name: "Response actions", exact: true });
  assert.equal(await actions.locator("svg.tabler-icon").count(), 2);
  assert(await reply.evaluate(article => {
    const footer = article.querySelector("footer");
    return footer && [...article.querySelectorAll(".chat-prose, .chat-openui, .chat-attachments")].every(content => footer.getBoundingClientRect().top >= content.getBoundingClientRect().bottom - 1);
  }), "Copy/fork actions render below all reply content");
  await page.getByRole("button", { name: "Chat actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Fork chat", exact: true }).waitFor();
  assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Fork chat", "Compact context", "Schedule…"]);
  await page.keyboard.press("Escape");
  // One chain line with the reply's duration opens reasoning and calls in the order they happened.
  const chain = reply.getByRole("button", { name: "Worked for 32s", exact: true });
  assert.equal(await chain.getAttribute("aria-expanded"), "false");
  // A collapsed chain is shrink-wrapped; its chevron must still sit inside the hover box.
  assert(await chain.evaluate(button => button.querySelector(".chain-chevron")!.getBoundingClientRect().right <= button.getBoundingClientRect().right - 4),
    "Collapsed chain chevron stays inside its button");
  await chain.click();
  await reply.locator(".tool-call-name").first().waitFor();
  assert.deepEqual(await reply.locator(".tool-call-name").allTextContents(), ["Search the web", "Run a command"]);
  assert.deepEqual(await reply.locator(".chain-step").evaluateAll(steps => steps.map(step => step.getAttribute("data-kind"))), ["reasoning", "tool", "reasoning", "tool", "reasoning"]);
  assert.equal(await reply.locator(".chain-panel").getByText("web_search", { exact: true }).count(), 0);
  const bash = reply.locator('.tool-call[data-tool="bash"]');
  await bash.locator("summary").click();
  await bash.getByRole("heading", { name: "Command", exact: true }).waitFor();
  assert.equal(await bash.getByRole("region", { name: "bash code", exact: true }).innerText(), "python3 -c 'print(7 * 2)'  ");
  await bash.getByRole("heading", { name: "Output", exact: true }).waitFor();
  const cancelled = page.locator('article[data-role="assistant"]').filter({ has: page.getByRole("button", { name: "Stopped after 26s", exact: true }) });
  await cancelled.locator(".chain-trigger").click();
  await cancelled.getByText("Cancelled", { exact: true }).waitFor();
  assert.equal(await cancelled.locator("footer").count(), 0);
  const picture = page.getByRole("img", { name: "Map of the two-day lakeside route", exact: true });
  await picture.waitFor();
  await picture.evaluate(async image => { if (!(image instanceof HTMLImageElement)) throw new Error("Expected loaded OpenUI image"); await image.decode(); });
  assert((await picture.getAttribute("src"))?.startsWith("blob:"));
  const images = requests.filter(request => request.path.includes(`/files/${fixtureUuid(502)}`));
  assert(images.length > 0 && images.every(request => request.path === `/api/chat/threads/${fixtureUuid(1)}/files/${fixtureUuid(502)}?mode=auto` && request.method === "GET" && request.user === "1001"));
  console.log("PASS: groups/paging, source dots, no labels/usage, reply actions, Tabler, nested tools/cancellation, scoped OpenUI image");

  // Freeze only browser time: Enter must start the search without the 250 ms debounce.
  const heldSearch = deferred<Route>();
  await page.route("**/api/chat/threads?**", route => {
    if (new URL(route.request().url()).searchParams.get("q") === "spinach") { heldSearch.resolve(route); return; }
    return route.continue();
  });
  await page.getByRole("button", { name: "Search chats", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Search chats", exact: true });
  const search = palette.getByRole("combobox");
  await search.waitFor();
  // Use the browser's own clock, with room for command delivery, so clock drift cannot make the target stale.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  const beforeSearch = page.url();
  await search.fill("spinach");
  const submitted = page.waitForRequest(request => new URL(request.url()).searchParams.get("q") === "spinach");
  await search.press("Enter");
  await submitted;
  const pendingSearch = await heldSearch.promise;
  assert.equal(page.url(), beforeSearch);
  assert(await palette.isVisible());
  assert(await palette.locator(".chat-search-item").evaluateAll(items => items.length > 0 && items.every(item => item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled"))), "Pending results cannot be selected");
  const pagesBefore = page.context().pages().length;
  await search.press("Control+Enter");
  assert.equal(page.context().pages().length, pagesBefore);
  assert.equal(page.url(), beforeSearch);
  await page.clock.resume();
  await pendingSearch.continue();
  const bodyMatch = palette.getByRole("option", { name: /Weekly grocery list/ });
  await bodyMatch.waitFor();
  await bodyMatch.click();
  await page.getByRole("heading", { name: "Weekly grocery list", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("thread"), fixtureUuid(2));
  // Telegram-origin chats never display unread status or send web acknowledgements.
  await page.waitForFunction(() => [...document.querySelectorAll(".chat-thread")].some(row => row.textContent?.includes("Weekly grocery list") && !row.querySelector(".chat-unread-dot")));
  const acks = requests.filter(request => request.path === `/api/chat/threads/${fixtureUuid(2)}/read`);
  assert.equal(acks.length, 0);
  assert(acks.every(request => request.method === "POST" && request.write === "1" && request.user === "1001"));
  assert.equal(requests.filter(request => request.path === `/api/chat/threads/${fixtureUuid(1)}/read`).length, 0, "Already-read chats are not acknowledged again");
  await page.unroute("**/api/chat/threads?**");
  // This query matches message bodies in all 32 older chats, requiring remote pagination.
  await page.getByRole("button", { name: "Search chats", exact: true }).click();
  await search.fill("Saved");
  await palette.getByRole("option", { name: /Trip budget spreadsheet/ }).waitFor();
  for (const count of [30, 32]) {
    await palette.locator(".chat-search-more").scrollIntoViewIfNeeded();
    await page.waitForFunction(expected => document.querySelectorAll(".chat-search-item").length === expected, count);
  }
  assert.equal(await palette.getByRole("option").count(), 32);
  await search.press("Escape");
  console.log("PASS: immediate Enter flushes debounce, pending results reject normal/modifier Enter, body matches and search paging");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Language", exact: true }).click();
  const savedLanguage = page.waitForResponse(response => response.url().endsWith("/api/chat/settings") && response.request().method() === "PATCH");
  await page.getByRole("option", { name: "Русский", exact: true }).click();
  assert.equal((await savedLanguage).status(), 200);
  await page.getByRole("heading", { name: "Настройки", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Настройки", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  const persisted: ChatSettings = await (await page.request.get(new URL("/api/chat/settings", root).href)).json();
  assert.equal(persisted.language, "ru");
  const telegramLanguage = async (language: ChatSettings["language"]) => {
    const response = await page.request.post(new URL("/__preview/settings", root).href, { data: { language } });
    assert.equal(response.status(), 200);
    // Focus refresh is throttled for two seconds; virtual time avoids a real wait.
    await page.clock.fastForward(2_100);
    const refresh = page.waitForResponse(response => response.url().endsWith("/api/chat/settings") && response.request().method() === "GET");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refresh;
    await page.waitForFunction(expected => document.documentElement.lang === expected, language);
  };
  await telegramLanguage("en");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  console.log("PASS: Russian settings persist through reload and mounted settings follow simulated Telegram language changes");

  // Without a saved time zone the chat asks once, proposing this device's named zone rather than a bare offset.
  const west = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "America/Los_Angeles" });
  west.setDefaultTimeout(10_000);
  west.on("pageerror", error => errors.push(error.message));
  await west.goto(root);
  const zonePrompt = west.getByRole("region", { name: "Set your time zone", exact: true });
  await zonePrompt.getByText(/^This device is set to America\/Los_Angeles, where it's \d{1,2}:\d{2} [AP]M \(UTC−[78]\)\./).waitFor();
  await zonePrompt.getByRole("button", { name: "Not now", exact: true }).click();
  await zonePrompt.waitFor({ state: "detached" });
  await west.reload();
  await west.getByRole("button", { name: "Account: Alice Morgan", exact: true }).waitFor();
  assert.equal(await zonePrompt.count(), 0, "Not now is remembered on this device");
  await west.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("chat-zone-prompt-dismissed:")) localStorage.removeItem(key); });
  await west.reload();
  const savedZone = west.waitForResponse(response => response.url().endsWith("/api/chat/settings") && response.request().method() === "PATCH");
  await zonePrompt.getByRole("button", { name: "Use America/Los_Angeles", exact: true }).click();
  assert.deepEqual((await savedZone).request().postDataJSON(), { timeZone: "America/Los_Angeles" });
  await zonePrompt.getByText("Time zone set to America/Los_Angeles.", { exact: false }).first().waitFor();
  const zoned: ChatSettings = await (await west.request.get(new URL("/api/chat/settings", root).href)).json();
  assert.equal(zoned.timeZone, "America/Los_Angeles");
  assert.ok(zoned.timezoneOffsetMinutes === -420 || zoned.timezoneOffsetMinutes === -480, "The named zone carries its current offset");
  await west.close();
  console.log("PASS: a missing time zone is asked for once, Not now persists, and the device's named zone saves");

  await page.getByRole("button", { name: "Memories", exact: true }).click();
  await page.getByText("53 saved notes", { exact: true }).waitFor();
  assert.equal(await page.locator(".memory-list > li").count(), 50);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Delete note #52", exact: true }).waitFor();
  await page.getByText("Page 2 of 2", { exact: true }).waitFor();
  assert.equal(await page.locator(".memory-list > li").count(), 3);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByRole("button", { name: "Delete note #0", exact: true }).waitFor();
  let failDelete = true;
  const heldDelete = deferred<Route>();
  await page.route("**/api/chat/memories/0", route => {
    assert.equal(route.request().method(), "DELETE");
    if (failDelete) { failDelete = false; return route.abort("failed"); }
    heldDelete.resolve(route);
  });
  await page.getByRole("button", { name: "Delete note #0", exact: true }).click();
  const removal = page.getByRole("dialog");
  await removal.getByRole("button", { name: "Delete", exact: true }).click();
  await removal.getByText("Could not delete this memory.", { exact: true }).waitFor();
  await telegramLanguage("ru");
  await removal.getByRole("heading", { name: "Удалить это воспоминание?", exact: true }).waitFor();
  await removal.getByText("Не удалось удалить воспоминание.", { exact: true }).waitFor();
  assert.equal(await removal.getByText("Could not delete this memory.", { exact: true }).count(), 0);
  await removal.getByRole("button", { name: "Удалить", exact: true }).click();
  const pendingDelete = await heldDelete.promise;
  await telegramLanguage("en");
  await pendingDelete.continue();
  await page.getByText("Memory deleted.", { exact: true }).waitFor();
  await page.getByText("52 saved notes", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Delete note #0", exact: true }).count(), 0);
  await telegramLanguage("ru");
  await page.getByText("Воспоминание удалено.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Memory deleted.", { exact: true }).count(), 0);
  const refreshedMemories = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat/memories");
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await refreshedMemories;
  await page.getByText("52 сохранённые записи", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Удалить запись №0", exact: true }).count(), 0);
  console.log("PASS: memory paging and zero-ID deletion; mounted errors, in-flight success, and existing notices follow the current locale");

  // Any file type uploads; live tool calls update in place while their sections stay expanded (Russian UI).
  await sidebar.getByRole("button", { name: /Planning the autumn trip/ }).click();
  const composer = page.getByRole("textbox", { name: "Сообщение", exact: true });
  await composer.waitFor();
  const uploads = [
    { name: "photos.zip", mimeType: "application/zip", buffer: Buffer.from("PK\u0003\u0004") },
    { name: "setup.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") },
    { name: "clip.mov", mimeType: "video/quicktime", buffer: Buffer.from("moov") },
    { name: "report.doc", mimeType: "application/msword", buffer: Buffer.from("\u00d0\u00cf\u0011\u00e0") },
    { name: "notes", mimeType: "", buffer: Buffer.from("plain") },
  ];
  await page.locator('input[type="file"]').setInputFiles(uploads);
  assert.equal(await page.locator('input[type="file"]').getAttribute("accept"), null);
  for (const upload of uploads) await page.locator(".chat-file-chip").filter({ hasText: upload.name }).waitFor();
  assert.equal(await page.locator(".chat-composer-problem").count(), 0);
  await composer.fill("Проверь эти файлы");
  await page.getByRole("button", { name: "Отправить сообщение", exact: true }).click();
  for (const upload of uploads) await page.locator('article[data-role="user"] .file-card').filter({ hasText: upload.name }).first().waitFor();
  const live = page.locator('article[data-live="true"]');
  await live.locator("button.chain-trigger").click({ timeout: 6_000 });
  const searchCall = live.locator('.tool-call[data-tool="web_search"]');
  await searchCall.locator(".tool-call-name").filter({ hasText: "Поиск в интернете" }).waitFor();
  await searchCall.locator("summary").click();
  await searchCall.getByText("Выполняется", { exact: true }).waitFor();
  await searchCall.getByRole("heading", { name: "Аргументы", exact: true }).waitFor();
  await searchCall.getByText("Выполнено", { exact: true }).waitFor({ timeout: 8_000 });
  assert(await searchCall.evaluate(node => (node as HTMLDetailsElement).open), "Expanded call stays open across live snapshots");
  await searchCall.getByRole("heading", { name: "Результат", exact: true }).waitFor();
  const commandCall = live.locator('.tool-call[data-tool="bash"]');
  await commandCall.locator(".tool-call-name").filter({ hasText: "Выполнение команды" }).waitFor();
  await commandCall.locator("summary").click();
  await commandCall.getByText("day 1", { exact: false }).waitFor();
  await commandCall.getByText("Выполнено", { exact: true }).waitFor({ timeout: 8_000 });
  assert(await commandCall.evaluate(node => (node as HTMLDetailsElement).open));
  assert.match(await commandCall.innerText(), /day 3/);
  assert.equal(await live.locator(".chain-trigger").getAttribute("aria-expanded"), "true");
  await page.locator('article[data-role="assistant"]').filter({ hasText: "Вы написали: «Проверь эти файлы»" }).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('article[data-live="true"]').count(), 0);
  await page.screenshot({ path: "/tmp/ai-tg-polish-live-ru.png" });
  console.log("PASS: arbitrary file types upload; live tool calls show friendly Russian names and update while expanded");

  // Mobile: the sidebar shows Telegram marks and unread dots; reading on a phone clears the dot.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ru-RU" });
  const mobileErrors: string[] = [];
  const mobileReads: string[] = [];
  mobile.on("pageerror", error => mobileErrors.push(error.message));
  mobile.on("request", request => { if (request.url().endsWith("/read")) mobileReads.push(new URL(request.url()).pathname); });
  await mobile.goto(root);
  await mobile.getByRole("button", { name: "Открыть чаты", exact: true }).first().click();
  const laptop = mobile.locator(".chat-thread").filter({ hasText: "Compare two laptop options" });
  await laptop.locator(".chat-unread-dot").waitFor();
  const grocery = mobile.locator(".chat-thread").filter({ hasText: "Weekly grocery list" });
  await grocery.locator(".chat-thread-origin svg").waitFor();
  assert.equal(await grocery.locator(".chat-unread-dot").count(), 0, "Read state is shared with the other tab");
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await mobile.waitForTimeout(500);
  await mobile.screenshot({ path: "/tmp/ai-tg-polish-mobile-sidebar.png" });
  await laptop.click();
  await mobile.getByRole("heading", { name: "Compare two laptop options", exact: true }).waitFor();
  if (!mobileReads.length) await mobile.waitForRequest(request => request.url().endsWith(`/api/chat/threads/${fixtureUuid(3)}/read`), { timeout: 5_000 });
  assert.deepEqual(mobileReads, [`/api/chat/threads/${fixtureUuid(3)}/read`]);
  await mobile.getByRole("button", { name: "Открыть чаты", exact: true }).first().click();
  await laptop.waitFor();
  assert.equal(await laptop.locator(".chat-unread-dot").count(), 0);
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await mobile.waitForTimeout(500);
  await mobile.screenshot({ path: "/tmp/ai-tg-polish-mobile-read.png" });

  await laptop.click();
  const compact = async () => {
    await mobile.getByRole("button", { name: "Действия с чатом", exact: true }).click();
    await mobile.getByRole("menuitem", { name: "Сжать контекст", exact: true }).click();
    await mobile.getByRole("dialog").getByRole("button", { name: "Сжать", exact: true }).click();
  };
  await compact();
  await mobile.locator('.chat-thread-action[data-state="running"]').waitFor();
  await mobile.waitForFunction(() => document.querySelector(".chat-thread-action-time")?.textContent !== "0:00");
  await mobile.getByRole("button", { name: "Действия с чатом", exact: true }).click();
  assert.equal(await mobile.getByRole("menuitem", { name: "Сжать контекст", exact: true }).getAttribute("aria-disabled"), "true");
  await mobile.reload();
  await mobile.locator('.chat-thread-action[data-state="running"]').waitFor();
  await mobile.locator('.chat-thread-action[data-state="succeeded"]').waitFor({ timeout: 8_000 });
  const elapsed = await mobile.locator(".chat-thread-action-time").innerText();
  assert.match(elapsed, /^0:0[5-9]$/);
  await mobile.reload();
  await mobile.getByText("Контекст сжат", { exact: true }).waitFor();
  assert.equal(await mobile.locator(".chat-thread-action-time").innerText(), elapsed);
  await compact();
  await mobile.getByText("Сжатие пока не нужно", { exact: true }).waitFor();
  await mobile.getByText("Контекст только что сжат. Подождите минуту и продолжите общение.", { exact: true }).waitFor();
  assert.equal(await mobile.locator('.chat-thread-action[data-state="succeeded"]').count(), 1);
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log("PASS: compaction action timer, refresh during work, saved duration, and repeat guard in the mobile Russian chat");

  assert.deepEqual(mobileErrors, []);
  await mobile.close();
  console.log("PASS: mobile Russian sidebar with Telegram marks, unread dot cleared after viewing");

  assert(requests.filter(request => request.path.startsWith("/api/chat/") && !request.path.startsWith("/api/chat/session")).every(request => request.user === "1001"));
  assert(requests.filter(request => ["DELETE", "PATCH"].includes(request.method)).every(request => request.write === "1"));
  assert(!requests.some(request => request.path.includes("/usage")));
  assert.deepEqual(remote, []);
  assert.deepEqual(errors, []);
  console.log(`Chat polish browser smoke passed (${development ? "development" : "production"})`);
} finally {
  server.kill("SIGTERM");
  await stopped;
  await browser.close();
}
