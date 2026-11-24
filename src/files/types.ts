import type { FileRow, StoredFileType } from "../db/types.js";

export interface CreatedFileAttachment {
  fileId: FileRow["id"];
  sourceVirtualPath?: string;
  type: StoredFileType;
  name: string;
  mimeType?: string | null;
  data?: Buffer;
  size: number;
  caption?: string | null;
  inline: boolean;
  card: string;
  delivery?: "document" | "photo";
  photoFallback?: "document" | "none";
  origin?: "created_file" | "generated_image";
  telegramDeliveryUnknown?: boolean;
  telegramDeliveryFailure?: "source_unavailable" | "telegram_rejected";
  telegramDelivery?: {
    messageId: number;
    fileId: string | null;
    fileUniqueId: string | null;
    refs?: Array<{
      fileId: string;
      fileUniqueId: string | null;
      width: number | null;
      height: number | null;
      size: number | null;
      primary: boolean;
    }>;
  };
}

export type CreatedFileDeliveryPreference = "auto" | "photo" | "photo_only" | "document";

// A source recovery failure can be recorded even after Telegram acknowledged a send.
// The receipt always wins when deciding whether another send could duplicate a file.
type TelegramAttachmentReceipt = NonNullable<CreatedFileAttachment["telegramDelivery"]>;
type TelegramAttachmentDelivery =
  | { phase: "pending" | "unknown" | "rejected" | "source_unavailable" }
  | { phase: "confirmed"; receipt: TelegramAttachmentReceipt };

export function telegramAttachmentDelivery(file: CreatedFileAttachment): TelegramAttachmentDelivery {
  if (file.telegramDelivery) return { phase: "confirmed", receipt: file.telegramDelivery };
  if (file.telegramDeliveryUnknown) return { phase: "unknown" };
  if (file.telegramDeliveryFailure === "source_unavailable") return { phase: "source_unavailable" };
  if (file.telegramDeliveryFailure === "telegram_rejected") return { phase: "rejected" };
  return { phase: "pending" };
}

export function attachmentMayHaveBeenSent(file: CreatedFileAttachment): boolean {
  const { phase } = telegramAttachmentDelivery(file);
  return phase === "confirmed" || phase === "unknown";
}

/** Only a definite rejection permits another attempt after a send. */
export function canSendTelegramAttachment(file: CreatedFileAttachment): boolean {
  const { phase } = telegramAttachmentDelivery(file);
  return phase === "pending" || phase === "rejected";
}

export function recordTelegramAttachmentSend(
  file: CreatedFileAttachment,
  outcome: { phase: "confirmed"; receipt: TelegramAttachmentReceipt } | { phase: "rejected" | "unknown" },
): void {
  if (!canSendTelegramAttachment(file)) return;
  if (outcome.phase === "confirmed") file.telegramDelivery = outcome.receipt;
  if (outcome.phase === "unknown") file.telegramDeliveryUnknown = true;
  file.telegramDeliveryFailure = outcome.phase === "rejected" ? "telegram_rejected" : undefined;
}
