import { afterEach, describe, expect, it, vi } from "vitest";
import { audioFormat, EmptyTranscriptError, transcribeAudio } from "../../src/audio/transcription.js";
import { loadTestConfig } from "../../src/config.js";
import { MAX_FILE_BYTES } from "../../src/files/limits.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter transcription", () => {
  it("sends base64 audio to the STT endpoint with the default model and returns text and usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      text: "  Please help me plan tomorrow.  ", usage: { seconds: 4.2, cost: 0.001 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = Buffer.from("OggS voice bytes");
    const result = await transcribeAudio(loadTestConfig(), { bytes, format: "ogg" });
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(request).toMatchObject({ method: "POST", headers: { Authorization: "Bearer test-openrouter" } });
    expect(JSON.parse(request.body)).toEqual({
      model: "microsoft/mai-transcribe-2", input_audio: { data: bytes.toString("base64"), format: "ogg" },
    });
    expect(result).toEqual({ text: "Please help me plan tomorrow.", model: "microsoft/mai-transcribe-2", usage: { seconds: 4.2, cost: 0.001 } });
  });

  it("honors model overrides and language hints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: "Привет" }));
    vi.stubGlobal("fetch", fetchMock);
    await transcribeAudio(loadTestConfig({ OPENROUTER_TRANSCRIPTION_MODEL: "vendor/custom-stt" }), {
      bytes: Buffer.from("audio"), format: "mp3", language: "ru",
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ model: "vendor/custom-stt", language: "ru" });
  });

  it.each([null, {}, { text: 12 }, { error: { message: "provider failed" } }])("rejects malformed provider responses: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(transcribeAudio(loadTestConfig(), { bytes: Buffer.from("audio"), format: "wav" })).rejects.toThrow("invalid transcription response");
  });

  it("rejects empty transcripts without inventing a prompt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ text: " \n " })));
    await expect(transcribeAudio(loadTestConfig(), { bytes: Buffer.from("audio"), format: "wav" })).rejects.toBeInstanceOf(EmptyTranscriptError);
  });

  it("reports HTTP failures without exposing provider response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private provider diagnostics", { status: 429 })));
    await expect(transcribeAudio(loadTestConfig(), { bytes: Buffer.from("audio"), format: "wav" })).rejects.toThrow("OpenRouter transcription failed: HTTP 429");
  });

  it("rejects empty and oversized files before sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_FILE_BYTES + 1)]) {
      await expect(transcribeAudio(loadTestConfig(), { bytes, format: "wav" })).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["stop", "timeout"])("aborts an in-flight request on %s", async (reason) => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    })));
    const promise = transcribeAudio(loadTestConfig({ TRANSCRIPTION_TIMEOUT_MS: reason === "timeout" ? 10 : 120_000 }), {
      bytes: Buffer.from("audio"), format: "wav", signal: controller.signal,
    });
    if (reason === "stop") controller.abort();
    await expect(promise).rejects.toMatchObject({ name: reason === "stop" ? "AbortError" : "TimeoutError" });
  });

  it("does not call OpenRouter when already cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(loadTestConfig(), {
      bytes: Buffer.from("audio"), format: "ogg", signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("audio format detection", () => {
  it.each([
    ["voice.ogg", "", "ogg"], ["voice.OPUS", "", "ogg"], ["audio.oga", "", "ogg"],
    ["track.MP3", "application/octet-stream", "mp3"], ["recording", "audio/ogg; codecs=opus", "ogg"],
    ["memo", "audio/mp4", "m4a"], ["track.flac", "", "flac"], ["recording.webm", "", "webm"],
    ["recording.wav", "", "wav"], ["recording.aac", "", "aac"], ["notes.txt", "text/plain", undefined],
  ])("detects %s with MIME %s", (name, mime, expected) => {
    expect(audioFormat(name, mime)).toBe(expected);
  });
});
