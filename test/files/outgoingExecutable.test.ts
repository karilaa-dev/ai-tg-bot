import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { InputFile } from "grammy";
import type { FileRow } from "../../src/db/types.js";
import { createCreateFileTool } from "../../src/ai/tools/createFile.js";
import { sendFinal } from "../../src/ai/responseDelivery.js";
import { E2BFileSourceAdapter } from "../../src/e2b/fileSource.js";
import { sha256Hex } from "../../src/files/hash.js";
import { OutgoingFiles } from "../../src/files/outgoingFiles.js";
import { MAX_FILE_BYTES } from "../../src/files/limits.js";
import type { CommandRuntime } from "../../src/sandbox/types.js";
import { BotChatService } from "../../src/web/chat-service.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";

it.each([
  { source: "workspace", size: 8 },
  { source: "workspace", size: MAX_FILE_BYTES },
  { source: "spool", size: MAX_FILE_BYTES },
])("delivers a $size-byte executable from $source and retains exact bytes after cleanup", async ({ source, size }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "outgoing-executable-"));
  const original = Buffer.alloc(size, 0xa5);
  Buffer.from([0x4d, 0x5a, 0, 0xff, 0x80, 0x45, 0x58, 0x45]).copy(original);
  const workspacePath = path.join(directory, "program.exe");
  const snapshotPath = path.join(directory, sha256Hex(original));
  await writeFile(workspacePath, original);
  let sourceReads = 0;
  let generatedId: FileRow["id"] | undefined;
  let env: GrammyEmulator | undefined;
  const runtime: CommandRuntime = {
    async readWorkspaceFile(request) {
      expect(request.virtualPath).toBe("/program.exe");
      expect(request.preserveSource).toBe(true);
      expect(request.maxBytes).toBe(MAX_FILE_BYTES);
      const bytes = await readFile(workspacePath);
      await writeFile(snapshotPath, bytes, { mode: 0o400 });
      return { sandboxId: "local-fixture", canonicalPath: workspacePath, sourceCanonicalPath: snapshotPath,
        bytes, size: bytes.length, contentSha256: sha256Hex(bytes) };
    },
    async readSourceFile(request) {
      expect(request.canonicalPath).toBe(snapshotPath);
      expect(request.sandboxId).toBe("local-fixture");
      sourceReads++;
      return readFile(request.canonicalPath);
    },
    async execute() { throw new Error("Attachments must never be executed."); },
    async materializeFiles() { throw new Error("Not needed for a created file."); },
    async publishWebsite() { throw new Error("Not needed for file delivery."); },
    async dispose() {},
  };
  try {
    env = await createGrammyEmulator({ config: { FILE_STORAGE_PATH: path.join(directory, "files") }, privateTopics: true, turnRunner: async input => {
      if (!env) throw new Error("Emulator is not ready");
      const files = new OutgoingFiles({ ...input, commandRuntime: runtime, fileResolver: env.services.fileResolver });
      try {
        const result = source === "workspace"
          ? await createCreateFileTool({ ...input, commandRuntime: runtime, outgoingFiles: files })
            .execute({ path: "/program.exe", mime: "application/x-msdownload", delivery: "auto" })
          : await files.bytes(async () => ({ name: "program.exe", mime: "application/x-msdownload", bytes: original }));
        expect(result).toMatchObject({ name: "program.exe", type: "other", size: original.length });
        const attachment = files.items[0]!;
        generatedId = attachment.fileId;
        expect(attachment.delivery).toBe("document");
        files.buffers.release(attachment);
        // Force final delivery to reload the registered immutable source.
        await writeFile(workspacePath, Buffer.from("later workspace revision"));
        await sendFinal({ ...input, outgoingBuffers: files.buffers }, "", "Your executable is attached.", 0, files.items);
      } finally { await files.dispose(); }
    } });
    env.services.fileResolver.registry.register(new E2BFileSourceAdapter(env.config, runtime));
    await env.bot.sendCommand(env.user, env.chat, "/start");
    const uploaded: Buffer[] = [];
    env.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === "sendDocument" && "document" in payload) {
        if (!(payload.document instanceof InputFile)) throw new Error("Expected document bytes.");
        expect(payload.document.filename).toBe("program.exe");
        const raw = await payload.document.toRaw();
        if (!(raw instanceof Uint8Array)) throw new Error("Expected a buffered document.");
        uploaded.push(Buffer.from(raw));
      }
      return previous(method, payload, signal);
    });
    const chat = new BotChatService({ services: env.services, api: env.bot.api,
      repository: new ConversationRepository(env.db.db, env.repos, 999) });
    const thread = await chat.createThread(env.user.id, "Executable");
    await chat.send(env.user.id, thread.id, { text: "Send the executable", requestId: randomUUID() });
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.equals(original)).toBe(true);
    expect(sourceReads).toBe(0);
    const assistant = (await chat.history(env.user.id, thread.id)).messages.at(-1)!;
    expect(assistant.attachments).toMatchObject([{ id: generatedId, name: "program.exe", kind: "file" }]);
    if (generatedId === undefined) throw new Error("No file was created.");
    const file = (await env.repos.files.get(generatedId))!;
    expect(file).toMatchObject({ message_id: assistant.id, type: "other", extraction_status: "source_only", content_md: null });
    env.services.fileResolver.registry.register({ transport: "telegram", connectionKey: "default", fetch: async () => { throw new Error("Telegram offline"); } });
    const e2bFetch = vi.fn(async () => { throw new Error("Sandbox expired after send"); });
    env.services.fileResolver.registry.register({ transport: "e2b", connectionKey: env.config.E2B_DEPLOYMENT_ID, fetch: e2bFetch });
    const resolved = await env.services.fileResolver.resolveFile(file);
    expect(resolved.source.transport).toBe("local");
    expect(resolved.bytes.equals(original)).toBe(true);
    expect(e2bFetch).not.toHaveBeenCalled();
    expect((await readFile(workspacePath)).equals(original)).toBe(false);
    if (source === "workspace") expect((await readFile(snapshotPath)).equals(original)).toBe(true);
  } finally {
    await env?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
