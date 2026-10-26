import path from "node:path";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import type { AppConfig } from "../config.js";
import { FileTooLargeError } from "../files/limits.js";

export const MAX_TRANSCRIPTION_BYTES = 20 * 1024 * 1024;

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

export async function detectAudioType(bytes: Buffer, expected?: AudioFormat): Promise<{ format: AudioFormat; mimeType: string }> {
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  const actual = detected && audioFormat(`audio.${detected.ext}`, detected.mime);
  if (!actual) throw new Error("File does not contain a supported audio format.");
  if (expected && actual !== expected) throw new Error(`Audio format mismatch: expected ${expected}, detected ${actual}.`);
  return { format: actual, mimeType: detected.mime };
}

const SegmentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
  speaker: z.number().int().nonnegative().optional(),
});
type Segment = z.infer<typeof SegmentSchema>;

const TranscriptSchema = z.object({
  text: z.string(),
  // Only verbose_json responses carry segments; a malformed list falls back to the plain text.
  segments: z.array(SegmentSchema).optional().catch(undefined),
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

/** Speaker labels and timestamps the caller asked for; both need verbose_json segments. */
export interface TranscriptLayout { speakers?: boolean; timestamps?: boolean }

function clock(seconds: number): string {
  const total = Math.floor(seconds);
  const [hours, minutes, rest] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** One line per segment, or per speaker turn when only speakers are labeled. */
export function formatSegments(segments: Segment[], layout: TranscriptLayout): { text: string; speakers: boolean; timestamps: boolean } {
  const lines = segments.map((segment) => ({ ...segment, text: segment.text.trim() })).filter((segment) => segment.text);
  // A provider that found one voice, or ignored diarization, labels nothing; "Speaker 1" alone adds no information.
  const speakers = Boolean(layout.speakers) && lines.some((segment) => segment.speaker !== undefined);
  const timestamps = Boolean(layout.timestamps);
  const label = (segment: Segment) => speakers ? `Speaker ${segment.speaker === undefined ? "?" : segment.speaker + 1}: ` : "";
  if (timestamps) {
    return { speakers, timestamps, text: lines.map((segment) => `[${clock(segment.start)}-${clock(segment.end)}] ${label(segment)}${segment.text}`).join("\n") };
  }
  const turns: { segment: Segment; text: string }[] = [];
  for (const segment of lines) {
    const last = turns.at(-1);
    if (last && last.segment.speaker === segment.speaker) last.text += ` ${segment.text}`;
    else turns.push({ segment, text: segment.text });
  }
  return { speakers, timestamps, text: turns.map((turn) => `${label(turn.segment)}${turn.text}`).join("\n") };
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
  input: { bytes: Buffer; format: AudioFormat; language?: string; signal?: AbortSignal } & TranscriptLayout,
) {
  input.signal?.throwIfAborted();
  if (!input.bytes.length) throw new Error("The audio file is empty.");
  if (input.bytes.length > MAX_TRANSCRIPTION_BYTES) throw new FileTooLargeError("Audio exceeds the 20 MB file size limit.");
  await detectAudioType(input.bytes, input.format);
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
      ...(input.speakers || input.timestamps ? { response_format: "verbose_json", timestamp_granularities: ["segment"] } : {}),
      // Diarization is a provider option; OpenRouter forwards it only to Azure, which serves MAI-Transcribe.
      ...(input.speakers ? { provider: { options: { azure: { diarization: { enabled: true } } } } } : {}),
    }),
    signal,
  }, signal, deadline);
  const parsed = TranscriptSchema.safeParse(await response.json());
  signal.throwIfAborted();
  if (!parsed.success) throw new Error("OpenRouter returned an invalid transcription response.");
  const plain = parsed.data.text.trim();
  if (!plain) throw new EmptyTranscriptError();
  const model = config.OPENROUTER_TRANSCRIPTION_MODEL;
  const { usage, segments } = parsed.data;
  if (!input.speakers && !input.timestamps) return { text: plain, model, usage };
  const layout = segments?.length ? formatSegments(segments, input) : null;
  if (!layout?.text) return { text: plain, model, usage, speaker_labels: false, timestamps: false };
  return { text: layout.text, model, usage, speaker_labels: layout.speakers, timestamps: layout.timestamps };
}
