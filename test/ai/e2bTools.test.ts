import { describe, expect, it, vi } from "vitest";
import { appendPublishedWebsiteNotice } from "../../src/ai/agentTurnEngine.js";
import { createPublishWebsiteTool } from "../../src/ai/tools/publishWebsite.js";
import { loadTestConfig } from "../../src/config.js";

describe("E2B-backed agent tools", () => {
  it("publishes through the explicit tool and registers the final-answer notice", async () => {
    const published = {
      sandboxId: "sandbox-1",
      port: 3000,
      siteDirectory: "/home/user/workspace/site",
      path: "/",
      url: "https://3000-sandbox-1.e2b.app/",
      pausesAfterMinutes: 15,
    };
    const runtime = { publishWebsite: vi.fn(async () => published) };
    const register = vi.fn();
    const tool = createPublishWebsiteTool({
      config: loadTestConfig(),
      user: { tg_id: 9, lang: "en" },
      thread: { id: 10 },
      commandRuntime: runtime,
      registerPublishedWebsite: register,
    } as never);

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
