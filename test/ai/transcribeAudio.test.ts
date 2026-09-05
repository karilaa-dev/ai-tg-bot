import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscribeAudioTool } from "../../src/ai/tools/transcribeAudio.js";
import { createLoadMessageTool } from "../../src/ai/tools/loadMessage.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import type { ToolBuildInput } from "../../src/ai/tools/types.js";
import { telegramFileSource } from "../../src/files/telegramSource.js";
import { workspaceRuntime } from "../helpers/workspaceRuntime.js";

describe("transcribe_audio", () => {
  let db: AppDatabase;
  let input: ToolBuildInput;
  let fileId: number;
  let messageId: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const config = loadTestConfig();
    db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 811, lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({ threadId: thread.id, role: "user", kind: "file", content: {}, textPlain: "Transcribe this recording" });
    messageId = message.id;
    const file = await repos.files.insertFile({
      userId: user.tg_id, threadId: thread.id, messageId, type: "audio", mimeType: "audio/ogg",
      extractionStatus: "source_only", name: "recording.ogg", size: 9, isInline: false,
    });
    fileId = file.id;
    await repos.files.rememberTelegramObservation(file.id, telegramFileSource({ fileId: "remote-file", fileUniqueId: "unique-audio" }), {
      direction: "inbound", mediaKind: "audio", telegramMessageId: 7,
      refs: [{ fileId: "remote-file", fileUniqueId: "unique-audio", size: 9, primary: true }],
    });
    input = {
      config, db, repos, user, thread,
      resolveFile: vi.fn(async () => ({
        bytes: Buffer.from("OggS data"), size: 9, contentSha256: "hash", mimeType: "audio/ogg",
        source: telegramFileSource({ fileId: "remote-file" }),
      })),
    };
    fetchMock = vi.fn().mockImplementation(async () => Response.json({ text: "Words from the recording." }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.destroy();
  });

  it("transcribes a scoped chat attachment without a sandbox", async () => {
    const result = await createTranscribeAudioTool(input).execute({ file_id: fileId });
    expect(result).toMatchObject({ text: "Words from the recording.", model: "microsoft/mai-transcribe-2" });
    expect(input.resolveFile).toHaveBeenCalledWith(expect.objectContaining({ id: fileId }), undefined);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).input_audio.format).toBe("ogg");
  });

  it("refuses files from a different thread before resolving bytes", async () => {
    const other = await input.repos.threads.create({ userId: input.user.tg_id, topicId: 432, title: "Other" });
    const result = await createTranscribeAudioTool({ ...input, thread: other }).execute({ file_id: fileId });
    expect(result).toEqual({ error: "File not found in this thread." });
    expect(input.resolveFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects the current turn's file visibility limit", async () => {
    const result = await createTranscribeAudioTool({
      ...input, currentScope: async () => ({ threadIds: [input.thread.id], messageIds: [], fileIds: [], messageScopes: [] }),
    }).execute({ file_id: fileId });
    expect(result).toEqual({ error: "File not found in this thread." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads workspace audio with a bounded size and passes cancellation through", async () => {
    const runtime = workspaceRuntime();
    runtime.put("/memo.m4a", Buffer.from("audio"));
    const controller = new AbortController();
    const result = await createTranscribeAudioTool({ ...input, commandRuntime: runtime }).execute({ path: "/memo.m4a", language: "en" }, controller.signal);
    expect(result).toMatchObject({ text: "Words from the recording." });
    expect(runtime.readWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({
      userId: input.user.tg_id, threadId: input.thread.id, virtualPath: "/memo.m4a", maxBytes: 20 * 1024 * 1024, signal: controller.signal,
    }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ input_audio: { format: "m4a" }, language: "en" });
  });

  it("validates source selection and language hints", () => {
    const schema = createTranscribeAudioTool(input).inputSchema;
    for (const value of [{}, { file_id: fileId, path: "/audio.wav" }, { path: "relative.wav" }, { file_id: fileId, language: "English" }]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
    expect(schema.safeParse({ path: "/recording", format: "ogg" }).success).toBe(true);
  });

  it("returns actionable errors and propagates cancellation", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    expect(await createTranscribeAudioTool(input).execute({ file_id: fileId })).toEqual({ error: "Error: OpenRouter transcription failed: HTTP 503" });
    await expect(createTranscribeAudioTool(input).execute({ file_id: fileId }, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("loads audio metadata without fetching bytes and recommends transcription", async () => {
    const result = await createLoadMessageTool(input).execute({ message_id: messageId, file_ids: [fileId] });
    expect(result).toMatchObject({ files: [expect.objectContaining({ file_id: fileId, recommended_tool: "transcribe_audio" })] });
    expect(input.resolveFile).not.toHaveBeenCalled();
  });
});
