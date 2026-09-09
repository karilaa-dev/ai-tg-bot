import type { WebAttachment } from "./types.js";

export const imageMimeTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const audioMimeTypes = ["audio/ogg", "audio/opus", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/flac", "audio/x-flac", "audio/aac", "audio/webm"];

export function isAudioMime(mime: string): boolean {
  return audioMimeTypes.includes(mime.split(";")[0]!.trim().toLowerCase());
}

export function attachmentKind(file: WebAttachment): "image" | "audio" | "file" {
  if (file.kind === "image" || file.kind === "audio") return file.kind;
  const mime = file.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (imageMimeTypes.includes(mime)) return "image";
  if (isAudioMime(mime) || mime === "application/ogg") return "audio";
  if (!mime || mime === "application/octet-stream") {
    if (/\.(png|jpe?g|gif|webp|avif)$/i.test(file.name)) return "image";
    if (/\.(ogg|oga|opus|mp3|m4a|wav|flac|aac|webm)$/i.test(file.name)) return "audio";
  }
  return "file";
}
