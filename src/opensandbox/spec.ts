import { createHash } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { OpenSandboxCreateSpec } from "./client.js";

export const SANDBOX_LAYOUT_VERSION = 1;
export const METADATA_MANAGED_BY = "ai_tg_bot_managed_by";
export const METADATA_DEPLOYMENT = "ai_tg_bot_deployment";
export const METADATA_USER_ID = "ai_tg_bot_user_id";
export const METADATA_FINGERPRINT = "ai_tg_bot_fingerprint";
export const METADATA_LAYOUT = "ai_tg_bot_layout";

export function managedSandboxMetadata(config: AppConfig): Record<string, string> {
  return {
    [METADATA_MANAGED_BY]: "ai-tg-bot",
    [METADATA_DEPLOYMENT]: config.OPEN_SANDBOX_DEPLOYMENT_ID,
  };
}

export function managedUserSandboxMetadata(
  config: AppConfig,
  userId: number,
): Record<string, string> {
  return {
    ...managedSandboxMetadata(config),
    [METADATA_USER_ID]: safeId(userId),
  };
}

export function userSandboxMetadata(
  config: AppConfig,
  userId: number,
  fingerprint = openSandboxProvisioningFingerprint(config),
): Record<string, string> {
  return {
    ...managedUserSandboxMetadata(config, userId),
    [METADATA_FINGERPRINT]: fingerprint,
    [METADATA_LAYOUT]: String(SANDBOX_LAYOUT_VERSION),
  };
}

export function openSandboxProvisioningFingerprint(config: AppConfig): string {
  const input = {
    layout: SANDBOX_LAYOUT_VERSION,
    image: config.OPEN_SANDBOX_IMAGE,
    cpu: config.OPEN_SANDBOX_CPU,
    memory: config.OPEN_SANDBOX_MEMORY,
    user: config.OPEN_SANDBOX_USER,
    group: config.OPEN_SANDBOX_GROUP,
    uid: config.OPEN_SANDBOX_UID,
    gid: config.OPEN_SANDBOX_GID,
    sharedHostRoot: path.resolve(config.OPEN_SANDBOX_SHARED_HOST_ROOT),
    guestMount: "/data",
    network: "public-internet-v1",
    security: "opensandbox-secure-access-v1",
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 12);
}

export function openSandboxCreateSpec(config: AppConfig, userId: number): OpenSandboxCreateSpec {
  return {
    image: config.OPEN_SANDBOX_IMAGE,
    metadata: userSandboxMetadata(config, userId),
    hostPath: path.join(path.resolve(config.OPEN_SANDBOX_SHARED_HOST_ROOT), "users", safeId(userId)),
    cpu: config.OPEN_SANDBOX_CPU,
    memory: config.OPEN_SANDBOX_MEMORY,
    readyTimeoutMs: config.OPEN_SANDBOX_READY_TIMEOUT_MS,
  };
}

function safeId(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid user id: ${value}`);
  return String(value);
}
