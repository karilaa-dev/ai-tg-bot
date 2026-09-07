export type StoredFileType = "txt" | "csv" | "pdf" | "docx" | "image" | "audio" | "other";

export type DialectName = "sqlite" | "postgres";

export type Locale = "en" | "ru";

export type MessageRole = "user" | "assistant" | "system";

export type MessageKind = "text" | "image" | "file" | "system";

export type TurnRunStatus =
  | "queued"
  | "running"
  | "awaiting_delivery"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TurnDeliveryStatus = "pending" | "delivered" | "unknown" | "failed";

export type ThreadTitleSource = "placeholder" | "explicit" | "generated";

interface UsersTable {
  tg_id: number;
  first_name: string | null;
  username: string | null;
  lang: Locale;
  tz_offset_min: number | null;
  stream_mode: number;
  created_at: number;
}

interface ThreadsTable {
  id: number;
  user_id: number;
  topic_id: number | null;
  parent_thread_id: number | null;
  fork_point_message_id: number | null;
  title: string;
  title_source: ThreadTitleSource;
  title_attempts: number;
  topic_title_synced: number;
  pi_session_file: string | null;
  pi_session_id: string | null;
  archived: number;
  created_at: number;
}

interface MessagesTable {
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

interface TurnRunsTable {
  id: number;
  user_id: number;
  thread_id: number;
  user_message_id: number;
  chat_id: number;
  message_thread_id: number | null;
  locale: Locale;
  status: TurnRunStatus;
  delivery_status: TurnDeliveryStatus;
  result_message_id: number | null;
  provider: string | null;
  model: string | null;
  usage_json: string | null;
  failure_code: string | null;
  owner_id: string | null;
  lease_expires_at: number | null;
  cancel_requested_at: number | null;
  accepted_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

interface FilesTable {
  id: number;
  user_id: number;
  thread_id: number;
  message_id: number | null;
  type: StoredFileType;
  content_sha256: string | null;
  mime_type: string | null;
  extraction_status: "pending" | "ready" | "failed" | "source_only";
  name: string;
  size: number;
  content_md: string | null;
  summary: string | null;
  outline_json: string | null;
  is_inline: number;
  created_at: number;
}

interface ThreadSandboxesTable {
  deployment_id: string;
  user_id: number;
  thread_id: number;
  sandbox_id: string;
  created_at: number;
  updated_at: number;
}

interface BrowserUseProfilesTable {
  deployment_id: string;
  user_id: number;
  provider_user_key: string;
  profile_id: string | null;
  created_at: number;
  updated_at: number;
}

interface FileSourcesTable {
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

interface TelegramFileRefsTable {
  id: number;
  file_id: number;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  direction: "inbound" | "outbound";
  media_kind: "document" | "photo" | "voice" | "audio";
  telegram_message_id: number | null;
  width: number | null;
  height: number | null;
  telegram_size: number | null;
  is_primary: number;
  first_seen_at: number;
  last_seen_at: number;
}

interface SandboxFileRestoreStatusTable {
  deployment_id: string;
  thread_id: number;
  sandbox_id: string;
  file_id: number;
  telegram_file_ref_id: number | null;
  sandbox_name: string;
  status: "available" | "error";
  restored_size: number | null;
  restored_sha256: string | null;
  error_code: string | null;
  error_detail: string | null;
  attempted_at: number;
  completed_at: number | null;
}

interface FileChunksTable {
  id: number;
  file_id: number;
  idx: number;
  heading_path: string | null;
  content: string;
  created_at: number;
}

export type UserRow = UsersTable;
export type ThreadRow = ThreadsTable;
export type MessageRow = MessagesTable;
export type TurnRunRow = TurnRunsTable;
export type FileRow = FilesTable;
export type ThreadSandboxRow = ThreadSandboxesTable;
export type BrowserUseProfileRow = BrowserUseProfilesTable;
export type FileSourceRow = FileSourcesTable;
export type TelegramFileRefRow = TelegramFileRefsTable;
export type SandboxFileRestoreStatusRow = SandboxFileRestoreStatusTable;
export type FileChunkRow = FileChunksTable;
