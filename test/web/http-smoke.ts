import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { loadTestConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { FileResolver } from "../../src/files/resolver.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { startWebServer } from "../../src/web/server.js";
import { audioFixture } from "../helpers/audio.js";
import type { WebHistory } from "../../src/web/types.js";
import { UsagePricing } from "../../src/web/usage-pricing.js";

const preview = process.argv.includes("--preview");
assert.ok(process.versions.bun, "The HTTP smoke test must run under Bun");
const temp = await mkdtemp(path.join(os.tmpdir(), "conversation-browser-"));
const config = loadTestConfig({ WEB_ENABLED: true, WEB_PORT: preview ? 3005 : 0, WEB_HOST: preview ? "0.0.0.0" : "127.0.0.1" });
const postgres = process.argv.includes("--postgres");
const schema = `web_smoke_${randomUUID().replaceAll("-", "")}`;
const admin = postgres ? createDatabase({ DB_URL: process.env.TEST_POSTGRES_URL! }) : undefined;
let databaseUrl = config.DB_URL;
if (admin) {
  await admin.db.execute(sql.raw(`create schema ${schema}`));
  const url = new URL(process.env.TEST_POSTGRES_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  databaseUrl = url.toString();
}
const db = createDatabase({ DB_URL: databaseUrl });
await db.initialize();
const repos = createRepos(db.db, db.search);
const resolver = new FileResolver(repos.files);
const payloads = new Map<string, Buffer>();
resolver.registry.register({ transport: "fixture", connectionKey: "default", fetch: async source => { if (preview && source.mimeType === "image/png") await new Promise(resolve => setTimeout(resolve, 2500)); return payloads.get(source.remoteKey)!; } });
const user = await repos.users.ensure({ tgId: 1001, firstName: "Alice Morgan", username: "alice_m" });
await repos.users.ensure({ tgId: 1002, firstName: "Дмитрий", username: "dmitry" });
await repos.users.ensure({ tgId: 1003, firstName: "Sam Rivera" });
const thread = await repos.threads.create({ userId: user.tg_id, title: "Planning the autumn trip", topicId: null });
const archived = await repos.threads.create({ userId: user.tg_id, title: "Notes from the weekend", topicId: 2 });
await repos.threads.archive(archived.id);
for (let i = 0; i < 54; i++) await repos.messages.insert({ threadId: thread.id, role: i % 2 ? "assistant" : "user", textPlain: `Earlier message ${i + 1}`, content: {} });
await repos.messages.insert({ threadId: thread.id, role: "user", textPlain: "Can you put together a short packing list for a week in the mountains?", content: {} });
const response = await repos.messages.insert({ threadId: thread.id, role: "assistant", thinking: "Organize the list by weather, walking, and travel essentials.", textPlain: "Here's a starting point for a week away.\n\n- Waterproof jacket and warm layers\n- Comfortable walking shoes\n- Water bottle and a small daypack\n- Travel documents and a first-aid kit\n\nI've attached the list so you can add your own items.\n\n```json\n{\n  \"destination\": \"mountains\",\n  \"duration\": \"7 days\"\n}\n```", content: {} });
// Synthetic usage makes the local preview and HTTP smoke exercise analytics too.
const savedMessages = await repos.messages.listThread(thread.id);
for (let i = 1; i < savedMessages.length; i += 2) {
  const userMessage = savedMessages[i - 1]!;
  const assistant = savedMessages[i]!;
  const timestamp = Date.now() - Math.floor((savedMessages.length - i) / 8) * 86_400_000;
  const call = { provider: "openai-codex", model: "gpt-6-astra", inputTokens: 1200 + i * 30, outputTokens: 400 + i * 20,
    cacheReadTokens: i * 1400, cacheWriteTokens: 0, reasoningTokens: i * 10 };
  await db.db.execute(sql`
    insert into turn_runs(user_id, thread_id, user_message_id, chat_id, locale, status, result_message_id,
      provider, model, usage_json, accepted_at, started_at, finished_at, updated_at)
    values (${user.tg_id}, ${thread.id}, ${userMessage.id}, ${user.tg_id}, 'en', 'succeeded', ${assistant.id},
      ${call.provider}, ${call.model}, ${JSON.stringify({ ...call, calls: [call] })}, ${timestamp}, ${timestamp}, ${timestamp}, ${timestamp})
  `);
}
const file = await repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, messageId: response.id, type: "txt", name: "packing-list.txt", mimeType: "text/plain", size: 47, isInline: true });
payloads.set(String(file.id), Buffer.from("Waterproof jacket\nWalking shoes\nWater bottle\n"));
await repos.files.rememberSource(file.id, { transport: "fixture", connectionKey: "default", remoteKey: String(file.id), locator: {} });
const large = await repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, messageId: response.id, type: "other", name: "route-map.zip", mimeType: "application/zip", size: 6 * 1024 * 1024, isInline: false });
payloads.set(String(large.id), Buffer.alloc(6 * 1024 * 1024));
await repos.files.rememberSource(large.id, { transport: "fixture", connectionKey: "default", remoteKey: String(large.id), locator: {} });
if (!preview) await writeFile(path.join(temp, "index.html"), "<!doctype html><title>Smoke test</title>");
await repos.users.ensure({ tgId: 999, firstName: "Archive Test Bot", username: "archive_test_bot" });
if (preview) {
  const picture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=", "base64");
  const imageMessage = await repos.messages.insert({ threadId: thread.id, role: "user", kind: "image", textPlain: "Here is the route preview.", content: { caption: "Here is the route preview." } });
  const pictureFile = await repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, messageId: imageMessage.id, type: "image", name: "route-preview.png", mimeType: "image/png", size: picture.length, summary: "A saved preview of the walking route.", isInline: true });
  payloads.set(String(pictureFile.id), picture);
  await repos.files.rememberSource(pictureFile.id, { transport: "fixture", connectionKey: "default", remoteKey: String(pictureFile.id), locator: {}, mimeType: "image/png" });
  await db.db.execute(sql`update messages set text_plain = ${`Here is the route preview.\n\n[[chat-file:${pictureFile.id}]] [image #${pictureFile.id}: A saved preview of the walking route.]`} where id = ${imageMessage.id}`);
  const audioMessage = await repos.messages.insert({ threadId: thread.id, role: "user", kind: "file", textPlain: "", content: {} });
  const voice = audioFixture("ogg");
  const voiceFile = await repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, messageId: audioMessage.id, type: "audio", name: "telegram-voice-message.ogg", mimeType: "audio/ogg", size: voice.length, isInline: false });
  payloads.set(String(voiceFile.id), voice);
  await repos.files.rememberSource(voiceFile.id, { transport: "fixture", connectionKey: "default", remoteKey: String(voiceFile.id), locator: {}, mimeType: "audio/ogg" });
  await db.db.execute(sql`update messages set text_plain = ${`Let's take the lakeside route tomorrow.\n\n[[chat-file:${voiceFile.id}]] [Audio message transcribed above]`} where id = ${audioMessage.id}`);

}
const pricing = new UsagePricing(async () => Response.json({ "gpt-6-astra": {
  input_cost_per_token: 10 / 1e6, output_cost_per_token: 50 / 1e6, cache_read_input_token_cost: 1 / 1e6,
} }));
const options = { development: preview && process.argv.includes("--web-dev"), config, repository: new ConversationRepository(db.db, repos, 999, pricing), fileResolver: resolver, logger: createLogger(config), assetsDirectory: preview ? "dist/web" : temp };
const web = (await startWebServer(options))!;
if (preview) {
  console.log(`Preview: ${web.url}?user=${user.tg_id}&thread=${thread.id}`);
  const stop = async () => { await web.stop(); await db.destroy(); await rm(temp, { recursive: true, force: true }); process.exit(0); };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} else {
  try {
    assert.equal((await fetch(web.url)).status, 200);
    const historyResponse = await fetch(new URL(`/api/threads/${thread.id}/messages`, web.url));
    assert.equal(historyResponse.headers.get("cache-control"), "no-store");
    const history = await historyResponse.json() as WebHistory;
    assert.equal(history.messages.length, 50);
    assert.equal(history.user.username, "alice_m");
    assert.equal(history.messages.find(message => message.id === response.id)?.usage?.modelCalls, 1);
    const usage = await (await fetch(new URL(`/api/usage?thread=${thread.id}&days=0`, web.url))).json();
    assert.equal(usage.totals.recordedTurns, 28);
    assert.ok(usage.totals.estimatedCostUsd > 0);
    assert.equal((await fetch(new URL(`/api/threads/${thread.id}/files/${large.id}?mode=auto`, web.url))).status, 413);
    assert.equal((await fetch(new URL(`/api/threads/${thread.id}/files/${large.id}?mode=download`, web.url))).status, 200);
    assert.equal((await fetch(new URL("/.env", web.url))).status, 404);
    assert.equal((await fetch(new URL("/api/users", web.url), { method: "POST" })).status, 405);
    await assert.rejects(startWebServer({ ...options, config: { ...config, WEB_PORT: Number(web.url.port) } }));
    await web.stop();
    const rebound = createServer();
    rebound.listen(Number(web.url.port), "127.0.0.1");
    await once(rebound, "listening");
    await new Promise<void>((resolve, reject) => rebound.close(error => error ? reject(error) : resolve()));
    assert.equal(await startWebServer({ ...options, config: { ...config, WEB_ENABLED: false } }), undefined);
    console.log("Bun HTTP smoke passed: assets, history, downloads, bind failure, shutdown, disabled mode");
  } finally { await web.stop(); await db.destroy();
    if (admin) { await admin.db.execute(sql.raw(`drop schema ${schema} cascade`)); await admin.destroy(); }
    await rm(temp, { recursive: true, force: true }); }
}
