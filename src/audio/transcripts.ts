import type { AppConfig } from "../config.js";
import type { AudioTranscriptSource, AudioTranscriptsRepo } from "../db/repos/audioTranscripts.js";

type TranscriptConfig = Pick<AppConfig, "MODEL_CONTEXT_TOKENS">;

export interface TranscriptPage {
  text: string;
  model: string;
  transcript_id: string;
  offset: number;
  next_offset: number | null;
  total_chars: number;
  truncated: boolean;
}

function pageBytes(config: TranscriptConfig): number {
  // UTF-8 bytes are a conservative proxy, not an exact token count. Reserve room
  // for history, instructions and up to ten audio attachments in a Telegram album.
  return Math.max(4, Math.min(8000, Math.floor(config.MODEL_CONTEXT_TOKENS / 16)));
}

export function transcriptPage(
  config: TranscriptConfig,
  transcript: { text: string; model: string },
  id: string,
  offset = 0,
): TranscriptPage {
  const { text, model } = transcript;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? ""))) {
    throw new Error("Invalid transcript offset. Use the returned next_offset.");
  }
  const budget = pageBytes(config);
  let end = offset;
  let bytes = 0;
  while (end < text.length) {
    const character = String.fromCodePoint(text.codePointAt(end)!);
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    bytes += size;
    end += character.length;
  }
  return {
    text: text.slice(offset, end), model, transcript_id: id,
    offset, next_offset: end < text.length ? end : null,
    total_chars: text.length, truncated: end < text.length,
  };
}

export async function boundTranscript<T extends { text: string; model: string }>(
  config: TranscriptConfig,
  repo: AudioTranscriptsRepo,
  source: AudioTranscriptSource,
  transcript: T,
): Promise<T | (T & TranscriptPage)> {
  if (Buffer.byteLength(transcript.text) <= pageBytes(config)) return transcript;
  const id = await repo.insert(source, transcript);
  return { ...transcript, ...transcriptPage(config, transcript, id) };
}
