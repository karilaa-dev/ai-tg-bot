import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";

describe("arbitrary Telegram documents", () => {
  let env: GrammyEmulator;
  let downloads: number;
  beforeEach(async () => {
    downloads = 0;
    env = await createGrammyEmulator({ downloadFile: async ({ fileId }) => {
      downloads++;
      const bytes = env.bot.server.fileState.getFileContent(fileId);
      if (!bytes) throw new Error("Missing local Telegram fixture.");
      return { bytes: Buffer.from(bytes) };
    } });
    await env.bot.sendCommand(env.user, env.chat, "/start");
  });
  afterEach(async () => { await env.dispose(); });

  it.each([
    ["bundle.zip", "application/zip"], ["clip.mp4", "video/mp4"],
    ["program.exe", "application/x-msdownload"], ["legacy.doc", "application/msword"],
    ["unknown.custom", "application/octet-stream"],
  ])("registers and reuses %s without decoding it, then resolves exact source bytes", async (name, mime) => {
    const bytes = Buffer.from([0x4d, 0x5a, 0, 0xff, 0x80]);
    const document = env.bot.server.fileState.storeDocument(name, mime, { content: bytes });
    for (let index = 0; index < 2; index++) {
      await env.bot.processUpdatesConcurrently([
        env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
      ]);
    }
    expect(downloads).toBe(0);
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file).toMatchObject({ type: "other", extraction_status: "source_only", is_inline: 0, content_md: null, name });
    expect(await env.repos.files.chunks(file.id)).toEqual([]);
    const messages = (await env.repos.messages.listThread(thread.id)).filter(message => message.role === "user" && message.kind === "file");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.text_plain).toContain("materialize_chat_files");
      expect(await env.repos.files.listForMessage(message.id)).toMatchObject([{ id: file.id }]);
    }
    const resolved = await env.services.fileResolver.resolveFile(file);
    expect(resolved.bytes).toEqual(bytes);
    expect(downloads).toBe(1);
  });

  it("treats binary labelled as text as an opaque reusable source", async () => {
    const bytes = Buffer.from([0x4d, 0x5a, 0, 0xff, 0x80]);
    const document = env.bot.server.fileState.storeDocument("binary.txt", "text/plain", { content: bytes });
    for (let index = 0; index < 2; index++) {
      await env.bot.processUpdatesConcurrently([
        env.bot.server.updateFactory.createDocumentMessage(env.user, env.chat, document),
      ]);
    }
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ type: "other", extraction_status: "source_only", is_inline: 0, content_md: null });
    const messages = (await env.repos.messages.listThread(thread.id)).filter(message => message.role === "user" && message.kind === "file");
    expect(messages).toHaveLength(2);
    expect(messages.every(message => message.text_plain.includes("materialize_chat_files"))).toBe(true);
  });
});
