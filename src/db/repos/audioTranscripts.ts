import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { queryOne, type SqlExecutor } from "../sql.js";

export interface AudioTranscriptSource {
  userId: number;
  threadId: number;
  fileId?: number;
  messageId?: number;
  telegramUpdateId?: number;
}

export interface AudioTranscriptRow {
  id: string;
  user_id: number;
  thread_id: number;
  source_file_id: number | null;
  source_message_id: number | null;
  telegram_update_id: number | null;
  visible_message_id: number | null;
  text: string;
  model: string;
}

export class AudioTranscriptsRepo {
  constructor(private readonly db: SqlExecutor) {}

  async insert(source: AudioTranscriptSource, transcript: { text: string; model: string }): Promise<string> {
    const id = randomUUID();
    await this.db.execute(sql`
      insert into audio_transcripts (
        id, user_id, thread_id, source_file_id, source_message_id, telegram_update_id, text, model, created_at
      ) values (
        ${id}, ${source.userId}, ${source.threadId}, ${source.fileId ?? null}, ${source.messageId ?? null},
        ${source.telegramUpdateId ?? null}, ${transcript.text}, ${transcript.model}, ${Date.now()}
      )
    `);
    return id;
  }

  get(id: string): Promise<AudioTranscriptRow | undefined> {
    // Telegram transcripts are saved before acceptance, including pending albums.
    // Resolve their message only after the source has been durably accepted.
    return queryOne<AudioTranscriptRow>(this.db, sql`
      select t.*, coalesce(t.source_message_id, r.user_message_id) as visible_message_id
      from audio_transcripts t
      left join turn_run_sources s on s.telegram_update_id = t.telegram_update_id
      left join turn_runs r on r.id = s.turn_run_id
      where t.id = ${id}
    `);
  }
}
