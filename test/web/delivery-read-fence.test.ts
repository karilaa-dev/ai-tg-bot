import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { loadTestConfig } from "../../src/config.js";
import { sendFinal } from "../../src/ai/responseDelivery.js";
import type { TurnInput } from "../../src/ai/types.js";
import type { CreatedFileAttachment } from "../../src/files/types.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { deferred } from "../helpers/async.js";

for (const dialect of ["sqlite", "postgres"] as const) {
describe.skipIf(dialect === "postgres" && !process.env.TEST_POSTGRES_URL)(`${dialect} delivery writes and read acknowledgement recovery`, () => {
  let env: GrammyEmulator;
  let input: TurnInput;
  let repository: ConversationRepository;
  let admin: AppDatabase | undefined;
  let schema: string;
  beforeEach(async () => {
    schema = `delivery_reads_${randomUUID().replaceAll("-", "")}`;
    admin = dialect === "postgres" ? createDatabase(loadTestConfig({ DB_URL: process.env.TEST_POSTGRES_URL! })) : undefined;
    const url = admin ? new URL(process.env.TEST_POSTGRES_URL!) : undefined;
    if (admin && url) {
      await admin.db.execute(sql.raw(`create schema ${schema}`));
      url.searchParams.set("options", `-c search_path=${schema}`);
    }
    env = await createGrammyEmulator({ config: { DB_URL: url?.toString() ?? "sqlite::memory:" } });
    const user = await env.repos.users.ensure({ tgId: env.user.id });
    const thread = await env.repos.threads.activeForUserTopic(user.tg_id, null);
    const accepted = await env.repos.turnRuns.accept({ userId: user.tg_id, threadId: thread.id, chatId: user.tg_id,
      messageThreadId: null, locale: "en", kind: "text", textPlain: "Generate files", content: {}, sources: [{ updateId: 500, messageId: 500 }] });
    await env.repos.turnRuns.claimRunning(accepted.turnRun.id, "read-fence-worker", Date.now() + 60_000);
    input = { api: env.bot.api, config: env.config, db: env.db, repos: env.repos, logger: env.services.logger,
      user, thread, chatId: user.tg_id, text: "Generate files", turnRunId: accepted.turnRun.id, t: key => key,
      fileResolver: env.services.fileResolver };
    repository = new ConversationRepository(env.db.db, env.repos);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await env?.dispose();
    if (admin) {
      await admin.db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
      await admin.destroy();
    }
  });

  async function file(name: string): Promise<CreatedFileAttachment> {
    const saved = await env.repos.files.insertFile({ userId: input.user.tg_id, threadId: input.thread.id,
      type: "other", name, size: 4, isInline: false, mimeType: "application/octet-stream" });
    return { fileId: saved.id, name, type: "other", mimeType: "application/octet-stream", size: 4,
      inline: false, card: `Saved ${name}`, data: Buffer.from("data") };
  }

  it.each([0, 1])("fences associations after recovery with %s files already visible", async countBeforeRecovery => {
    const attachments = [await file("first.bin"), await file("second.bin")];
    const reached = deferred<void>();
    const release = deferred<void>();
    const persistFile = env.services.fileResolver.persistFile.bind(env.services.fileResolver);
    let paused = false;
    vi.spyOn(env.services.fileResolver, "persistFile").mockImplementation(async (file, bytes, signal) => {
      if (!paused && file.id === attachments[countBeforeRecovery]!.fileId) {
        paused = true;
        reached.resolve();
        await release.promise;
      }
      return persistFile(file, bytes, signal);
    });
    const delivery = sendFinal(input, "", "", 0, attachments);
    try {
      await reached.promise;
      const pending = (await env.repos.messages.listThread(input.thread.id)).at(-1)!;
      await env.db.db.execute(sql`update turn_runs set lease_expires_at = 0 where id = ${input.turnRunId}`);
      const expired = await repository.history(input.thread.id);
      expect(expired.messages.at(-1)?.attachments).toHaveLength(countBeforeRecovery);
      expect(expired.thread.lastMessageId).toBeLessThan(pending.id);
      const deferredRead = await env.repos.threadReads.markRead(input.user.tg_id, input.thread.id, pending.id);
      expect(deferredRead?.readMessageId).toBeLessThan(pending.id);
      expect(await env.repos.turnRuns.interruptStaleRunning()).toBe(1);
      await env.repos.threadReads.markCurrentRead(input.user.tg_id, input.thread.id);
      expect((await repository.history(input.thread.id)).thread.unread).toBe(false);
    } finally { release.resolve(); }
    await delivery;
    const final = await repository.history(input.thread.id);
    expect(final.messages.at(-1)?.attachments.map(file => file.name)).toEqual(attachments.slice(0, countBeforeRecovery).map(file => file.name));
    expect(final.messages.at(-1)?.text).toBe("");
    expect(final.thread.unread).toBe(false);
    // Recovery sources can still finish persisting without publishing new files.
    expect((await env.repos.files.listSources(attachments[1]!.fileId)).length).toBeGreaterThan(0);
  });

  it("skips final content mutation when terminal recovery wins after upload", async () => {
    const attachment = await file("report.bin");
    env.bot.api.config.use(async (previous, method, payload, signal) => {
      const result = await previous(method, payload, signal);
      if (method === "sendDocument") {
        await env.repos.turnRuns.markFailed(input.turnRunId!, "recovered_during_upload");
        await env.repos.threadReads.markCurrentRead(input.user.tg_id, input.thread.id);
      }
      return result;
    });
    await sendFinal(input, "", "", 0, [attachment]);
    const history = await repository.history(input.thread.id);
    expect(history.messages.at(-1)?.attachments).toHaveLength(1);
    expect(history.messages.at(-1)?.text).toBe("");
    expect(history.thread.unread).toBe(false);
    expect((await env.repos.messages.latest(input.thread.id))?.content_json).toContain("attachmentDeliveryTurnId");
  });
});
}
