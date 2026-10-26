import { fixtureUuid } from "./uuid-fixtures.js";
/** Local design preview for the chat client. In-memory fixture data only; never used in production.
 * `--dev` bundles the client source on the fly. Otherwise it serves a prebuilt bundle from
 * CHAT_PREVIEW_ASSETS (default dist/web), so run a web build into that directory first.
 * `--ru` starts with Russian settings; `--signed-out` starts on the sign-in page.
 * POST /__preview/settings with a JSON patch simulates a change made from Telegram. */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { file, serve, type HTMLBundle } from "bun";
import type { ToolActivity } from "../../src/ai/toolActivity.js";
import { MAX_FILE_BYTES } from "../../src/files/limits.js";
import type { ChatHistory, ChatSession, ChatSettings, ChatThread } from "../../src/web/chat-types.js";
import type { WebMessage } from "../../src/web/types.js";
import { zoneOffsetMinutes } from "../../src/bot/timezone.js";

const port = Number(process.env.CHAT_PREVIEW_PORT ?? 3006);
const development = process.argv.includes("--dev");
const PAGE_SIZE = 15;
const MEMORY_PAGE = 50;
const minute = 60_000;
const day = 24 * 60 * minute;
const now = Date.now();
let signedIn = !process.argv.includes("--signed-out");
const admin = !process.argv.includes("--member");
// Stands in for the Telegram profile photo; --no-avatar shows the initial instead.
const avatar = process.argv.includes("--no-avatar") ? undefined : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="b" x2="0" y2="1"><stop offset="0" stop-color="#f6c28b"/><stop offset="1" stop-color="#e07a5f"/></linearGradient></defs><rect width="96" height="96" fill="url(#b)"/><circle cx="48" cy="38" r="17" fill="#3d405b"/><path d="M14 96c4-22 18-32 34-32s30 10 34 32z" fill="#3d405b"/></svg>`;
let settings: ChatSettings = { language: process.argv.includes("--ru") ? "ru" : "en", timeZone: null, timezoneOffsetMinutes: null, streaming: true, memoryEnabled: true };
// Like the server, a named zone decides the reported offset.
const withOffset = (value: ChatSettings): ChatSettings => value.timeZone ? { ...value, timezoneOffsetMinutes: zoneOffsetMinutes(value.timeZone) } : value;
const failedOnce = new Set<string>();
const sent = new Map<string, { turnId: number; messageId: number; queued: boolean }>();
let nextId = 1000;

const thread = (index: number, title: string, origin: ChatThread["origin"], lastActivity: number, extra: Partial<ChatThread> = {}): ChatThread => ({
  id: fixtureUuid(index), userId: 1001, title, archived: false, parentThreadId: null, forkPointMessageId: null, lastActivity, activity: null, origin, topicId: origin === "telegram" ? index * 10 : null,
  unread: false, lastMessageId: null, ...extra,
});
/** Read cursors per thread; threads 2 and 3 start with an unseen reply. */
const readCursors = new Map<string, number>();
const drafts = new Map<string, NonNullable<ChatHistory["draft"]>>();
const message = (threadId: string, role: WebMessage["role"], text: string, createdAt: number, extra: Partial<WebMessage> = {}): WebMessage => ({
  id: nextId++, threadId, role, text, thinking: null, createdAt, attachments: [], ...extra,
});
const daysAgo = (days: number, hour = 10) => { const date = new Date(now - days * day); date.setHours(hour, 15, 0, 0); return date.getTime(); };

const threads: ChatThread[] = [
  thread(1, "Planning the autumn trip", "web", now - 4 * minute),
  thread(2, "Weekly grocery list", "telegram", now - 3 * 60 * minute),
  thread(3, "Compare two laptop options", "web", daysAgo(1, 18)),
  thread(4, "Notes from the weekend", "telegram", daysAgo(5), { archived: true }),
];
// Enough history to fill every recency group and page through search results.
const extraTitles = [
  "Trip budget spreadsheet", "Birthday gift ideas", "Fix the bike brakes", "Recipe for mushroom soup", "Trip packing checklist",
  "Learning Spanish verbs", "Apartment heating bill", "Trip photos to print", "Weekend hike in the hills", "Car insurance renewal",
  "Trip to the coast in spring", "Book club: chapter notes", "Garden planting calendar", "Trip itinerary draft", "Tax documents checklist",
  "Morning running plan", "Trip souvenirs list", "Kitchen renovation ideas", "Concert tickets", "Trip visa questions",
  "Podcast recommendations", "Trip train timetable", "Moving boxes inventory", "Trip insurance comparison", "Holiday card addresses",
  "Trip museum shortlist", "Old laptop backup", "Trip weather notes", "Language exchange partners", "Trip restaurant picks",
  "Winter boots sizing", "Trip currency exchange",
];
const extraAges = [0.2, 1.4, 2, 3, 4, 6, 6.5, 8, 9, 12, 15, 20, 26, 29, 31, 34, 38, 45, 52, 61, 70, 84, 95, 110, 130, 150, 175, 200, 240, 300, 340, 400];
extraTitles.forEach((title, index) => threads.push(thread(5 + index, title, index % 3 === 0 ? "web" : "telegram", now - extraAges[index]! * day - index * minute,
  { parentThreadId: index === 4 ? fixtureUuid(1) : null })));
threads.sort((a, b) => b.lastActivity - a.lastActivity);

const toolActivity: ToolActivity = {
  version: 1, omittedCalls: 0,
  reasoning: [
    "**Checking the season**\n\nOctober in the Alps means cold mornings and frequent showers, so layers matter more than bulk.",
    "**Counting days**\n\nA week is seven days; I'll double-check the arithmetic for the clothing rotation.",
    "**Writing the list**\n\nGroup by weather, walking and travel essentials.",
  ],
  calls: [
    { id: "call-1", name: "web_search", status: "succeeded", durationMs: 1840, reasoningBefore: 1,
      args: { format: "json", text: JSON.stringify({ query: "October alpine weather averages" }), truncated: false },
      result: { format: "json", text: JSON.stringify({ results: [{ title: "Alpine climate in autumn", snippet: "Cold mornings, frequent showers." }] }), truncated: false } },
    { id: "call-2", name: "bash", status: "succeeded", durationMs: 420, reasoningBefore: 2,
      args: { format: "json", text: JSON.stringify({ script: "python3 -c 'print(7 * 2)'  " }), truncated: false },
      result: { format: "json", text: JSON.stringify({ stdout: "14\n", stderr: "", exitCode: 0 }), truncated: false } },
  ],
};
const cancelled: ToolActivity = {
  version: 1, omittedCalls: 0, reasoning: [],
  calls: [{ id: "call-3", name: "web_search", status: "cancelled", durationMs: 2600, args: { format: "json", text: JSON.stringify({ query: "lakeside hut opening hours" }), truncated: false }, result: null }],
};
const picture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAHgAAABICAIAAACyfKYoAAADKUlEQVR42u3XR3baUBTG8buwjE2T4LmA0E6yA+OWzNJ7770X94J7L3u4GWSQBYQTHRTMZ8fmSboY557zG+vd7z8CujDKSgBdHGUlgC6NsRJAl8dYCaAr46wE0NVxVgLo2gQrAXR9gpUAujHJSgDdnGQlgG5NsRJAt6dYCaA706wE0N1pVgLo3gwrAXR/hpUAejDLSgA9nGUlgB7NsRJAj+dYCaAnVVYC6GmVlQB6Ns9KAD2fZyWAXiywEkAvF1gJoFeLrATQ60VWAujNEisB9HaJlQB6t8xKAL1fZiWAPqywEkAfV1gJoE+rrATQ51VWAujLGisB9HWNlQD6ts5KAH1fZyWARjdY2I+fvxrJH9CWvTS2wTKa+iKxS9qyl8Y3OVFH9kVJn9SWvTSxyUmw6IsSuq0te2lyi2MUS18U75Ft2UtTWxxdQn1RLNe2ZS9Nb3MUFk86/Sbk9huLL0S8WXiv329qaGabLVi8l2vo2xg6ZPFNu+Nl9gZ9QzS7w8dn07diQg5wQb5iU7ylFYnuLVdMjQ9oboePZPFetqFvq6FDFu8eZ04Se4O+oQNCV3f5MHZ9Q9FDBwpWxf+xK8a9XsV4+xMfGnp+l5tYvJcZMFmQAw5wQR4UGljchgOj7/UGTKMy8AEt7HHA7vdWLXFAJrR17ppwaZS9pf2JWwi9uMdR+rYltKmzuNxub61vyDJ0S++lB00gA7IgBxzggjwoAAMS+n9UHDQl4IEy8AG11PfEhu6ui6tvSCJ0atAEOih0lOJ9DX0lQqeGTJM0yIAsyAEHuCAPCsCAbtBTd3TfIRMqghLwQBn44G/oriET6OjQZ85Wo0sqdJi4Q0PHEvcwsYXuGjZNUiANMiALcsABLsiDAjB/JNr3gOLDJuCBMvBBp4YWrtzYWkOf8NAjpkkKpEEGZEEOOMAFeVAAZqRNoUdMjQfKwAedGlq+dVD5fwxtRIqHfSOHPmeapEAaZEAW5IADXJAHBWBAd108v6PPmVAJeKAMfHDaQod6QC/oA0WgoTsu9HnTJAXSIAOyIAcc4II8KAADukEP6AV9oAhKwANl4AMNraFPV+jfNCfbk4IrgtIAAAAASUVORK5CYII=", "base64");

const messages = new Map<string, WebMessage[]>([
  [fixtureUuid(1), [
    message(fixtureUuid(1), "user", "Can you put together a short packing list for a week in the mountains?", now - 30 * minute),
    message(fixtureUuid(1), "assistant", "Here's a starting point for a week away.\n\n- Waterproof jacket and warm layers\n- Comfortable walking shoes\n- Water bottle and a small daypack\n- Travel documents and a first-aid kit\n\n```json\n{ \"destination\": \"mountains\", \"duration\": \"7 days\" }\n```", now - 29 * minute, {
      thinking: "Tool calls: 2 · Reasoning blocks: 1\n\nChecked typical October weather for alpine regions.", toolActivity, durationMs: 32_400,
      openui: 'root = Stack([Card("Pack by weather", [Table("Essentials", ["Item", "Why"], [["Rain shell", "Frequent showers"], ["Fleece", "Cold mornings"]]), Button("Add a checklist", "Turn this into a checklist I can tick off")])])',
    }),
    message(fixtureUuid(1), "user", "Great. Also attach the route preview please.", now - 6 * minute, { attachments: [{ id: fixtureUuid(501), name: "route-notes.txt", size: 812, mimeType: "text/plain", caption: null, kind: "file" }] }),
    message(fixtureUuid(1), "assistant", "", now - 5 * minute, { toolActivity: cancelled, durationMs: 26_000 }),
    message(fixtureUuid(1), "assistant", "Done — I've added the route notes and a preview of the map. The second day is the longest, about **14 km** with 600 m of climbing.", now - 4 * minute, {
      durationMs: 74_000, thinking: "**Reading the route notes**\n\nThe notes list two days; the second is longer and climbs 600 m.",
      attachments: [{ id: fixtureUuid(502), name: "route-map.png", size: picture.length, mimeType: "image/png", caption: "Route overview", kind: "image" }],
      openui: `root = Stack([picture])\npicture = Image("file:${fixtureUuid(502)}", "Map of the two-day lakeside route", "Day 2 is the longest stretch")`,
    }),
  ]],
  [fixtureUuid(2), [message(fixtureUuid(2), "user", "Milk, eggs, spinach", now - 3 * 60 * minute), message(fixtureUuid(2), "assistant", "Added. Want me to remind you on Saturday morning?", now - 3 * 60 * minute + 20_000, { durationMs: 4_200 })]],
  [fixtureUuid(3), [message(fixtureUuid(3), "user", "Compare a 14-inch and a 16-inch laptop for travel.", daysAgo(1, 18)), message(fixtureUuid(3), "assistant", "For frequent travel the 14-inch wins on weight and battery life; the 16-inch is better for long editing sessions.", daysAgo(1, 18) + 40_000)]],
  [fixtureUuid(4), []],
]);
for (const item of threads) if (!messages.has(item.id)) messages.set(item.id, [
  message(item.id, "user", `Notes about ${item.title.toLowerCase()}.`, item.lastActivity - 60_000),
  message(item.id, "assistant", item.title === "Recipe for mushroom soup" ? "Saved. I'll mention the spinach pie recipe next time." : "Saved for later.", item.lastActivity),
]);

