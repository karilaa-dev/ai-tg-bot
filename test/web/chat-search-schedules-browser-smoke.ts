import { fixtureUuid } from "./uuid-fixtures.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { ChatHistory, ChatSchedule, ChatScheduleInput, ChatThread } from "../../src/web/chat-types.js";
import type { WebPage } from "../../src/web/types.js";

// Real client against the in-memory preview; search snippets and schedules are layered on with routes.
const development = !process.argv.includes("--production");
const browser = await chromium.launch({ headless: true });
const server = spawn(process.execPath, ["--no-env-file", "test/web/chat-preview.ts", ...(development ? ["--dev"] : [])], {
  env: { ...process.env, CHAT_PREVIEW_PORT: "0" }, stdio: ["ignore", "pipe", "inherit"], timeout: 120_000,
});
const stopped = once(server, "exit");
const errors: string[] = [];

try {
  let root: string | undefined;
  for await (const line of createInterface({ input: server.stdout })) {
    if (line.startsWith("Chat preview: ")) { root = line.slice("Chat preview: ".length).split(" ")[0]; break; }
  }
  assert.ok(root, "Preview must announce its private URL");
  const rootUrl = root;

  const reads: string[] = [];
  const histories: string[] = [];
  const scheduleWrites: { method: string; path: string; body: unknown; csrf: string | null }[] = [];
  let schedules: ChatSchedule[] = [];

  const openPage = async (viewport = { width: 1280, height: 900 }) => {
    const page = await browser.newPage({ viewport, locale: "en-US", hasTouch: viewport.width < 768 });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/read") && request.method() === "POST") reads.push(url.pathname);
      if (url.pathname.endsWith("/messages") && request.method() === "GET") histories.push(`${url.pathname}${url.search}`);
    });
    await page.route("**/*", route => {
      if (route.request().url().startsWith(rootUrl)) return route.fallback();
      errors.push(`Unexpected external request: ${route.request().url()}`);
      return route.abort();
    });
    // Body matches carry the matching message, as the server reports it.
    await page.route("**/api/chat/threads?**", async route => {
      const query = new URL(route.request().url()).searchParams.get("q")?.toLocaleLowerCase();
      if (!query) return route.fallback();
      const response = await route.fetch();
      const body: WebPage<ChatThread> = await response.json();
      for (const thread of body.items) {
        const history: ChatHistory = await (await fetch(new URL(`/api/chat/threads/${thread.id}/messages`, rootUrl))).json();
        const match = history.messages.find(message => message.text.toLocaleLowerCase().includes(query));
        thread.searchMatch = match ? { messageId: match.id, text: match.text } : null;
      }
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/chat/schedules**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const id = path.split("/")[4];
      const body = request.postData() ? JSON.parse(request.postData()!) : null;
      if (request.method() !== "GET") scheduleWrites.push({ method: request.method(), path, body, csrf: await request.headerValue("X-Chat-Request") });
      if (request.method() === "GET") return route.fulfill({ json: { items: schedules } });
      if (request.method() === "POST") {
        const input = body as ChatScheduleInput;
        const created: ChatSchedule = { id: "schedule-1", ...input, enabled: true, lastRunAt: null, lastTurnId: null, createdAt: Date.now(), updatedAt: Date.now() };
        schedules = [created];
        return route.fulfill({ status: 201, json: created });
      }
      const index = schedules.findIndex(item => item.id === id);
      if (index < 0) return route.fulfill({ status: 404, json: { error: "Not found." } });
      if (request.method() === "PATCH") {
        schedules[index] = { ...schedules[index]!, ...body, updatedAt: Date.now() };
        return route.fulfill({ json: schedules[index] });
      }
      schedules.splice(index, 1);
      return route.fulfill({ json: { deleted: true } });
    });
    return page;
  };

  {
    const page = await openPage();
    await page.goto(root);
    await page.locator(".chat-sidebar .chat-thread").filter({ hasText: "Compare two laptop options" }).waitFor();
    // Read state belongs to web chats only; the unread Telegram chat shows no dot.
    assert.equal(await page.locator(".chat-sidebar .chat-thread").filter({ hasText: "Weekly grocery list" }).locator(".chat-unread-dot").count(), 0);
    assert.equal(await page.locator(".chat-sidebar .chat-thread").filter({ hasText: "Compare two laptop options" }).locator(".chat-unread-dot").count(), 1);
    await page.waitForFunction(() => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href.startsWith("data:image/png"));

    await page.getByRole("button", { name: "Search chats", exact: true }).click();
    const palette = page.getByRole("dialog", { name: "Search chats", exact: true });
    const search = palette.getByRole("combobox");
    await search.waitFor();
    const box = await palette.boundingBox();
    assert(box && box.width > 1000, `Search should be a wide dialog, got ${box?.width}`);
    // Recent chats preview the highlighted row; arrow keys move the preview.
    const preview = palette.locator(".chat-search-preview");
    await preview.getByRole("heading", { name: "Preview of “Planning the autumn trip”" }).waitFor();
    await search.press("ArrowDown");
    await preview.getByRole("heading", { name: "Preview of “Weekly grocery list”" }).waitFor();
    await palette.getByRole("option", { name: /Compare two laptop options/ }).hover();
    await preview.getByRole("heading", { name: "Preview of “Compare two laptop options”" }).waitFor();
    await preview.getByText("For frequent travel").waitFor();
    await preview.getByText("Previewing does not mark messages as read.").waitFor();
    await page.screenshot({ path: "/tmp/uicheck/search-recent.png" });
    await page.waitForTimeout(400);
    assert.equal(reads.length, 0, "Previewing must not acknowledge messages");

    // A body match shows a highlighted snippet, and the preview opens at the matching message.
    await search.fill("spinach");
    const grocery = palette.getByRole("option", { name: /Weekly grocery list.*Telegram chat.*started in Telegram/ });
    await grocery.waitFor();
    assert.equal(await grocery.locator(".chat-search-snippet mark").first().textContent(), "spinach");
    assert.equal(await palette.locator(".chat-search-heading").first().textContent().then(text => text?.startsWith("Results")), true);
    await preview.getByRole("heading", { name: "Preview of “Weekly grocery list”" }).waitFor();
    await preview.locator("[data-match]").filter({ hasText: "Milk, eggs, spinach" }).waitFor();
    assert(histories.some(path => path.startsWith(`/api/chat/threads/${fixtureUuid(2)}/messages?after=`)), "Matches load history from the matching message");
    await page.screenshot({ path: "/tmp/uicheck/search-match.png" });

    // The origin filter narrows results to one source.
    await palette.getByRole("button", { name: "Show chats from: Everything" }).click();
    await page.getByRole("menuitemradio", { name: "Web", exact: true }).click();
    await palette.getByRole("option", { name: /Recipe for mushroom soup|started on the web/ }).first().waitFor({ state: "attached" }).catch(() => undefined);
    const names = await palette.locator(".chat-search-item").evaluateAll(items => items.map(item => item.textContent ?? ""));
    assert(names.every(name => name.includes("started on the web")), `Web filter must hide Telegram chats: ${names.join(" | ")}`);
    await palette.getByRole("button", { name: "Show chats from: Web" }).click();
    await page.getByRole("menuitemradio", { name: "Everything", exact: true }).click();
    await grocery.waitFor();

    // Enter opens the highlighted chat.
    await search.fill("laptop");
    const laptop = palette.getByRole("option", { name: /Compare two laptop options/ });
    await laptop.waitFor();
    await preview.getByRole("heading", { name: "Preview of “Compare two laptop options”" }).waitFor();
    assert.equal(reads.length, 0);
    await search.press("Enter");
    await page.getByRole("heading", { name: "Compare two laptop options", exact: true }).waitFor();
    await palette.waitFor({ state: "hidden" });
    console.log("PASS: wide split search previews without reading, highlights snippets, filters by origin and opens with Enter");

    // Telegram chats are never acknowledged from the web.
    await page.locator(".chat-sidebar .chat-thread").filter({ hasText: "Weekly grocery list" }).click();
    await page.getByRole("heading", { name: "Weekly grocery list", exact: true }).waitFor();
    await page.waitForTimeout(600);
    assert(!reads.includes(`/api/chat/threads/${fixtureUuid(2)}/read`), "Telegram chats are not acknowledged");
    console.log("PASS: unread state and acknowledgements apply only to web chats; favicon is rounded");

    // Schedules from the chat menu.
    await page.locator(".chat-sidebar .chat-thread").filter({ hasText: "Planning the autumn trip" }).click();
    await page.getByRole("heading", { name: "Planning the autumn trip", exact: true }).waitFor();
    await page.getByRole("button", { name: "Chat actions" }).click();
    await page.getByRole("menuitem", { name: "Schedule…" }).click();
    const dialog = page.getByRole("dialog", { name: "Schedule this chat" });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel("Name").inputValue(), "Planning the autumn trip");
    await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
    await dialog.getByText("Enter a prompt for the assistant.").waitFor();
    await dialog.getByLabel("Prompt").fill("Check the weather forecast for the trip.");
    await dialog.getByLabel("First run").fill("2020-01-01T09:00");
    await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
    await dialog.getByText("Choose a time in the future.").waitFor();
    const future = new Date(Date.now() + 3 * 86_400_000);
    const local = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}T09:30`;
    await dialog.getByLabel("First run").fill(local);
    await dialog.getByRole("combobox", { name: "Repeat" }).click();
    await page.getByRole("option", { name: "Custom" }).click();
    await dialog.getByLabel("Hours between runs").fill("0");
    await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
    await dialog.getByText("Enter 1 to 8,760 hours, in whole minutes.").waitFor();
    await dialog.getByLabel("Hours between runs").fill("36");
    await page.screenshot({ path: "/tmp/uicheck/schedule-dialog.png" });
    await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const created = scheduleWrites.find(write => write.method === "POST");
    assert.deepEqual(created?.body, { threadId: fixtureUuid(1), title: "Planning the autumn trip", prompt: "Check the weather forecast for the trip.", intervalMinutes: 2_160,
      nextRunAt: new Date(future.getFullYear(), future.getMonth(), future.getDate(), 9, 30).getTime() });
    assert.equal(created?.csrf, "1");
    await page.getByRole("button", { name: /^Scheduled · next run/ }).waitFor();
    await page.locator(".chat-sidebar .chat-thread").filter({ hasText: "Planning the autumn trip" }).locator(".chat-thread-scheduled").waitFor();
    console.log("PASS: a chat can be scheduled from its menu with validation, custom hours and a header mark");

    // The schedule page shows timing, pauses, edits and deletes.
    await page.getByRole("button", { name: "Scheduled", exact: true }).click();
    await page.getByRole("heading", { name: "Scheduled", exact: true }).waitFor();
    const row = page.locator(".chat-schedule-row").filter({ hasText: "Check the weather forecast" });
    await row.getByText("Every 36 hours").waitFor();
    await row.getByText(/^Next run /).waitFor();
    await row.getByText("Has not run yet").waitFor();
    await page.screenshot({ path: "/tmp/uicheck/schedules.png" });
    await row.getByRole("switch", { name: "Run “Planning the autumn trip” on schedule" }).click();
    await row.getByText("Paused").waitFor();
    assert.deepEqual(scheduleWrites.at(-1)?.body, { enabled: false });
    await row.getByRole("button", { name: "Actions for Planning the autumn trip" }).click();
    await page.getByRole("menuitem", { name: "Edit schedule" }).click();
    const edit = page.getByRole("dialog", { name: "Edit schedule" });
    await edit.getByRole("combobox", { name: "Repeat" }).click();
    await page.getByRole("option", { name: "Every 24 hours" }).click();
    await edit.getByRole("switch", { name: "Active" }).click();
    await edit.getByRole("button", { name: "Save" }).click();
    await edit.waitFor({ state: "hidden" });
    assert.deepEqual(scheduleWrites.at(-1)?.body, { intervalMinutes: 1_440, enabled: true });
    await row.getByText("Every 24 hours").waitFor();
    await row.getByRole("link", { name: "Open chat “Planning the autumn trip”" }).waitFor();
    // A bot-created interval need not be a whole number of hours; editing its name preserves the cadence.
    schedules = schedules.map(item => ({ ...item, intervalMinutes: 90 }));
    await page.reload();
    await row.getByText("Every 90 minutes").waitFor();
    await row.getByRole("button", { name: "Actions for Planning the autumn trip" }).click();
    await page.getByRole("menuitem", { name: "Edit schedule" }).click();
    const preciseEdit = page.getByRole("dialog", { name: "Edit schedule" });
    assert.equal(await preciseEdit.getByLabel("Hours between runs").inputValue(), "1.5");
    await preciseEdit.getByLabel("Name", { exact: true }).fill("Weather check");
    await preciseEdit.getByRole("button", { name: "Save", exact: true }).click();
    await preciseEdit.waitFor({ state: "hidden" });
    assert.deepEqual(scheduleWrites.at(-1)?.body, { title: "Weather check" });
    await row.getByText("Every 90 minutes").waitFor();
    await row.getByRole("button", { name: "Actions for Weather check" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("dialog", { name: "Delete this schedule?" }).getByRole("button", { name: "Delete" }).click();
    await page.getByText("No scheduled chats yet").waitFor();
    assert.equal(scheduleWrites.at(-1)?.method, "DELETE");
    assert.equal(await page.getByRole("button", { name: /^Run now/ }).count(), 0);
    console.log("PASS: schedule page shows repeat and next/last run, pauses, edits, deletes and links to the chat");
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }

  {
    // Narrow screens show one pane at a time; Preview mode makes a tap preview instead of open.
    const page = await openPage({ width: 390, height: 844 });
    const readsBefore = reads.length;
    await page.goto(root);
    await page.getByRole("button", { name: "Open chats" }).click();
    await page.getByRole("button", { name: "Search chats", exact: true }).click();
    const palette = page.getByRole("dialog", { name: "Search chats", exact: true });
    await palette.getByRole("option", { name: /Compare two laptop options/ }).waitFor();
    assert.equal(await palette.locator(".chat-search-preview").count(), 0);
    await palette.getByRole("button", { name: "Preview" }).tap();
    assert.equal(await palette.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed"), "true");
    await palette.getByRole("option", { name: /Compare two laptop options/ }).tap();
    await palette.locator(".chat-search-preview").getByRole("heading", { name: "Preview of “Compare two laptop options”" }).waitFor();
    assert(await palette.locator(".chat-search-results").isHidden());
    await palette.getByRole("button", { name: "Back to results" }).tap();
    await palette.getByRole("option", { name: /Compare two laptop options/ }).waitFor();
    const box = await palette.boundingBox();
    assert(box && box.width <= 390 && box.x >= 0, "Search fits the narrow screen");
    await page.screenshot({ path: "/tmp/uicheck/search-mobile.png" });
    assert.equal(reads.length, readsBefore, "Mobile preview does not acknowledge either");
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
    console.log("PASS: narrow search toggles between list and preview");
  }

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.kill();
  await stopped;
}
