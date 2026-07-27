import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { SANDBOX_NETWORK_POLICY_VERSION } from "../../src/opensandbox/network.js";
import {
  managedSandboxMetadata,
  openSandboxCreateSpec,
  openSandboxProvisioningFingerprint,
  threadSandboxMetadata,
} from "../../src/opensandbox/spec.js";

describe("OpenSandbox provisioning spec", () => {
  it("fingerprints the public-internet-v3 network policy", () => {
    const config = loadTestConfig({ OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared" });

    expect(SANDBOX_NETWORK_POLICY_VERSION).toBe("public-internet-v3");
    expect(openSandboxProvisioningFingerprint(config)).toBe("866f2ba8c2b2");
  });

  it("builds stable deployment and per-thread metadata with scoped mounts", () => {
    const config = loadTestConfig({
      OPEN_SANDBOX_DEPLOYMENT_ID: "test-deployment",
      OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared",
    });
    const fingerprint = openSandboxProvisioningFingerprint(config);

    expect(managedSandboxMetadata(config)).toEqual({
      ai_tg_bot_managed_by: "ai-tg-bot",
      ai_tg_bot_deployment: "test-deployment",
    });
    expect(threadSandboxMetadata(config, 123, 456)).toMatchObject({
      ai_tg_bot_user_id: "123",
      ai_tg_bot_thread_id: "456",
      ai_tg_bot_fingerprint: fingerprint,
      ai_tg_bot_layout: "2",
    });
    expect(openSandboxCreateSpec(config, 123, 456)).toMatchObject({
      image: config.OPEN_SANDBOX_IMAGE,
      mounts: [
        {
          name: "thread-workspace",
          hostPath: path.join("/mnt/shared", "users", "123", "threads", "456", "workspace"),
          mountPath: "/data/threads/456/workspace",
          readOnly: false,
        },
        {
          name: "thread-attachments",
          hostPath: path.join("/mnt/shared", "users", "123", "threads", "456", "attachments"),
          mountPath: "/data/threads/456/attachments",
          readOnly: true,
        },
        {
          name: "shared-data",
          hostPath: path.join("/mnt/shared", "users", "123", "shared"),
          mountPath: "/data/shared",
          readOnly: false,
        },
      ],
      cpu: "2",
      memory: "512Mi",
      idleReleaseMs: 900_000,
    });
  });

  it("changes the fingerprint when provisioning or runner identity changes", () => {
    const base = loadTestConfig({ OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared" });
    const changed = [
      loadTestConfig({
        OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared",
        OPEN_SANDBOX_IMAGE: "ubuntu:24.04",
      }),
      loadTestConfig({
        OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared",
        OPEN_SANDBOX_USER: "runner",
      }),
      loadTestConfig({
        OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared",
        OPEN_SANDBOX_GROUP: "runners",
      }),
      loadTestConfig({
        OPEN_SANDBOX_SHARED_HOST_ROOT: "/mnt/shared",
        OPEN_SANDBOX_IDLE_RELEASE_MS: 1_200_000,
      }),
    ];

    for (const config of changed) {
      expect(openSandboxProvisioningFingerprint(base)).not.toBe(
        openSandboxProvisioningFingerprint(config),
      );
    }
  });
});