for (const [id, list] of messages) readCursors.set(id, id === fixtureUuid(2) || id === fixtureUuid(3) ? list.at(-2)?.id ?? 0 : list.at(-1)?.id ?? 0);
const withRead = (item: ChatThread): ChatThread => {
  const lastMessageId = messages.get(item.id)?.at(-1)?.id ?? null;
  return { ...item, lastMessageId, unread: lastMessageId !== null && lastMessageId > (readCursors.get(item.id) ?? 0) };
};

const memories = Array.from({ length: 53 }, (_, id) => ({ id, date: `2026-${String(8 + Math.floor(id / 30)).padStart(2, "0")}-${String(1 + id % 28).padStart(2, "0")}`,
  text: id === 0 ? "Prefers quiet mountain trails and vegetarian meals." : id === 1 ? "Usually travels with a carry-on only." : `Travel note ${id}: bring a waterproof layer for autumn walks.`, deleted: false }));

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const requireWrite = (request: Request) => request.headers.get("X-Chat-Request") === "1";
const find = (id: string) => threads.find(item => item.id === id);
const touch = (item: ChatThread) => { item.lastActivity = Date.now(); threads.sort((a, b) => b.lastActivity - a.lastActivity); };
const user = () => ({ id: 1001, name: "Alice Morgan", username: "alice_m", lastActivity: now, threadCount: threads.length });

