import { SandboxError, type BuildInfo } from "e2b";
import { describe, expect, it, vi } from "vitest";
import {
  E2BTemplateReleaseManager,
  createWithMissingTemplateRecovery,
  isE2BNotFoundError,
  type E2BTemplateReleaseDependencies,
} from "../../src/e2b/templateRelease.js";
import {
  E2B_TOOLBOX_RELEASE_REF,
  E2B_TOOLBOX_RELEASE_TAG,
  parseManagedE2BTemplateRef,
} from "../../src/e2b/templateIdentity.js";
import { APP_VERSION } from "../../src/version.js";
import { deferred } from "../helpers/async.js";

describe("versioned E2B template identity", () => {
  it("derives the release tag from package.json", () => {
    expect(APP_VERSION).toBe("2.0.0");
    expect(E2B_TOOLBOX_RELEASE_TAG).toBe("v2.0.0");
    expect(E2B_TOOLBOX_RELEASE_REF).toBe("ai-tg-bot-tools:v2.0.0");
  });

  it("accepts only tagged references owned by this bot", () => {
    expect(parseManagedE2BTemplateRef("ai-tg-bot-tools:staging_2.0.0"))
      .toEqual({ tag: "staging_2.0.0", templateRef: "ai-tg-bot-tools:staging_2.0.0" });
    expect(parseManagedE2BTemplateRef("other-tools:v2.0.0")).toBeUndefined();
    expect(parseManagedE2BTemplateRef("ai-tg-bot-tools:")).toBeUndefined();
    expect(parseManagedE2BTemplateRef("ai-tg-bot-tools:bad/tag")).toBeUndefined();
  });
});

describe("automatic E2B template release", () => {
  it("builds and validates a missing managed tag", async () => {
    const dependencies = fakeDependencies({ exists: false });
    const manager = new E2BTemplateReleaseManager("e2b_test", undefined, dependencies);

    await expect(manager.ensure("ai-tg-bot-tools:custom-v2"))
      .resolves.toMatchObject({ templateRef: "ai-tg-bot-tools:custom-v2", status: "built" });
    expect(dependencies.exists).toHaveBeenCalledTimes(1);
    expect(dependencies.build).toHaveBeenCalledWith("ai-tg-bot-tools:custom-v2", "e2b_test");
    expect(dependencies.validate).toHaveBeenCalledWith("ai-tg-bot-tools:custom-v2", "e2b_test");
  });

  it("reuses and validates an existing tag", async () => {
    const dependencies = fakeDependencies({ exists: true });
    const manager = new E2BTemplateReleaseManager("e2b_test", undefined, dependencies);

    await expect(manager.ensure(E2B_TOOLBOX_RELEASE_REF))
      .resolves.toEqual({ templateRef: E2B_TOOLBOX_RELEASE_REF, status: "reused" });
    expect(dependencies.build).not.toHaveBeenCalled();
    expect(dependencies.validate).toHaveBeenCalledTimes(1);
  });

  it("shares one release while concurrent sandbox creations recover", async () => {
    const gate = deferred<void>();
    const dependencies = fakeDependencies({ exists: false });
    dependencies.build.mockImplementation(async () => {
      await gate.promise;
      return buildInfo();
    });
    const manager = new E2BTemplateReleaseManager("e2b_test", undefined, dependencies);
    const missing = new SandboxError("404: template not found");

    const first = manager.recoverMissingTemplate(E2B_TOOLBOX_RELEASE_REF, missing);
    const second = manager.recoverMissingTemplate(E2B_TOOLBOX_RELEASE_REF, missing);
    await vi.waitFor(() => expect(dependencies.build).toHaveBeenCalledTimes(1));
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(dependencies.exists).toHaveBeenCalledTimes(1);
    expect(dependencies.validate).toHaveBeenCalledTimes(1);
  });

  it("reuses a tag created by another process after a build race", async () => {
    const dependencies = fakeDependencies({ exists: false });
    dependencies.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    dependencies.build.mockRejectedValueOnce(new Error("tag was assigned concurrently"));
    const manager = new E2BTemplateReleaseManager("e2b_test", undefined, dependencies);

    await expect(manager.ensure(E2B_TOOLBOX_RELEASE_REF))
      .resolves.toEqual({ templateRef: E2B_TOOLBOX_RELEASE_REF, status: "reused" });
    expect(dependencies.validate).toHaveBeenCalledTimes(1);
  });

  it("surfaces build failures when the tag remains missing", async () => {
    const dependencies = fakeDependencies({ exists: false });
    dependencies.build.mockRejectedValueOnce(new Error("build failed"));
    const manager = new E2BTemplateReleaseManager("e2b_test", undefined, dependencies);

    await expect(manager.ensure(E2B_TOOLBOX_RELEASE_REF)).rejects.toThrow("build failed");
    expect(dependencies.exists).toHaveBeenCalledTimes(2);
    expect(dependencies.validate).not.toHaveBeenCalled();
  });

  it("recovers only SDK 404 errors for managed tags", async () => {
    const dependencies = fakeDependencies({ exists: true });
    const manager = new E2BTemplateReleaseManager("e2b_test", undefined, dependencies);

    await expect(manager.recoverMissingTemplate(E2B_TOOLBOX_RELEASE_REF, new Error("404 from proxy")))
      .resolves.toBe(false);
    await expect(manager.recoverMissingTemplate(E2B_TOOLBOX_RELEASE_REF, new SandboxError("500: unavailable")))
      .resolves.toBe(false);
    await expect(manager.recoverMissingTemplate("foreign:v2.0.0", new SandboxError("404: missing")))
      .resolves.toBe(false);
    expect(dependencies.exists).not.toHaveBeenCalled();
    expect(isE2BNotFoundError(new SandboxError("404: missing"))).toBe(true);
  });
});

describe("sandbox creation retry", () => {
  it("retries once after successful missing-template recovery", async () => {
    const created = { id: "sandbox" };
    const create = vi.fn()
      .mockRejectedValueOnce(new SandboxError("404: missing"))
      .mockResolvedValueOnce(created);
    const recover = vi.fn().mockResolvedValue(true);

    await expect(createWithMissingTemplateRecovery(create, recover)).resolves.toBe(created);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not loop when the retry fails", async () => {
    const retryError = new Error("retry failed");
    const create = vi.fn()
      .mockRejectedValueOnce(new SandboxError("404: missing"))
      .mockRejectedValueOnce(retryError);

    await expect(createWithMissingTemplateRecovery(create, async () => true)).rejects.toBe(retryError);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("preserves the original error when recovery declines it", async () => {
    const original = new Error("authentication failed");
    const create = vi.fn().mockRejectedValue(original);

    await expect(createWithMissingTemplateRecovery(create, async () => false)).rejects.toBe(original);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

function fakeDependencies(input: { exists: boolean }) {
  return {
    exists: vi.fn().mockResolvedValue(input.exists),
    build: vi.fn().mockResolvedValue(buildInfo()),
    validate: vi.fn().mockResolvedValue(undefined),
  } satisfies E2BTemplateReleaseDependencies;
}

function buildInfo(): BuildInfo {
  return {
    alias: "ai-tg-bot-tools",
    name: "ai-tg-bot-tools",
    tags: ["v2.0.0"],
    templateId: "template-id",
    buildId: "build-id",
  };
}
