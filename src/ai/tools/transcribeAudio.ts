import { z } from "zod";
import { audioFormat, AudioFormatSchema, transcribeAudio } from "../../audio/transcription.js";
import { MAX_FILE_BYTES } from "../../files/limits.js";
import { getScopedFile, normalizeBashCwd, toToolError } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createTranscribeAudioTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description: "Transcribe speech from a chat audio file or an absolute path in this thread's workspace using OpenRouter. Supply exactly one of file_id or path. Supports WAV, MP3, FLAC, M4A, OGG/Opus, WebM, and AAC up to 20 MB. Returns the transcript in its original language. Telegram voice and audio messages already include their transcript as the user's prompt; reuse that text unless asked to transcribe again.",
    inputSchema: z.object({
      file_id: z.number().int().positive().optional(),
      path: z.string().startsWith("/").optional(),
      format: AudioFormatSchema.optional().describe("Format hint for files without a recognized name or MIME type. Must match the audio byte signature."),
      language: z.string().regex(/^[a-z]{2}$/).optional().describe("Optional ISO-639-1 language hint; omit to auto-detect."),
    }).refine((value) => (value.file_id !== undefined) !== (value.path !== undefined), {
      message: "Supply exactly one of file_id or path.",
    }),
    execute: async ({ file_id, path, format, language }, signal) => {
      try {
        signal?.throwIfAborted();
        let name: string;
        let mime: string | undefined;
        let bytes: Buffer;
        if (file_id !== undefined) {
          const file = await getScopedFile(input, file_id);
          if (!file) return { error: "File not found in this thread." };
          if (file.size > MAX_FILE_BYTES) return { error: "Audio exceeds the 20 MB file size limit." };
          if (!input.resolveFile) return { error: "Chat file resolver is unavailable." };
          name = file.name;
          mime = file.mime_type ?? undefined;
          if (!format && !audioFormat(name, mime)) return { error: "Unsupported audio format." };
          bytes = (await input.resolveFile(file, signal)).bytes;
        } else {
          if (!path) return { error: "Supply exactly one of file_id or path." };
          if (!input.commandRuntime) return { error: "E2B command runtime is unavailable." };
          name = normalizeBashCwd(path);
          if (!format && !audioFormat(name)) return { error: "Unsupported audio format." };
          bytes = (await input.commandRuntime.readWorkspaceFile({
            userId: input.user.tg_id,
            threadId: input.thread.id,
            virtualPath: name,
            maxBytes: MAX_FILE_BYTES,
            signal,
          })).bytes;
        }
        const detected = format ?? audioFormat(name, mime);
        if (!detected) return { error: "Unsupported audio format." };
        return await transcribeAudio(input.config, { bytes, format: detected, language, signal });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        return toToolError(input, "transcribe_audio", error);
      }
    },
  });
}