/** Tool progress as the engine publishes it: calls appear running, gain partial results, then finish. */
function liveTools(stage: number): ToolActivity {
  const search = { id: "tool-1", name: "web_search", args: { format: "json" as const, text: JSON.stringify({ query: "mountain hut opening hours" }), truncated: false } };
  const bash = { id: "tool-2", name: "bash", args: { format: "json" as const, text: JSON.stringify({ script: "for day in 1 2 3; do echo \"day $day\"; sleep 1; done" }), truncated: false } };
  const reasoning = ["**Checking opening hours**\n\nMountain huts close for the season; I'll search for this year's dates.", "**Counting the days**\n\nRunning a quick script to lay out the itinerary."];
  const calls: ToolActivity["calls"] = [stage === 0
    ? { ...search, status: "running", result: null, durationMs: null, reasoningBefore: 1 }
    : { ...search, status: "succeeded", durationMs: 1_180, reasoningBefore: 1, result: { format: "json", text: JSON.stringify({ results: [{ title: "Hut season", snippet: "Open June to October." }] }), truncated: false } }];
  if (stage >= 1) calls.push(stage === 1
    ? { ...bash, status: "running", durationMs: null, reasoningBefore: 2, result: { format: "json", text: JSON.stringify({ stdout: "day 1\n" }), truncated: false } }
    : { ...bash, status: "succeeded", durationMs: 3_020, reasoningBefore: 2, result: { format: "json", text: JSON.stringify({ stdout: "day 1\nday 2\nday 3\n", stderr: "", exit_code: 0 }), truncated: false } });
  return { version: 1, omittedCalls: 0, reasoning: reasoning.slice(0, stage === 0 ? 1 : 2), calls };
}

