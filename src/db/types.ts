export type StoredFileType = "txt" | "csv" | "pdf" | "docx" | "image" | "other";

export type DialectName = "sqlite" | "postgres";

export interface UsersTable {
  tg_id: number;
  first_name: string | null;
  username: string | null;
  lang: "en" | "ru";
  tz_offset_min: number | null;
  stream_mode: number;
  invited_with: string | null;
  created_at: number;
}

export interface InvitesTable {
  code: string;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  revoked: number;
  created_by: number;
  created_at: number;
}

export interface ThreadsTable {
  id: number;
  user_id: number;
  topic_id: number | null;
  parent_thread_id: number | null;
  fork_point_message_id: number | null;
  title: string;
  meta_summary: string | null;
  compacted_upto_message_id: number | null;
  archived: number;
  created_at: number;
}

export interface MessagesTable {
  id: number;
  thread_id: number;
  role: "user" | "assistant" | "system";
  kind: "text" | "image" | "file" | "system";
  content_json: string;
  text_plain: string;
  thinking: string | null;
  tg_message_id: number | null;
  tokens_est: number | null;
  created_at: number;
}

export interface FilesTable {
  id: number;
  user_id: number;
  thread_id: number;
  message_id: number | null;
  type: StoredFileType;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  content_sha256: string | null;
  name: string;
  path: string;
  size: number;
  content_md: string | null;
  summary: string | null;
  outline_json: string | null;
  is_inline: number;
  created_at: number;
}

export interface FileTelegramRefsTable {
  file_unique_id: string;
  file_id: number;
  telegram_file_id: string | null;
  created_at: number;
}

export interface FileChunksTable {
  id: number;
  file_id: number;
  idx: number;
  heading_path: string | null;
  content: string;
  created_at: number;
}

export interface MessageFilesTable {
  message_id: number;
  file_id: number;
  display_name: string | null;
  caption: string | null;
  created_at: number;
}

export interface SummariesTable {
  id: number;
  thread_id: number;
  level: number;
  from_message_id: number;
  to_message_id: number;
  content: string;
  created_at: number;
}

export interface EmbeddingsTable {
  id: number;
  kind: "message" | "chunk" | "summary";
  ref_id: number;
  model: string | null;
  dim: number;
  vector: Buffer;
  created_at: number;
}

export interface DB {
  users: UsersTable;
  invites: InvitesTable;
  threads: ThreadsTable;
  messages: MessagesTable;
  files: FilesTable;
  file_telegram_refs: FileTelegramRefsTable;
  message_files: MessageFilesTable;
  file_chunks: FileChunksTable;
  summaries: SummariesTable;
  embeddings: EmbeddingsTable;
}

export type UserRow = UsersTable;
export type InviteRow = InvitesTable;
export type ThreadRow = ThreadsTable;
export type MessageRow = MessagesTable;
export type FileRow = FilesTable;
export type FileTelegramRefRow = FileTelegramRefsTable;
export type MessageFileRow = MessageFilesTable;
export type FileChunkRow = FileChunksTable;
export type SummaryRow = SummariesTable;
export type EmbeddingRow = EmbeddingsTable;
