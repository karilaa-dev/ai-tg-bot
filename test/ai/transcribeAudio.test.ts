import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscribeAudioTool } from "../../src/ai/tools/transcribeAudio.js";
import { createLoadMessageTool } from "../../src/ai/tools/loadMessage.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import type { ToolBuildInput } from "../../src/ai/tools/types.js";
import { telegramFileSource } from "../../src/files/telegramSource.js";
import { audioFixture } from "../helpers/audio.js";
import { workspaceRuntime } from "../helpers/workspaceRuntime.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";
import type { TranscriptPage } from "../../src/audio/transcripts.js";

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
      extractionStatus: "source_only", name: "recording.ogg", size: audioFixture().length, isInline: false,
    });
    fileId = file.id;
    await repos.files.rememberTelegramObservation(file.id, telegramFileSource({ fileId: "remote-file", fileUniqueId: "unique-audio" }), {
      direction: "inbound", mediaKind: "audio", telegramMessageId: 7,
      refs: [{ fileId: "remote-file", fileUniqueId: "unique-audio", size: audioFixture().length, primary: true }],
    });
    input = {
      config, db, repos, user, thread,
      resolveFile: vi.fn(async () => ({
        bytes: audioFixture(), size: audioFixture().length, contentSha256: "hash", mimeType: "audio/ogg",
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
    expect(result).toMatchObject({ text: "Words from the recording.", model: "qwen/qwen3-asr-1.7b" });
    expect(input.resolveFile).toHaveBeenCalledWith(expect.objectContaining({ id: fileId }), undefined);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).input_audio.format).toBe("ogg");
  });

  it("bounds long transcripts in both Pi content and tool details", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ text: "long recording ".repeat(80_000) }));
    const tool = createPiToolAdapters({ buildInput: () => input }).find((entry) => entry.name === "transcribe_audio")!;
    const result = await tool.execute("audio-call", { file_id: fileId }, undefined, undefined, {} as never);
    expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThan(10_000);
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(10_000);
    expect(result.details).toMatchObject({ transcript_id: expect.any(String), next_offset: expect.any(Number), truncated: true });
  });

  it.each(["chat", "workspace"])("reads the complete saved %s transcript across Unicode pages with a smaller context", async (source) => {
    input.config.MODEL_CONTEXT_TOKENS = 8192;
    const fullText = `${"你好 🎙️ Привет!\n".repeat(700)}Last words.`;
    fetchMock.mockResolvedValueOnce(Response.json({ text: fullText }));
    const runtime = workspaceRuntime();
    runtime.put("/recording.ogg", audioFixture());
    const first = await createTranscribeAudioTool({ ...input, commandRuntime: runtime }).execute(
      source === "chat" ? { file_id: fileId } : { path: "/recording.ogg" },
    ) as TranscriptPage;
    expect(first).toMatchObject({ next_offset: expect.any(Number), truncated: true });
    // A new repository and tool instance have no in-memory transcription cache or resolver.
    const reader = createTranscribeAudioTool({ ...input, repos: createRepos(db.db, db.search), resolveFile: undefined });
    const pages: string[] = [];
    let page = first;
    do {
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(512);
      expect(page.text).toBe(fullText.slice(page.offset, page.next_offset ?? fullText.length));
      expect(page.text).not.toContain("�");
      pages.push(page.text);
      if (page.next_offset === null) break;
      page = await reader.execute({ transcript_id: page.transcript_id, offset: page.next_offset }) as TranscriptPage;
    } while (pages.length < 100);
    expect(pages.join("")).toBe(fullText);
    expect(page.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(runtime.readWorkspaceFile).toHaveBeenCalledTimes(source === "workspace" ? 1 : 0);
    expect(await reader.execute({ transcript_id: first.transcript_id, offset: fullText.length + 1 }))
      .toMatchObject({ error: expect.stringContaining("Invalid transcript offset") });
    expect(await reader.execute({ transcript_id: first.transcript_id, offset: fullText.indexOf("🎙") + 1 }))
      .toMatchObject({ error: expect.stringContaining("Invalid transcript offset") });
  });

  it("keeps transcript continuations within the user, file and message visibility scope", async () => {
    const later = await input.repos.messages.insert({ threadId: input.thread.id, role: "user", content: {}, textPlain: "Transcribe again" });
    fetchMock.mockResolvedValueOnce(Response.json({ text: "recording ".repeat(2000) }));
    const page = await createTranscribeAudioTool({ ...input, maxMessageId: later.id }).execute({ file_id: fileId }) as TranscriptPage;
    const args = { transcript_id: page.transcript_id, offset: page.next_offset! };
    const otherUser = await input.repos.users.ensure({ tgId: 812, lang: "en" });
    const otherThread = await input.repos.threads.create({ userId: input.user.tg_id, topicId: 432, title: "Other" });
    const beforeFork = await input.repos.threads.create({ userId: input.user.tg_id, topicId: 433, title: "Earlier", parentThreadId: input.thread.id, forkPointMessageId: messageId });
    const afterFork = await input.repos.threads.create({ userId: input.user.tg_id, topicId: 434, title: "Later", parentThreadId: input.thread.id, forkPointMessageId: later.id });
    for (const restricted of [
      { ...input, user: otherUser },
      { ...input, thread: otherThread },
      { ...input, maxMessageId: messageId },
      { ...input, thread: beforeFork },
      { ...input, currentScope: async () => ({ threadIds: [input.thread.id], messageIds: [later.id], messageScopes: [], fileIds: [] }) },
    ]) {
      expect(await createTranscribeAudioTool(restricted).execute(args)).toEqual({ error: "Transcript not found in this thread." });
    }
    expect(await createTranscribeAudioTool({ ...input, thread: afterFork }).execute(args)).toMatchObject({ text: expect.any(String) });
    expect(fetchMock).toHaveBeenCalledOnce();
    await input.repos.files.deleteFile(fileId);
    expect(await input.repos.audioTranscripts.get(page.transcript_id)).toBeUndefined();
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
    runtime.put("/memo.m4a", audioFixture("m4a"));
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
    const transcript_id = "4980aa81-1d42-47d2-bfd9-40d96522260b";
    for (const value of [
      {}, { file_id: fileId, path: "/audio.wav" }, { path: "relative.wav" }, { file_id: fileId, language: "English" },
      { transcript_id, file_id: fileId }, { transcript_id, path: "/audio.wav" }, { transcript_id, language: "en" },
      { transcript_id, format: "ogg" }, { transcript_id, offset: -1 }, { transcript_id, offset: 1.5 },
      { file_id: fileId, offset: 0 }, { transcript_id: "invalid" },
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
    expect(schema.safeParse({ path: "/recording", format: "ogg" }).success).toBe(true);
    expect(schema.safeParse({ transcript_id, offset: 8000 }).success).toBe(true);
  });

  it.each([
    { path: "/notes.txt", format: "wav" as const },
    { path: "/pretend.wav" },
  ])("does not upload non-audio workspace content with %j", async (args) => {
    const runtime = workspaceRuntime();
    runtime.put(args.path, Buffer.from("harmless non-audio content"));
    const tool = createTranscribeAudioTool({ ...input, commandRuntime: runtime });
    expect(await tool.execute(tool.inputSchema.parse(args))).toMatchObject({ error: expect.stringContaining("supported audio format") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-audio chat bytes even with an audio MIME type and format override", async () => {
    const resolved = await input.resolveFile!((await input.repos.files.get(fileId))!);
    input.resolveFile = vi.fn(async () => ({ ...resolved, bytes: Buffer.from("harmless non-audio content") }));
    expect(await createTranscribeAudioTool(input).execute({ file_id: fileId, format: "ogg" })).toMatchObject({ error: expect.stringContaining("supported audio format") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts an extensionless recording when the format hint matches its bytes", async () => {
    const runtime = workspaceRuntime();
    runtime.put("/recording", audioFixture());
    expect(await createTranscribeAudioTool({ ...input, commandRuntime: runtime }).execute({ path: "/recording", format: "ogg" })).toMatchObject({ text: "Words from the recording." });
  });

  it("returns actionable errors and propagates cancellation", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 503, headers: { "Retry-After": "0" } }));
    expect(await createTranscribeAudioTool(input).execute({ file_id: fileId })).toEqual({ error: "Error: OpenRouter transcription failed: HTTP 503" });
    await expect(createTranscribeAudioTool(input).execute({ file_id: fileId }, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("loads audio metadata without fetching bytes and recommends transcription", async () => {
    const result = await createLoadMessageTool(input).execute({ message_id: messageId, file_ids: [fileId] });
    expect(result).toMatchObject({ files: [expect.objectContaining({ file_id: fileId, recommended_tool: "transcribe_audio" })] });
    expect(input.resolveFile).not.toHaveBeenCalled();
  });
});
