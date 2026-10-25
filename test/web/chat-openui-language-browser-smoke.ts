import assert from "node:assert/strict";
import path from "node:path";
import tailwind from "bun-plugin-tailwind";
import { chromium, type Page } from "playwright-core";
import openUiBrowserPlugin from "../../scripts/openui-browser-plugin.js";
import type { ChatHistory, ChatSettings, ChatThread } from "../../src/web/chat-types.js";
import type { WebAttachment, WebMessage } from "../../src/web/types.js";

// The real chat client: generated views follow each answer's language while the app follows the reader's setting.
const build = await Bun.build({ entrypoints: ["src/web/client/index.html"], target: "browser", minify: true,
  define: { "process.env.NODE_ENV": '"production"' }, plugins: [tailwind, openUiBrowserPlugin] });
if (!build.success) throw new AggregateError(build.logs, "Chat language fixture build failed");
const assets = new Map(build.outputs.map(output => [`/${path.basename(output.path)}`, output]));
const html = build.outputs.find(output => output.path.endsWith(".html"));
assert(html);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const image = (id: number): WebAttachment => ({ id, name: `photo-${id}.png`, size: png.length, mimeType: "image/png", kind: "image", caption: null });
const flow = (title: string, step: string) => `Flow("${title}", [FlowStep("${step}", "", "default"), FlowStep("${step} 2", "", "issue")], "")`;
const answer = (id: number, text: string, openui: string, extra: Partial<WebMessage> = {}): WebMessage =>
  ({ id, threadId: 401, role: "assistant", text, thinking: null, createdAt: 1, attachments: [], openui, ...extra });
const messages: WebMessage[] = [
  answer(501, "The export script selected the weak keys, so the certificates became trusted.",
    `root = Stack([why, picks])\nwhy = ${flow("How the weak keys became trusted", "Export script bug")}\npicks = ItemList("Places", [Item("Bellevue Bistro", "file:601", ["Cafe"], "Quiet patio.", [])])`,
    { openuiLanguage: "en", attachments: [image(601), image(602), { id: 603, name: "report.pdf", size: 2048, mimeType: "application/pdf", kind: "file", caption: null }] }),
  answer(502, "Скрипт экспорта выбрал слабые ключи, поэтому сертификаты стали доверенными.",
    `root = Stack([why, Image("file:604", "Фото ресторана", "")])\nwhy = ${flow("Как слабые ключи стали доверенными", "Ошибка скрипта")}`,
    { openuiLanguage: "ru", attachments: [image(604)] }),
  // Legacy saved answers carry no language; the client infers it from the prose.
  answer(503, "An older English answer saved before language metadata.", `root = Stack([${flow("Legacy English", "Old step")}])`),
  answer(504, "Старый ответ на русском, сохранённый до появления метаданных языка.", `root = Stack([${flow("Старый русский", "Старый шаг")}])`),
];
const labels = { en: { issue: "Failure point", region: "Interactive response" }, ru: { issue: "Точка сбоя", region: "Интерактивный ответ" } } as const;
const answerLanguages = { 501: "en", 502: "ru", 503: "en", 504: "ru" } as const;
let settings: ChatSettings = { language: "ru", timeZone: null, timezoneOffsetMinutes: null, streaming: true, memoryEnabled: true };
const profile = { id: 1001, name: "Alice", username: null };
const thread: ChatThread = { id: 401, userId: 1001, title: "Language mix", origin: "web", topicId: null, parentThreadId: null, forkPointMessageId: null,
  archived: false, lastActivity: 1, activity: null, unread: false, lastMessageId: 504 };
const history: ChatHistory = { user: { ...profile, lastActivity: 1, threadCount: 1 }, thread, chain: [], messages, draft: null, olderCursor: null, newerCursor: null,
  autoLoadMaxBytes: 2 * 1024 * 1024, maxFileBytes: 50 * 1024 * 1024 };

