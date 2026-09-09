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
import type { WebHistory } from "../../src/web/types.js";

const preview = process.argv.includes("--preview");
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
resolver.registry.register({ transport: "fixture", connectionKey: "default", fetch: async source => payloads.get(source.remoteKey)! });
const user = await repos.users.ensure({ tgId: 1001, firstName: "Alice Morgan", username: "alice_m" });
await repos.users.ensure({ tgId: 1002, firstName: "Дмитрий", username: "dmitry" });
await repos.users.ensure({ tgId: 1003, firstName: "Sam Rivera" });
const thread = await repos.threads.create({ userId: user.tg_id, title: "Planning the autumn trip", topicId: null });
const archived = await repos.threads.create({ userId: user.tg_id, title: "Notes from the weekend", topicId: 2 });
await repos.threads.archive(archived.id);
for (let i = 0; i < 54; i++) await repos.messages.insert({ threadId: thread.id, role: i % 2 ? "assistant" : "user", textPlain: `Earlier message ${i + 1}`, content: {} });
await repos.messages.insert({ threadId: thread.id, role: "user", textPlain: "Can you put together a short packing list for a week in the mountains?", content: {} });
const response = await repos.messages.insert({ threadId: thread.id, role: "assistant", thinking: "Organize the list by weather, walking, and travel essentials.", textPlain: "Here's a starting point for a week away.\n\n- Waterproof jacket and warm layers\n- Comfortable walking shoes\n- Water bottle and a small daypack\n- Travel documents and a first-aid kit\n\nI've attached the list so you can add your own items.\n\n```json\n{\n  \"destination\": \"mountains\",\n  \"duration\": \"7 days\"\n}\n```", content: {} });
const file = await repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, messageId: response.id, type: "txt", name: "packing-list.txt", mimeType: "text/plain", size: 47, isInline: true });
payloads.set(String(file.id), Buffer.from("Waterproof jacket\nWalking shoes\nWater bottle\n"));
await repos.files.rememberSource(file.id, { transport: "fixture", connectionKey: "default", remoteKey: String(file.id), locator: {} });
const large = await repos.files.insertFile({ userId: user.tg_id, threadId: thread.id, messageId: response.id, type: "other", name: "route-map.zip", mimeType: "application/zip", size: 6 * 1024 * 1024, isInline: false });
payloads.set(String(large.id), Buffer.alloc(6 * 1024 * 1024));
await repos.files.rememberSource(large.id, { transport: "fixture", connectionKey: "default", remoteKey: String(large.id), locator: {} });
if (!preview) await writeFile(path.join(temp, "index.html"), "<!doctype html><title>Smoke test</title>");
const options = { config, repository: new ConversationRepository(db.db, repos), fileResolver: resolver, logger: createLogger(config), assetsDirectory: preview ? "dist/web" : temp };
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
    assert.equal((await fetch(new URL(`/api/threads/${thread.id}/files/${large.id}?mode=auto`, web.url))).status, 413);
    assert.equal((await fetch(new URL(`/api/threads/${thread.id}/files/${large.id}?mode=download`, web.url))).status, 200);
    assert.equal((await fetch(new URL("/.env", web.url))).status, 404);
    assert.equal((await fetch(new URL("/api/users", web.url), { method: "POST" })).status, 405);
    await assert.rejects(startWebServer({ ...options, config: { ...config, WEB_PORT: Number(web.url.port) } }));
    await web.stop();
    const rebound = Bun.serve({ hostname: "127.0.0.1", port: Number(web.url.port), fetch: () => new Response("rebound") });
    await rebound.stop(true);
    assert.equal(await startWebServer({ ...options, config: { ...config, WEB_ENABLED: false } }), undefined);
    console.log("Bun HTTP smoke passed: assets, history, downloads, bind failure, shutdown, disabled mode");
  } finally { await web.stop(); await db.destroy();
    if (admin) { await admin.db.execute(sql.raw(`drop schema ${schema} cascade`)); await admin.destroy(); }
    await rm(temp, { recursive: true, force: true }); }
}
