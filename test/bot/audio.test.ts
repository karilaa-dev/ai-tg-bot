import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { deferred } from "../helpers/async.js";
import { MAX_FILE_BYTES } from "../../src/files/limits.js";
import { createTranscribeAudioTool } from "../../src/ai/tools/transcribeAudio.js";

describe("Telegram audio prompts", () => {
  let env: GrammyEmulator;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    env = await createGrammyEmulator();
    fetchMock = vi.fn().mockImplementation(async () => Response.json({ text: "Help me plan tomorrow." }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await env.dispose();
  });

  async function processUpdate(update: ReturnType<typeof voiceUpdate>) {
    return (await env.bot.processUpdatesConcurrently([update]))[0]!;
  }

  function voiceUpdate(options: { caption?: string; fileSize?: number; content?: Buffer } = {}) {
    const voice = env.bot.server.fileState.storeVoice(4, {
      mimeType: "audio/ogg", content: options.content ?? Buffer.from("OggS voice data"), fileSize: options.fileSize,
    });
    return env.bot.server.updateFactory.createVoiceMessage(env.user, env.chat, voice, { caption: options.caption });
  }

  it("uses a voice transcript as a prompt, stores its source, and keeps it available to the tool", async () => {
    const update = voiceUpdate();
    const res = await processUpdate(update);
    expect(JSON.stringify(res.getLastApiCall("sendRichMessage")?.payload)).toContain("Echo: Help me plan tomorrow.");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const messages = await env.repos.messages.listThread(thread.id);
    expect(messages.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(JSON.parse(messages[0]!.content_json).text).toContain("Help me plan tomorrow.");
    const files = await env.repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ type: "audio", extraction_status: "source_only" });
    expect(await env.repos.files.listTelegramFileRefs([files[0]!.id])).toEqual([
      expect.objectContaining({ media_kind: "voice", telegram_file_id: update.message!.voice!.file_id, telegram_message_id: update.message!.message_id }),
    ]);
    const user = (await env.repos.users.get(env.user.id))!;
    const result = await createTranscribeAudioTool({
      config: env.config, db: env.db, repos: env.repos, user, thread,
      resolveFile: (file, signal) => env.services.fileResolver.resolveFile(file, signal),
    }).execute({ file_id: files[0]!.id });
    expect(result).toMatchObject({ text: "Help me plan tomorrow." });
  });

  it("preserves an audio message's caption and detected format", async () => {
    const audio = env.bot.server.fileState.storeAudio(4, {
      fileName: "memo.m4a", mimeType: "audio/mp4", content: Buffer.from("m4a audio"),
    });
    await processUpdate(env.bot.server.updateFactory.createAudioMessage(env.user, env.chat, audio, { caption: "Reply in Russian" }));
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const [message] = await env.repos.messages.listThread(thread.id);
    expect(message!.text_plain).toContain("Reply in Russian\n\nHelp me plan tomorrow.");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).input_audio.format).toBe("m4a");
    const [file] = await env.repos.files.listForThreads([thread.id]);
    expect(await env.repos.files.listTelegramFileRefs([file!.id])).toEqual([expect.objectContaining({ media_kind: "audio" })]);
  });

  it("keeps audio sent as a document available for requested transcription", async () => {
    await env.bot.sendDocument(env.user, env.chat, {
      fileName: "interview.mp3", mimeType: "audio/mpeg", content: Buffer.from("recording"),
    }, { caption: "Summarize the interview" });
    expect(fetchMock).not.toHaveBeenCalled();
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    const [message] = await env.repos.messages.listThread(thread.id);
    expect(message!.text_plain).toContain("Summarize the interview");
    expect(message!.text_plain).toContain("transcribe_audio");
    expect(await env.repos.files.listForThreads([thread.id])).toEqual([expect.objectContaining({ type: "audio", extraction_status: "source_only" })]);
  });

  it.each(["provider", "no speech"])("does not start a turn after %s failure", async (failure) => {
    fetchMock.mockResolvedValue(failure === "provider"
      ? new Response("unavailable", { status: 503 })
      : Response.json({ text: "  " }));
    const res = await processUpdate(voiceUpdate());
    const surface = JSON.stringify([...res.messages, ...res.editedMessages]);
    expect(surface).toContain(failure === "provider" ? "could not transcribe" : "could not recognize any speech");
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    expect(await env.repos.messages.listThread(thread.id)).toHaveLength(0);
    expect(env.services.routerState.activeFileJobs.size).toBe(0);
  });

  it.each(["metadata", "download"])("rejects oversized audio from %s before transcription", async (source) => {
    const update = voiceUpdate(source === "metadata"
      ? { fileSize: MAX_FILE_BYTES + 1 }
      : { fileSize: 1, content: Buffer.alloc(MAX_FILE_BYTES + 1) });
    await processUpdate(update);
    expect(fetchMock).not.toHaveBeenCalled();
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    expect(await env.repos.messages.listThread(thread.id)).toHaveLength(0);
  });

  it("lets /stop cancel transcription and accepts the next voice message", async () => {
    const started = deferred<void>();
    fetchMock.mockImplementationOnce((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      started.resolve();
    }));
    const pending = processUpdate(voiceUpdate());
    await started.promise;
    await env.bot.sendCommand(env.user, env.chat, "/stop");
    await pending;
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    expect(await env.repos.messages.listThread(thread.id)).toHaveLength(0);
    expect(env.services.routerState.activeFileJobs.size).toBe(0);
    await processUpdate(voiceUpdate());
    expect(await env.repos.messages.listThread(thread.id)).toHaveLength(2);
  });

  it("batches an audio album into one prompt with its transcripts and caption", async () => {
    const updates = [1, 2].map((n) => {
      const audio = env.bot.server.fileState.storeAudio(4, { fileName: `part-${n}.mp3`, content: Buffer.from(`audio-${n}`) });
      const update = env.bot.server.updateFactory.createAudioMessage(env.user, env.chat, audio, { caption: n === 1 ? "Use both parts" : undefined });
      update.message!.media_group_id = "audio-album";
      return update;
    });
    fetchMock.mockResolvedValueOnce(Response.json({ text: "First part." })).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return Response.json({ text: "Second part." });
    });
    await env.bot.processUpdatesConcurrently(updates);
    const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
    await vi.waitFor(async () => expect(await env.repos.messages.listThread(thread.id)).toHaveLength(2));
    const [message] = await env.repos.messages.listThread(thread.id);
    expect(message!.text_plain).toContain("Use both parts");
    expect(message!.text_plain).toContain("First part.");
    expect(message!.text_plain).toContain("Second part.");
    expect(await env.repos.files.listForMessage(message!.id)).toHaveLength(2);
  });
});
