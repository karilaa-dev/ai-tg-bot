import path from "node:path";
import type { AppConfig } from "../config.js";

export const GENERATED_MEDIA_PUBLIC_URL_REQUIRED =
  "GENERATED_MEDIA_PUBLIC_BASE_URL is required to embed generated images in Telegram rich Markdown";

export function requireGeneratedMediaPublicBaseUrl(config: Pick<AppConfig, "GENERATED_MEDIA_PUBLIC_BASE_URL">): string {
  if (!config.GENERATED_MEDIA_PUBLIC_BASE_URL) {
    throw new Error(`${GENERATED_MEDIA_PUBLIC_URL_REQUIRED}. Serve ./data/files from a public HTTP(S) URL and set the URL prefix.`);
  }
  return config.GENERATED_MEDIA_PUBLIC_BASE_URL;
}

export function publicGeneratedMediaUrl(baseUrl: string, filePath: string): string {
  return new URL(encodeURIComponent(path.basename(filePath)), ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
