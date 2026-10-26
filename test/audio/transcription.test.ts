import { afterEach, describe, expect, it, vi } from "vitest";
import { audioFormat, EmptyTranscriptError, transcribeAudio } from "../../src/audio/transcription.js";
import { loadTestConfig } from "../../src/config.js";
import { audioFixture } from "../helpers/audio.js";
import { MAX_TRANSCRIPTION_BYTES } from "../../src/audio/transcription.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenRouter transcription", () => {
  it.each(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"] as const)("accepts a real %s byte signature", async (format) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: "test transcript" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(format), format })).resolves.toMatchObject({ text: "test transcript" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"] as const)("refuses non-audio bytes labeled as %s before upload", async (format) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(loadTestConfig(), { bytes: Buffer.from("harmless text, not audio"), format })).rejects.toThrow("supported audio format");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched and truncated audio signatures before upload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "mp3" })).rejects.toThrow("format mismatch");
    await expect(transcribeAudio(loadTestConfig(), { bytes: Buffer.from("OggS"), format: "ogg" })).rejects.toThrow("supported audio format");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends base64 audio to the STT endpoint with the default model and returns text and usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      text: "  Please help me plan tomorrow.  ", usage: { seconds: 4.2, cost: 0.001 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = audioFixture();
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
      bytes: audioFixture("mp3"), format: "mp3", language: "ru",
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ model: "vendor/custom-stt", language: "ru" });
  });

  const diarized = {
    text: "Hello there. Hi, how are you? Fine.",
    segments: [
      { id: 0, start: 0, end: 1.2, text: " Hello there.", speaker: 0 },
      { id: 1, start: 1.5, end: 3.1, text: "Hi, how are you?", speaker: 1 },
      { id: 2, start: 3.2, end: 3725.9, text: "Fine.", speaker: 1 },
    ],
  };

  it("requests segments with diarization and formats speaker labels and timestamps", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(diarized));
    vi.stubGlobal("fetch", fetchMock);
    const result = await transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "ogg", speakers: true, timestamps: true });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
      response_format: "verbose_json", timestamp_granularities: ["segment"],
      provider: { options: { azure: { diarization: { enabled: true } } } },
    });
    expect(result).toMatchObject({
      text: "[0:00-0:01] Speaker 1: Hello there.\n[0:01-0:03] Speaker 2: Hi, how are you?\n[0:03-1:02:05] Speaker 2: Fine.",
      speaker_labels: true, timestamps: true,
    });
  });

  it("merges speaker turns without timestamps and skips diarization without speakers", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json(diarized));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "ogg", speakers: true, timestamps: false }))
      .resolves.toMatchObject({ text: "Speaker 1: Hello there.\nSpeaker 2: Hi, how are you? Fine.", speaker_labels: true, timestamps: false });
    await expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "ogg", timestamps: true }))
      .resolves.toMatchObject({ text: "[0:00-0:01] Hello there.\n[0:01-0:03] Hi, how are you?\n[0:03-1:02:05] Fine.", speaker_labels: false });
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(body).toMatchObject({ response_format: "verbose_json" });
    expect(body).not.toHaveProperty("provider");
  });

  it("falls back to plain text when the provider returns no usable segments or speakers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ text: "Just text." }))
      .mockResolvedValueOnce(Response.json({ text: "Just text.", segments: "not a list" }))
      .mockResolvedValueOnce(Response.json({ text: "One voice.", segments: [{ start: 0, end: 2, text: "One voice." }] }));
    vi.stubGlobal("fetch", fetchMock);
    const options = { bytes: audioFixture(), format: "ogg", speakers: true, timestamps: false } as const;
    await expect(transcribeAudio(loadTestConfig(), options)).resolves.toMatchObject({ text: "Just text.", speaker_labels: false, timestamps: false });
    await expect(transcribeAudio(loadTestConfig(), options)).resolves.toMatchObject({ text: "Just text.", speaker_labels: false });
    await expect(transcribeAudio(loadTestConfig(), options)).resolves.toMatchObject({ text: "One voice.", speaker_labels: false });
  });

  it("keeps requested timestamps when no speaker labels come back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ text: "One voice.", segments: [{ start: 0, end: 2, text: "One voice." }] })));
    await expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "ogg", speakers: true, timestamps: true }))
      .resolves.toMatchObject({ text: "[0:00-0:02] One voice.", speaker_labels: false, timestamps: true });
  });

  it.each([null, {}, { text: 12 }, { error: { message: "provider failed" } }])("rejects malformed provider responses: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture("wav"), format: "wav" })).rejects.toThrow("invalid transcription response");
  });

  it("rejects empty transcripts without inventing a prompt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ text: " \n " })));
    await expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture("wav"), format: "wav" })).rejects.toBeInstanceOf(EmptyTranscriptError);
  });

  it("reports HTTP failures without exposing provider response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private provider diagnostics", { status: 429, headers: { "Retry-After": "0" } })));
    await expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture("wav"), format: "wav" })).rejects.toThrow("OpenRouter transcription failed: HTTP 429");
  });

  it.each([429, 502, 503, 504])("recovers from HTTP %s with backoff on the same model", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status }))
      .mockResolvedValueOnce(new Response("unavailable", { status }))
      .mockResolvedValue(Response.json({ text: "Recovered transcript" }));
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "ogg", language: "en" }))
      .resolves.toMatchObject({ text: "Recovered transcript", model: "microsoft/mai-transcribe-2" });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
    expect(fetchMock.mock.calls[2]).toEqual(fetchMock.mock.calls[0]);
  });

  it.each(["seconds", "date"])("honors Retry-After expressed as %s", async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const retryAfter = kind === "seconds" ? "5" : new Date(Date.now() + 5000).toUTCString();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": retryAfter } }))
      .mockResolvedValue(Response.json({ text: "Recovered transcript" }));
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "ogg" })).resolves.toMatchObject({ text: "Recovered transcript" });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops after three rate-limited attempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "ogg" })).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 402, 403])("does not retry permanent HTTP %s errors", async (status) => {
    const fetchMock = vi.fn(async () => new Response("invalid request", { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "ogg" })).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry earlier than a Retry-After that exceeds the total timeout", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "600" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(loadTestConfig({ TRANSCRIPTION_TIMEOUT_MS: 100 }), { bytes: audioFixture(), format: "ogg" })).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels during retry backoff without starting another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(transcribeAudio(loadTestConfig(), { bytes: audioFixture(), format: "ogg", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one timeout across attempts and retry waits", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "0.01" } }))
      .mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(loadTestConfig({ TRANSCRIPTION_TIMEOUT_MS: 50 }), { bytes: audioFixture(), format: "ogg" })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1].signal).toBe(fetchMock.mock.calls[0]![1].signal);
  });

  it("rejects empty and oversized files before sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_TRANSCRIPTION_BYTES + 1)]) {
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
      bytes: audioFixture("wav"), format: "wav", signal: controller.signal,
    });
    if (reason === "stop") controller.abort();
    await expect(promise).rejects.toMatchObject({ name: reason === "stop" ? "AbortError" : "TimeoutError" });
  });

  it("does not call OpenRouter when already cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(loadTestConfig(), {
      bytes: audioFixture(), format: "ogg", signal: AbortSignal.abort(),
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
