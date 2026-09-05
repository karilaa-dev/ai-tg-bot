import path from "node:path";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import type { AppConfig } from "../config.js";
import { MAX_FILE_BYTES } from "../files/limits.js";

export const AudioFormatSchema = z.enum(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"]);
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

const mimeFormats: Record<string, AudioFormat> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/flac": "flac", "audio/x-flac": "flac",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a",
  "audio/ogg": "ogg", "application/ogg": "ogg", "audio/opus": "ogg",
  "audio/webm": "webm", "audio/aac": "aac", "audio/x-aac": "aac",
};

export function audioFormat(name: string, mime = ""): AudioFormat | undefined {
  const extension = path.extname(name).slice(1).toLowerCase();
  if (extension === "oga" || extension === "opus") return "ogg";
  const parsed = AudioFormatSchema.safeParse(extension);
  if (parsed.success) return parsed.data;
  const mediaType = mime.split(";")[0]!.trim().toLowerCase();
  return Object.hasOwn(mimeFormats, mediaType) ? mimeFormats[mediaType] : undefined;
}

async function validateAudioBytes(bytes: Buffer, expected: AudioFormat): Promise<void> {
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  const actual = detected && audioFormat(`audio.${detected.ext}`, detected.mime);
  if (!actual) throw new Error("File does not contain a supported audio format.");
  if (actual !== expected) throw new Error(`Audio format mismatch: expected ${expected}, detected ${actual}.`);
}

const TranscriptSchema = z.object({
  text: z.string(),
  usage: z.object({
    seconds: z.number().nonnegative().optional(),
    total_tokens: z.number().nonnegative().optional(),
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  }).optional(),
});

export class EmptyTranscriptError extends Error {
  constructor() {
    super("No speech was recognized in the audio.");
    this.name = "EmptyTranscriptError";
  }
}

export class TranscriptionHttpError extends Error {
  constructor(readonly status: number) {
    super(`OpenRouter transcription failed: HTTP ${status}`);
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after")?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    if (!Number.isFinite(seconds)) {
      const date = Date.parse(value);
      if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }
  }
  return 1000 * 2 ** attempt;
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestTranscription(request: RequestInit, signal: AbortSignal, deadline: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", request);
    if (response.ok) return response;
    await response.body?.cancel();
    signal.throwIfAborted();
    const delay = retryDelayMs(response, attempt);
    if (attempt >= 2 || ![429, 502, 503, 504].includes(response.status) || Date.now() + delay >= deadline) {
      throw new TranscriptionHttpError(response.status);
    }
    await waitForRetry(delay, signal);
  }
}

export async function transcribeAudio(
  config: Pick<AppConfig, "OPENROUTER_API_KEY" | "OPENROUTER_TRANSCRIPTION_MODEL" | "TRANSCRIPTION_TIMEOUT_MS">,
  input: { bytes: Buffer; format: AudioFormat; language?: string; signal?: AbortSignal },
) {
  input.signal?.throwIfAborted();
  if (!input.bytes.length) throw new Error("The audio file is empty.");
  if (input.bytes.length > MAX_FILE_BYTES) throw new Error("Audio exceeds the 20 MB file size limit.");
  await validateAudioBytes(input.bytes, input.format);
  input.signal?.throwIfAborted();
  const deadline = Date.now() + config.TRANSCRIPTION_TIMEOUT_MS;
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(config.TRANSCRIPTION_TIMEOUT_MS),
  ]);
  const response = await requestTranscription({
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.OPENROUTER_TRANSCRIPTION_MODEL,
      input_audio: { data: input.bytes.toString("base64"), format: input.format },
      ...(input.language ? { language: input.language } : {}),
    }),
    signal,
  }, signal, deadline);
  const parsed = TranscriptSchema.safeParse(await response.json());
  signal.throwIfAborted();
  if (!parsed.success) throw new Error("OpenRouter returned an invalid transcription response.");
  const text = parsed.data.text.trim();
  if (!text) throw new EmptyTranscriptError();
  return { text, model: config.OPENROUTER_TRANSCRIPTION_MODEL, usage: parsed.data.usage };
}
