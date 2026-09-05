import type { StoredFileType } from "../db/types.js";

export interface CreatedFileAttachment {
  fileId: number;
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
