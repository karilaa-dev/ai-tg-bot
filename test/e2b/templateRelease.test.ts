import { SandboxError, type BuildInfo } from "e2b";
import { describe, expect, it, vi } from "vitest";
import {
  E2BTemplateReleaseManager,
  type E2BTemplateReleaseDependencies,
} from "../../src/e2b/templateRelease.js";
import {
  E2BTemplateNotFoundError,
  createWithTemplateNotFoundError,
  isE2BNotFoundError,
} from "../../src/e2b/templateNotFound.js";
import {
  E2B_TOOLBOX_RELEASE_REF,
  E2B_TOOLBOX_RELEASE_TAG,
  parseManagedE2BTemplateRef,
} from "../../src/e2b/templateIdentity.js";
import { APP_VERSION } from "../../src/version.js";
import { deferred } from "../helpers/async.js";

describe("versioned E2B template identity", () => {
  it("derives the release tag from package.json", () => {
    expect(APP_VERSION).toBe("2.0.4");
    expect(E2B_TOOLBOX_RELEASE_TAG).toBe("v2.0.4");
    expect(E2B_TOOLBOX_RELEASE_REF).toBe("ai-tg-bot-tools:v2.0.4");
  });

  it("accepts only tagged references owned by this bot", () => {
    expect(parseManagedE2BTemplateRef("ai-tg-bot-tools:staging_2.0.0"))
      .toEqual({ tag: "staging_2.0.0", templateRef: "ai-tg-bot-tools:staging_2.0.0" });
    expect(parseManagedE2BTemplateRef("other-tools:v2.0.0")).toBeUndefined();
    expect(parseManagedE2BTemplateRef("ai-tg-bot-tools:")).toBeUndefined();
    expect(parseManagedE2BTemplateRef("ai-tg-bot-tools:bad/tag")).toBeUndefined();
  });
});

describe("manual E2B template release", () => {
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

  it("shares one release while concurrent callers prewarm the same tag", async () => {
    const gate = deferred<void>();
    const dependencies = fakeDependencies({ exists: false });
    dependencies.build.mockImplementation(async () => {
      await gate.promise;
      return buildInfo();
    });
    const manager = new E2BTemplateReleaseManager("e2b_test", undefined, dependencies);
    const first = manager.ensure(E2B_TOOLBOX_RELEASE_REF);
    const second = manager.ensure(E2B_TOOLBOX_RELEASE_REF);
    await vi.waitFor(() => expect(dependencies.build).toHaveBeenCalledTimes(1));
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "built" }),
      expect.objectContaining({ status: "built" }),
    ]);
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

});

describe("missing sandbox image failure", () => {
  it("fails once with a release instruction when the configured image is missing", async () => {
    const create = vi.fn().mockRejectedValue(new SandboxError("404: template not found"));

    await expect(createWithTemplateNotFoundError(E2B_TOOLBOX_RELEASE_REF, create))
      .rejects.toEqual(expect.objectContaining({
        name: "E2BTemplateNotFoundError",
        templateRef: E2B_TOOLBOX_RELEASE_REF,
        message: expect.stringContaining("npm run e2b:release"),
      }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(isE2BNotFoundError(new SandboxError("404: missing"))).toBe(true);
  });

  it("preserves authentication, rate-limit, network, and unrelated errors", async () => {
    const original = new Error("authentication failed");
    const create = vi.fn().mockRejectedValue(original);

    await expect(createWithTemplateNotFoundError(E2B_TOOLBOX_RELEASE_REF, create)).rejects.toBe(original);
    expect(create).toHaveBeenCalledTimes(1);
    expect(isE2BNotFoundError(new SandboxError("500: unavailable"))).toBe(false);
  });

  it("retains the SDK failure as the missing-image error cause", () => {
    const cause = new SandboxError("404: template not found");
    expect(new E2BTemplateNotFoundError(E2B_TOOLBOX_RELEASE_REF, cause).cause).toBe(cause);
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
    tags: ["v2.0.4"],
    templateId: "template-id",
    buildId: "build-id",
  };
}
