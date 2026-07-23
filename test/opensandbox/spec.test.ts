import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import {
  managedSandboxMetadata,
  openSandboxCreateSpec,
  openSandboxProvisioningFingerprint,
  userSandboxMetadata,
} from "../../src/opensandbox/spec.js";

describe("OpenSandbox provisioning spec", () => {
  it("builds stable deployment and per-user metadata", () => {
    const config = loadTestConfig({
      OPEN_SANDBOX_DEPLOYMENT_ID: "test-deployment",
      OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared",
    });
    const fingerprint = openSandboxProvisioningFingerprint(config);

    expect(managedSandboxMetadata(config)).toEqual({
      ai_tg_bot_managed_by: "ai-tg-bot",
      ai_tg_bot_deployment: "test-deployment",
    });
    expect(userSandboxMetadata(config, 123)).toMatchObject({
      ai_tg_bot_user_id: "123",
      ai_tg_bot_fingerprint: fingerprint,
      ai_tg_bot_layout: "1",
    });
    expect(openSandboxCreateSpec(config, 123)).toMatchObject({
      image: config.OPEN_SANDBOX_IMAGE,
      hostPath: path.join("/mnt/shared", "users", "123"),
      cpu: "2",
      memory: "512Mi",
    });
  });

  it("changes the fingerprint when provisioning changes", () => {
    const base = loadTestConfig({ OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared" });
    expect(openSandboxProvisioningFingerprint(base)).not.toBe(
      openSandboxProvisioningFingerprint(loadTestConfig({
        OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared",
        OPEN_SANDBOX_IMAGE: "ubuntu:24.04",
      })),
    );
  });
});
