import path from "node:path";
import { z } from "zod";
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
  return parsed.success ? parsed.data : mimeFormats[mime.split(";")[0]!.trim().toLowerCase()];
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

export async function transcribeAudio(
  config: Pick<AppConfig, "OPENROUTER_API_KEY" | "OPENROUTER_TRANSCRIPTION_MODEL" | "TRANSCRIPTION_TIMEOUT_MS">,
  input: { bytes: Buffer; format: AudioFormat; language?: string; signal?: AbortSignal },
) {
  input.signal?.throwIfAborted();
  if (!input.bytes.length) throw new Error("The audio file is empty.");
  if (input.bytes.length > MAX_FILE_BYTES) throw new Error("Audio exceeds the 20 MB file size limit.");
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(config.TRANSCRIPTION_TIMEOUT_MS),
  ]);
  const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
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
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenRouter transcription failed: HTTP ${response.status}`);
  }
  const parsed = TranscriptSchema.safeParse(await response.json());
  signal.throwIfAborted();
  if (!parsed.success) throw new Error("OpenRouter returned an invalid transcription response.");
  const text = parsed.data.text.trim();
  if (!text) throw new EmptyTranscriptError();
  return { text, model: config.OPENROUTER_TRANSCRIPTION_MODEL, usage: parsed.data.usage };
}
