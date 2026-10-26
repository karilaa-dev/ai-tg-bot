import { z } from "zod";
import { audioFormat, AudioFormatSchema, MAX_TRANSCRIPTION_BYTES, transcribeAudio } from "../../audio/transcription.js";
import { boundTranscript, transcriptPage } from "../../audio/transcripts.js";
import { threadVisibilityScope } from "../../memory/retrieval.js";
import { getScopedFile, normalizeBashCwd, toToolError } from "./helpers.js";
import { defineBotTool, type ToolBuildInput } from "./types.js";

export function createTranscribeAudioTool(input: ToolBuildInput) {
  return defineBotTool({
    holdsCommandActivity: true,
    description: "Transcribe speech from a chat audio file or an absolute workspace path using OpenRouter. Supply exactly one of file_id, path, or transcript_id. Supports WAV, MP3, FLAC, M4A, OGG/Opus, WebM, and AAC up to 20 MB. Returns original-language text in bounded pages. New transcriptions default to one line per segment with timestamps and speaker labels, such as [1:05-1:12] Speaker 2: text; speaker_labels and timestamps in the result report what the provider returned. Set speaker_labels or timestamps to false when they are not useful, for example a single speaker or text to quote. When next_offset is non-null, read more with transcript_id and offset=next_offset; this reads the saved transcript without another provider request. Read only sections needed for the task. Telegram voice/audio prompts already contain a transcript or a preview with continuation instructions; reuse those unless asked to transcribe again.",
    inputSchema: z.object({
      file_id: z.string().uuid().optional(),
      path: z.string().startsWith("/").optional(),
      transcript_id: z.string().uuid().optional().describe("Saved transcript ID returned by this tool or the audio prompt."),
      offset: z.number().int().nonnegative().optional().describe("Use the returned next_offset to read a saved transcript; defaults to zero."),
      format: AudioFormatSchema.optional().describe("Format hint for files without a recognized name or MIME type. Must match the audio byte signature."),
      language: z.string().regex(/^[a-z]{2}$/).optional().describe("Optional ISO-639-1 language hint; omit to auto-detect."),
      speaker_labels: z.boolean().optional().describe("Label who is speaking (Speaker 1, Speaker 2, ...). Defaults to true."),
      timestamps: z.boolean().optional().describe("Start each segment with its [m:ss-m:ss] time range. Defaults to true."),
    }).refine((value) => [value.file_id, value.path, value.transcript_id].filter((source) => source !== undefined).length === 1, {
      message: "Supply exactly one of file_id, path, or transcript_id.",
    }).refine((value) => value.offset === undefined || value.transcript_id !== undefined, {
      message: "offset requires transcript_id.",
    }).refine((value) => value.transcript_id === undefined
      || [value.format, value.language, value.speaker_labels, value.timestamps].every((option) => option === undefined), {
      message: "format, language, speaker_labels and timestamps apply only to new transcriptions.",
    }),
    execute: async ({ file_id, path, transcript_id, offset, format, language, speaker_labels = true, timestamps = true }, signal) => {
      try {
        signal?.throwIfAborted();
        if (transcript_id !== undefined) {
          const transcript = await input.repos.audioTranscripts.get(transcript_id);
          const scope = await (input.currentScope?.() ?? threadVisibilityScope(input.repos, input.thread, input.maxMessageId));
          if (!transcript || transcript.user_id !== input.user.tg_id
            || !scope.threadIds.includes(transcript.thread_id)
            || transcript.visible_message_id === null || !scope.messageIds.includes(transcript.visible_message_id)) {
            return { error: "Transcript not found in this thread." };
          }
          // Saved text survives source expiry. Keep the file's message visibility
          // boundary without requiring its original audio bytes to be recoverable.
          if (transcript.source_file_id !== null && !scope.fileIds.includes(transcript.source_file_id)
            && !(await input.repos.files.listVisibleIds(scope.messageScopes, input.maxMessageId === undefined))
              .includes(transcript.source_file_id)) {
            return { error: "Transcript not found in this thread." };
          }
          signal?.throwIfAborted();
          return transcriptPage(input.config, transcript, transcript.id, offset);
        }
        let name: string;
        let mime: string | undefined;
        let bytes: Buffer;
        if (file_id !== undefined) {
          const file = await getScopedFile(input, file_id);
          if (!file) return { error: "File not found in this thread." };
          if (file.size > MAX_TRANSCRIPTION_BYTES) return { error: "Audio exceeds the 20 MB file size limit." };
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
            maxBytes: MAX_TRANSCRIPTION_BYTES,
            signal,
          })).bytes;
        }
        const detected = format ?? audioFormat(name, mime);
        if (!detected) return { error: "Unsupported audio format." };
        const transcript = await transcribeAudio(input.config, {
          bytes, format: detected, language, speakers: speaker_labels, timestamps, signal,
        });
        signal?.throwIfAborted();
        const scope = await (input.currentScope?.() ?? threadVisibilityScope(input.repos, input.thread, input.maxMessageId));
        signal?.throwIfAborted();
        return await boundTranscript(input.config, input.repos.audioTranscripts, {
          userId: input.user.tg_id, threadId: input.thread.id, fileId: file_id,
          messageId: input.maxMessageId ?? scope.messageIds.at(-1),
        }, transcript);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        return toToolError(input, "transcribe_audio", error);
      }
    },
  });
}
