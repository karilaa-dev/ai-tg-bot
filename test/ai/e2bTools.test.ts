import { describe, expect, it, vi } from "vitest";
import { appendPublishedWebsiteNotice } from "../../src/ai/run.js";
import { createBashTool } from "../../src/ai/tools/bash.js";
import { createCreateFileTool } from "../../src/ai/tools/createFile.js";
import { createPublishWebsiteTool } from "../../src/ai/tools/publishWebsite.js";
import { loadTestConfig } from "../../src/config.js";
import type { CommandRuntime, SandboxCommandResult } from "../../src/sandbox/types.js";

describe("E2B-backed agent tools", () => {
  it("tells the model how to detach long-lived background processes", () => {
    const description = createBashTool(buildInput(fakeRuntime())).description;

    expect(description).toContain("nohup command </dev/null >server.log 2>&1 &");
    expect(description).toContain("inherited output pipes");
  });

  it("holds sandbox activity while exporting a created file", () => {
    expect(createCreateFileTool(buildInput(fakeRuntime())).holdsCommandActivity).toBe(true);
  });

  it("publishes through the explicit tool and registers the final-answer notice", async () => {
    const published = {
      sandboxId: "sandbox-1",
      port: 3000,
      siteDirectory: "/home/user/workspace/site",
      path: "/",
      url: "https://3000-sandbox-1.e2b.app/",
      pausesAfterMinutes: 15,
    };
    const runtime = fakeRuntime();
    runtime.publishWebsite = vi.fn(async () => published);
    const register = vi.fn();
    const tool = createPublishWebsiteTool(buildInput(runtime, register));

    expect(tool.description).toContain("nohup command </dev/null >server.log 2>&1 &");
    expect(tool.description).toContain("dedicated workspace subdirectory");
    expect(tool.description).toContain("public and unauthenticated");
    expect(tool.description).toContain("never add private attachments");

    const result = await tool.execute({ port: 3000, site_dir: "/site", path: "/" });

    expect(result).toEqual({
      published: true,
      url: published.url,
      port: 3000,
      site_directory: "/home/user/workspace/site",
      path: "/",
      public: true,
      authentication: "none",
      pauses_after_minutes: 15,
    });
    expect(runtime.publishWebsite).toHaveBeenCalledWith(expect.objectContaining({
      siteDirectory: "/site",
    }));
    expect(register).toHaveBeenCalledWith(published);
    expect(appendPublishedWebsiteNotice("Done.", [published.url], "en"))
      .toContain("remain active for 15 minutes after this response");
    expect(appendPublishedWebsiteNotice("Готово.", [published.url], "ru"))
      .toContain("останется активной 15 минут");
  });

});

function buildInput(runtime: CommandRuntime, registerPublishedWebsite?: (website: never) => void) {
  return {
    config: loadTestConfig(),
    repos: {
      threads: { chain: async (thread: unknown) => [thread] },
      messages: { listForThreadChainSearchScope: async () => [] },
      files: {
        listForMessages: async () => [],
        listForThreads: async () => [],
        listByIds: async () => [],
        listTelegramFileRefs: async () => [],
      },
    },
    user: { tg_id: 9, lang: "en" },
    thread: { id: 10 },
    commandRuntime: runtime,
    resolveFile: async () => { throw new Error("not used"); },
    registerPublishedWebsite,
  } as never;
}

function fakeRuntime(): CommandRuntime {
  return {
    execute: async () => commandResult(),
    readWorkspaceFile: async () => {
      throw new Error("not used");
    },
    readSourceFile: async () => {
      throw new Error("not used");
    },
    publishWebsite: async () => {
      throw new Error("not used");
    },
    dispose: async () => undefined,
  };
}

function commandResult(overrides: Partial<SandboxCommandResult> = {}): SandboxCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    threadFiles: { directory: "/home/user/telegram-files", available: 0 },
    ...overrides,
  };
}
