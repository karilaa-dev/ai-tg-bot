export type StoredFileType = "txt" | "csv" | "pdf" | "docx" | "image" | "other";

export type DialectName = "sqlite" | "postgres";

export type Locale = "en" | "ru";

export type MessageRole = "user" | "assistant" | "system";

export type MessageKind = "text" | "image" | "file" | "system";

export interface UsersTable {
  tg_id: number;
  first_name: string | null;
  username: string | null;
  lang: Locale;
  tz_offset_min: number | null;
  stream_mode: number;
  created_at: number;
}

export interface ThreadsTable {
  id: number;
  user_id: number;
  topic_id: number | null;
  parent_thread_id: number | null;
  fork_point_message_id: number | null;
  title: string;
  pi_session_file: string | null;
  pi_session_id: string | null;
  archived: number;
  created_at: number;
}

export interface MessagesTable {
  id: number;
  thread_id: number;
  role: MessageRole;
  kind: MessageKind;
  content_json: string;
  text_plain: string;
  thinking: string | null;
  tg_message_id: number | null;
  pi_entry_id: string | null;
  created_at: number;
}

export interface FilesTable {
  id: number;
  user_id: number;
  thread_id: number;
  message_id: number | null;
  type: StoredFileType;
  content_sha256: string | null;
  mime_type: string | null;
  extraction_status: "pending" | "ready" | "failed";
  name: string;
  path: string | null;
  size: number;
  content_md: string | null;
  summary: string | null;
  outline_json: string | null;
  is_inline: number;
  created_at: number;
}

export interface FileSourcesTable {
  id: number;
  file_id: number;
  transport: string;
  connection_key: string;
  remote_key: string;
  locator_json: string;
  mime_type: string | null;
  last_verified_at: number | null;
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

export interface EmbeddingsTable {
  id: number;
  kind: "chunk";
  ref_id: number;
  model: string | null;
  dim: number;
  vector: Buffer;
  created_at: number;
}

export type UserRow = UsersTable;
export type ThreadRow = ThreadsTable;
export type MessageRow = MessagesTable;
export type FileRow = FilesTable;
export type FileSourceRow = FileSourcesTable;
export type FileChunkRow = FileChunksTable;
export type EmbeddingRow = EmbeddingsTable;