function reply(target: ChatThread, text: string) {
  const startedAt = Date.now();
  target.activity = { state: "generating", queuedTurns: 0, startedAt };
  const stages = [0, 1, 2];
  stages.forEach(stage => setTimeout(() => drafts.set(target.id, { text: stage === 2 ? (settings.language === "ru" ? "Пишу ответ…" : "Writing the answer…") : "", thinking: "", toolActivity: liveTools(stage) }), stage * 2_500));
  setTimeout(() => {
    drafts.delete(target.id);
    messages.get(target.id)!.push(message(target.id, "assistant", settings.language === "ru"
      ? `Вы написали: «${text.slice(0, 120)}». Этот тестовый стенд повторяет сообщения, чтобы проверить вёрстку.`
      : `You said: “${text.slice(0, 120)}”. This preview fixture echoes messages so the layout can be checked.`, Date.now(), {
      openui: target.origin === "web" && /table|compare/i.test(text) ? 'root = Stack([Card("Summary", [Text("A generated card rendered with Kumo."), Button("Tell me more", "Tell me more")])])' : undefined,
      toolActivity: liveTools(2), durationMs: Date.now() - startedAt,
    }));
    target.activity = null;
    touch(target);
  }, 8_000);
}

const assets = path.resolve(process.env.CHAT_PREVIEW_ASSETS ?? "dist/web");
const page = () => new Response(file(path.join(assets, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8" } });
const bundle: HTMLBundle | null = development ? (await import("../../src/web/client/index.html")).default : null;
const pages = bundle ? { "/": bundle, "/admin": bundle } : { "/": page, "/admin": page };
// Rebuilt bundles get new hashed names, so assets are resolved per request.
const asset = async (request: Request) => {
  const name = path.basename(new URL(request.url).pathname);
  return !development && (await readdir(assets)).includes(name) ? new Response(file(path.join(assets, name))) : new Response("Not found", { status: 404 });
};

const server = serve({
  port,
  hostname: "127.0.0.1",
  development,
  fetch: asset,
  routes: {
    ...pages,
    "/__preview/settings": { POST: async request => { settings = withOffset({ ...settings, ...await request.json() }); return json(settings); } },
    "/api/chat/session": {
      GET: () => json(signedIn ? { authenticated: true, user: { id: 1001, name: "Alice Morgan", username: "alice_m" }, botUsername: "karilaa_bot", admin } satisfies ChatSession : { authenticated: false, loginAvailable: true } satisfies ChatSession),
      DELETE: request => { if (!requireWrite(request)) return json({ error: "Missing chat header." }, 403); signedIn = false; return json({ authenticated: false, loginAvailable: true }); },
    },
    "/api/auth/telegram/start": () => { signedIn = true; return Response.redirect("/", 302); },
    "/api/chat/avatar": () => !signedIn ? json({ error: "Sign in" }, 401) : avatar ? new Response(avatar, { headers: { "Content-Type": "image/svg+xml" } }) : new Response(null, { status: 204 }),
    "/api/chat/schedules": { GET: () => Response.json({ items: [] }) },
    "/api/chat/threads": {
      GET: async request => {
        if (!signedIn) return json({ error: "Sign in" }, 401);
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
        if (query.length > 200) return json({ error: "Invalid request." }, 400);
        if (query) await new Promise(resolve => setTimeout(resolve, 350));
        const matches = query ? threads.filter(item => item.title.toLocaleLowerCase().includes(query) || messages.get(item.id)!.some(entry => entry.text.toLocaleLowerCase().includes(query))) : threads;
        const items = matches.slice(offset, offset + PAGE_SIZE).map(withRead);
        return json({ items, nextOffset: offset + PAGE_SIZE < matches.length ? offset + PAGE_SIZE : null });
      },
      POST: request => {
        if (!requireWrite(request)) return json({ error: "Missing chat header." }, 403);
        const created = thread(threads.length + 1, settings.language === "ru" ? "Новый чат" : "New chat", "web", Date.now());
        threads.unshift(created); messages.set(created.id, []);
        return json(created, 201);
      },
    },
    "/api/chat/threads/:id/messages": {
      GET: request => {
        const target = find(request.params.id);
        if (!target) return json({ error: "Not found." }, 404);
        const url = new URL(request.url);
        const all = messages.get(target.id)!;
        const after = Number(url.searchParams.get("after") ?? 0);
        const list = after ? all.filter(item => item.id >= after) : all;
        return json({ user: user(), thread: withRead(target), chain: [], messages: list, draft: drafts.get(target.id) ?? null,
          olderCursor: null, newerCursor: null, autoLoadMaxBytes: 2 * 1024 * 1024, maxFileBytes: MAX_FILE_BYTES } satisfies ChatHistory);
      },
      POST: async request => {
        if (!requireWrite(request)) return json({ error: "Missing chat header." }, 403);
        const target = find(request.params.id);
        if (!target) return json({ error: "Not found." }, 404);
        const form = request.headers.get("content-type")?.includes("multipart") ? await request.formData() : null;
        const body: { text?: string; requestId?: string } = form ? { text: String(form.get("text") ?? ""), requestId: String(form.get("requestId") ?? "") } : await request.json();
        const requestId = body.requestId ?? "";
        const text = body.text ?? "";
        if (text.includes("/fail") && !failedOnce.has(requestId)) { failedOnce.add(requestId); return json({ error: "Other uploads are processing. Try again shortly." }, 503); }
        const previous = sent.get(requestId);
        if (previous) return json(previous, 202);
        const files = form ? form.getAll("files").filter(item => item instanceof File) : [];
        const saved = message(target.id, "user", text, Date.now(), { attachments: files.map((upload, index) => ({ id: fixtureUuid(nextId + 500 + index), name: upload.name, size: upload.size, mimeType: upload.type || null, caption: null, kind: "file" as const })) });
        messages.get(target.id)!.push(saved);
        if (/^(New chat|Новый чат)$/.test(target.title) && text) target.title = text.slice(0, 48);
        touch(target);
        reply(target, text);
        const result = { turnId: saved.id, messageId: saved.id, queued: false };
        sent.set(requestId, result);
        return json(result, 202);
      },
    },
    "/api/chat/threads/:id/read": { POST: async request => {
      if (!requireWrite(request)) return json({ error: "Missing chat header." }, 403);
      const target = find(request.params.id);
      const { messageId } = await request.json() as { messageId?: unknown };
      if (!target || typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0) return json({ error: "Invalid request." }, 400);
      if (!messages.get(target.id)!.some(item => item.id === messageId)) return json({ error: "Not found." }, 404);
      readCursors.set(target.id, Math.max(readCursors.get(target.id) ?? 0, messageId));
      const state = withRead(target);
      console.log(`read thread=${target.id} message=${messageId} unread=${state.unread}`);
      return json({ readMessageId: readCursors.get(target.id) ?? null, unread: state.unread });
    } },
    "/api/chat/threads/:id/stop": { POST: request => { const target = find(request.params.id); if (target) target.activity = { state: "interrupted", queuedTurns: 0 }; return new Response(null, { status: 204 }); } },
    "/api/chat/threads/:id/compact": { POST: request => {
      if (!requireWrite(request)) return json({ error: "Missing chat header." }, 403);
      const target = find(request.params.id);
      if (!target) return json({ error: "Not found." }, 404);
      const history = messages.get(target.id)!;
      const previous = history.findLast(item => item.action?.status === "succeeded")?.action;
      const startedAt = Date.now();
      const row = message(target.id, "system", "Compacting context", startedAt, { action: previous?.status === "succeeded"
        ? { kind: "compaction", status: "failed", requestedAt: startedAt, startedAt, updatedAt: startedAt, finishedAt: startedAt,
          reason: "recent", retryAt: startedAt + 60_000 }
        : { kind: "compaction", status: "running", requestedAt: startedAt, startedAt, updatedAt: startedAt } });
      history.push(row);
      if (row.action?.status === "running") setTimeout(() => {
        const finishedAt = Date.now();
        row.action = { kind: "compaction", status: "succeeded", requestedAt: startedAt, startedAt, finishedAt, updatedAt: finishedAt, messagesCompacted: 12 };
      }, 5_000);
      return json({ messageId: row.id }, 202);
    } },
    "/api/chat/threads/:id/fork": { POST: request => {
      const source = find(request.params.id)!;
      const fork = thread(threads.length + 1, `${source.title} (fork)`, "web", Date.now(), { parentThreadId: source.id });
      threads.unshift(fork); messages.set(fork.id, [...messages.get(source.id)!]);
      return json(fork, 201);
    } },
    "/api/chat/threads/:id/files/:fileId": request => request.params.fileId === fixtureUuid(502)
      ? new Response(picture, { headers: { "Content-Type": "image/png" } })
      : new Response("Day 1: Valley trailhead → hut (9 km)\nDay 2: Hut → ridge → lake (14 km, +600 m)\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
    "/api/chat/settings": {
      GET: () => json(settings),
      PATCH: async request => { await new Promise(resolve => setTimeout(resolve, 400)); settings = withOffset({ ...settings, ...await request.json() }); return json(settings); },
    },
    "/api/chat/memories": request => {
      const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
      const visible = memories.filter(item => !item.deleted);
      const items = visible.slice(offset, offset + MEMORY_PAGE).map(({ id, date, text }) => ({ id, date, text }));
      return json({ user: user(), enabled: settings.memoryEnabled, total: visible.length, nextOffset: offset + MEMORY_PAGE < visible.length ? offset + MEMORY_PAGE : null, items });
    },
    "/api/chat/memories/:id": { DELETE: request => {
      if (!requireWrite(request)) return json({ error: "Missing chat header." }, 403);
      const note = memories.find(item => item.id === Number(request.params.id));
      if (!note) return json({ error: "Not found." }, 404);
      note.deleted = true;
      return json({ deleted: true });
    } },
  },
});
console.log(`Chat preview: ${server.url}${development ? " (development bundle)" : ""}`);
