import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";

type SessionConfig = Pick<AppConfig, "CAMOFOX_DEPLOYMENT_ID">;

export function interactiveCamofoxUserId(
  config: SessionConfig,
  telegramUserId: number,
  threadId: number,
): string {
  return scopedCamofoxUserId(config, telegramUserId, threadId, "interactive");
}

export function disposableCamofoxUserId(
  config: SessionConfig,
  telegramUserId: number,
  threadId: number,
  purpose: "extract" | "office-preview" | "live-check",
): string {
  return scopedCamofoxUserId(config, telegramUserId, threadId, purpose, randomUUID());
}

export function scopedCamofoxUserId(
  config: SessionConfig,
  telegramUserId: number,
  threadId: number,
  scope: string,
  nonce = "",
): string {
  const digest = createHash("sha256")
    .update([config.CAMOFOX_DEPLOYMENT_ID, telegramUserId, threadId, scope, nonce].join("\0"))
    .digest("hex")
    .slice(0, 40);
  return `ai-tg-bot-${digest}`;
}