// Ready bytes that cannot be previewed, and failures that must never offer a download.
const faults = new Map<number, "corrupt" | "html" | "forbidden" | "consent">();
const fileRequests: number[] = [];
const corrupt = Buffer.from("not a decodable png");
const script = "<script>window.parent.postMessage('executed', '*'); window.executed = true</script>";

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const asset = assets.get(url.pathname);
  if (asset) return new Response(asset);
  if (url.pathname === "/api/chat/session") return Response.json({ authenticated: true, user: profile, botUsername: "fixture_bot", admin: false });
  if (url.pathname === "/api/chat/avatar") return new Response(null, { status: 204 });
  if (url.pathname === "/api/chat/settings") {
    if (request.method === "PATCH") settings = { ...settings, ...await request.json() as Partial<ChatSettings> };
    return Response.json(settings);
  }
  if (url.pathname === "/api/chat/threads") return Response.json({ items: [thread], nextOffset: null });
  if (url.pathname.endsWith("/messages")) return Response.json(history);
  if (url.pathname.endsWith("/read")) return Response.json({ readMessageId: 504, unread: false });
  if (url.pathname.includes("/files/")) {
    const fileId = Number(url.pathname.split("/").at(-1));
    fileRequests.push(fileId);
    const fault = faults.get(fileId);
    if (fault === "corrupt") return new Response(corrupt, { headers: { "Content-Type": "image/png" } });
    if (fault === "html") return new Response(script, { headers: { "Content-Type": "text/html" } });
    if (fault === "forbidden") return Response.json({ error: "Forbidden" }, { status: 403 });
    if (fault === "consent") return Response.json({ code: "sandbox_consent_required" }, { status: 409 });
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  }
  if (url.pathname.startsWith("/api/")) return Response.json({ error: "Unexpected fixture request" }, { status: 404 });
  return new Response(html, { headers: { "Content-Type": "text/html" } });
} });

async function verify(page: Page, app: "en" | "ru") {
  await page.waitForFunction(expected => document.documentElement.lang === expected, app);
  for (const [id, language] of Object.entries(answerLanguages)) {
    const view = page.locator(`[data-message-id="${id}"] .chat-openui`);
    const other = language === "en" ? "ru" : "en";
    await view.scrollIntoViewIfNeeded();
    await view.getByText(labels[language].issue, { exact: true }).waitFor();
    assert.equal(await view.getByText(labels[other].issue, { exact: true }).count(), 0, `message ${id}: no ${other} tone labels in ${app} app`);
    assert.equal(await view.getByLabel(labels[language].region, { exact: true }).count(), 1, `message ${id}: generated region named in the answer language`);
    assert.equal(await page.locator(`[data-message-id="${id}"]`).getByRole("group", { name: app === "ru" ? "Действия с ответом" : "Response actions", exact: true }).count(), 1,
      `message ${id}: app actions follow the ${app} locale`);
  }
  for (const [id, name] of [[501, "Save: Bellevue Bistro"], [502, "Сохранить: Фото ресторана"]] as const) {
    const view = page.locator(`[data-message-id="${id}"] .chat-openui`);
    await view.scrollIntoViewIfNeeded();
    await view.getByRole("link", { name, exact: true }).waitFor();
  }

  const rows = page.locator('[data-message-id="501"] .chat-attachments');
  await rows.scrollIntoViewIfNeeded();
  assert.equal(await rows.locator(".file-block").count(), 2, "Only the unrepresented photo and the document keep rows");
  assert.equal(await rows.locator('a[download="photo-601.png"]').count(), 0, "The thumbnail image has no duplicate row");
  await rows.locator('a[download="photo-602.png"]').waitFor();
  assert.equal(await rows.locator('a[download="photo-602.png"]').getAttribute("aria-label"), app === "ru" ? "Сохранить изображение" : "Save image", "Remaining rows use app chrome");
  await rows.getByText("report.pdf", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-message-id="502"] .chat-attachments').count(), 0, "No empty container when every image is represented");
}

if (process.argv.includes("--preview")) {
  console.log(`Chat language preview: ${server.url}?thread=401`);
} else {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.url}?thread=401`);
    await verify(page, "ru");
    await page.screenshot({ path: "/tmp/ai-tg-openui-language-ru-app.png", fullPage: true });

    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.getByRole("combobox", { name: "Язык", exact: true }).click();
    const saved = page.waitForResponse(response => response.url().endsWith("/api/chat/settings") && response.request().method() === "PATCH");
    await page.getByRole("option", { name: "English", exact: true }).click();
    assert.equal((await saved).status(), 200);
    await page.getByRole("button", { name: /^Language mix/ }).click();
    await verify(page, "en");
    await page.screenshot({ path: "/tmp/ai-tg-openui-language-en-app.png", fullPage: true });
    await page.close();

    // An undecodable generated image keeps a named download of the exact cached bytes, without restoring its row, and retry recovers.
    const cases = [
      { id: 604, message: 502, save: "Сохранить: Фото ресторана", retry: "Повторить", width: 1440 },
      { id: 601, message: 501, save: "Save: Bellevue Bistro", retry: "Try again", width: 390 },
    ] as const;
    for (const item of cases) {
      faults.clear(); faults.set(item.id, "corrupt"); fileRequests.length = 0;
      const failing = await browser.newPage({ viewport: { width: item.width, height: 1000 } });
      failing.on("pageerror", error => errors.push(error.message));
      await failing.goto(`${server.url}?thread=401`);
      const view = failing.locator(`[data-message-id="${item.message}"] .chat-openui`);
      await view.scrollIntoViewIfNeeded();
      const save = view.getByRole("link", { name: item.save, exact: true });
      await save.waitFor();
      assert.equal(await save.getAttribute("download"), `photo-${item.id}.png`);
      assert.equal(await view.locator("img").count(), 0, `file ${item.id}: no broken image remains`);
      const href = await save.getAttribute("href") ?? "";
      assert(href.startsWith("blob:"));
      const saved = await failing.evaluate(async url => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], href);
      assert.deepEqual(Buffer.from(saved), corrupt, `file ${item.id}: the download is the fetched bytes`);
      assert.equal(fileRequests.filter(id => id === item.id).length, 1, `file ${item.id}: one fetch serves preview and download`);
      assert.equal(await failing.locator(`[data-message-id="${item.message}"] a[download="photo-${item.id}.png"]`).count(), 1, `file ${item.id}: no duplicate attachment row`);
      const retry = view.getByRole("button", { name: item.retry, exact: true });
      if (item.id === 601) {
        const box = await view.locator('[data-file-image="601"]').boundingBox();
        assert(box && box.width <= 80 && box.height <= 80, "Mobile thumbnail stays 80px");
        for (const control of [save, retry]) {
          const inner = await control.boundingBox();
          assert(inner && inner.x >= box.x && inner.y >= box.y && inner.x + inner.width <= box.x + box.width + 0.5 && inner.y + inner.height <= box.y + box.height + 0.5, "Thumbnail controls fit inside it");
        }
        await failing.screenshot({ path: "/tmp/ai-tg-openui-thumbnail-decode-failure.png", clip: { x: box.x - 8, y: box.y - 8, width: 300, height: box.height + 16 } });
      }
      faults.clear();
      await retry.click();
      await failing.waitForFunction(selector => [...document.querySelectorAll(selector)].some(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
        `[data-message-id="${item.message}"] .chat-openui img`);
      assert.equal(await save.locator("img").count(), 1, `file ${item.id}: the recovered image is its own save link`);
      assert.equal(await view.locator(`a[download="photo-${item.id}.png"]`).count(), 1);
      assert.equal(await view.getByRole("button", { name: item.retry, exact: true }).count(), 0);
      assert.equal(fileRequests.filter(id => id === item.id).length, 2);
      await failing.close();
    }

    // A non-image type is only ever offered as a download; it is never rendered or navigated to.
    faults.clear(); faults.set(601, "html");
    const unsupported = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    unsupported.on("pageerror", error => errors.push(error.message));
    await unsupported.goto(`${server.url}?thread=401`);
    const thumbnail = unsupported.locator('[data-message-id="501"] .chat-openui');
    await thumbnail.scrollIntoViewIfNeeded();
    const htmlSave = thumbnail.getByRole("link", { name: "Save: Bellevue Bistro", exact: true });
    await htmlSave.waitFor();
    assert.equal(await unsupported.locator("img[src^='blob:'], iframe, object, embed").evaluateAll(nodes => nodes.filter(node => node.closest('[data-message-id="501"] .chat-openui')).length), 0);
    const pageUrl = unsupported.url();
    const [download] = await Promise.all([unsupported.waitForEvent("download"), htmlSave.click()]);
    assert.equal(download.suggestedFilename(), "photo-601.png");
    assert.equal(unsupported.url(), pageUrl, "Saving never navigates to the bytes");
    assert.equal(await unsupported.evaluate(() => Reflect.get(window, "executed")), undefined, "Saved HTML never executes");
    assert.equal(unsupported.frames().length, 1);
    await unsupported.close();

    // Without ready bytes there is nothing to save: a refused file offers retry, and consent stays explicit.
    for (const [fault, action] of [["forbidden", "Try again"], ["consent", "Start sandbox and load"]] as const) {
      faults.clear(); faults.set(601, fault); fileRequests.length = 0;
      const refused = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      refused.on("pageerror", error => errors.push(error.message));
      await refused.goto(`${server.url}?thread=401`);
      const view = refused.locator('[data-message-id="501"] .chat-openui');
      await view.scrollIntoViewIfNeeded();
      await view.getByRole("button", { name: action, exact: true }).waitFor();
      assert.equal(await view.getByRole("link", { name: "Save: Bellevue Bistro", exact: true }).count(), 0, `${fault}: no download without fetched bytes`);
      assert.equal(await refused.locator('[data-message-id="501"] a[download="photo-601.png"]').count(), 0);
      assert.deepEqual(fileRequests.filter(id => id === 601), [601], `${fault}: only the automatic request was made`);
      await refused.close();
    }
    faults.clear();
    assert.deepEqual(errors, []);
    console.log("Chat OpenUI language smoke passed: EN and RU answers keep their own generated labels in RU and EN apps, legacy answers infer from prose, and only unrepresented files keep rows; undecodable Image and Item bytes stay downloadable and retry recovers, non-image bytes only download, refused and consent states offer no download");
  } finally {
    await browser.close();
    await server.stop(true);
  }
}
