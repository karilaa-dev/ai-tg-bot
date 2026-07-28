import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/browserless/client.js", () => ({
  renderOfficeHtml: vi.fn(),
  checkBrowserless: vi.fn(),
}));

import { renderOfficeHtml } from "../../src/browserless/client.js";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";
import type {
  CommandRuntime,
  SandboxCommandLifecycle,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxFileExportRequest,
} from "../../src/sandbox/types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("render_office_preview Pi adapter", () => {
  let db: AppDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await db?.destroy();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns a model-visible image without retaining base64 or creating a Telegram attachment", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-office-preview-"));
    const config = loadTestConfig({
      AGENT_SHARED_ROOT: path.join(tempDir, "agent"),
      MANAGED_FILE_ROOT: path.join(tempDir, "agent", ".chat-files"),
      BROWSERLESS_URL: "ws://browserless:3000/chromium/playwright",
      BROWSERLESS_ALLOWED_ORIGINS: ["ws://browserless:3000"],
    });
    db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9910, firstName: "Preview", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Preview" });
    const runtime = new HtmlExportRuntime("<!doctype html><html><body>slide</body></html>");
    vi.mocked(renderOfficeHtml).mockResolvedValue({ bytes: PNG, mediaType: "image/png" });
    const createdFiles: never[] = [];
    const tools = createPiToolAdapters({
      buildInput: () => ({
        config,
        db: db!,
        repos,
        user,
        thread,
        commandRuntime: runtime,
        createdFiles,
      }),
    });
    const render = tools.find((tool) => tool.name === "render_office_preview")!;

    const result = await render.execute(
      "preview-call",
      { path: "/slide-1.html" },
      undefined,
      undefined,
      {} as never,
    );

    expect(render.executionMode).toBe("sequential");
    expect(render.promptSnippet).toContain("Browserless is not accessible from bash");
    expect(vi.mocked(renderOfficeHtml)).toHaveBeenCalledWith(
      config,
      "<!doctype html><html><body>slide</body></html>",
      undefined,
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Rendered Office preview /slide-1.html (image/png, 9 bytes).",
      },
      {
        type: "image",
        data: PNG.toString("base64"),
        mimeType: "image/png",
      },
    ]);
    expect(result.details).toEqual({
      rendered: true,
      path: "/slide-1.html",
      media_type: "image/png",
      size: PNG.length,
    });
    expect(result.details).not.toHaveProperty("image_base64");
    expect(createdFiles).toHaveLength(0);
  });

  it("rejects non-HTML paths before exporting them", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-office-preview-invalid-"));
    const config = loadTestConfig({
      AGENT_SHARED_ROOT: path.join(tempDir, "agent"),
      MANAGED_FILE_ROOT: path.join(tempDir, "agent", ".chat-files"),
      BROWSERLESS_URL: "ws://browserless:3000/chromium/playwright",
      BROWSERLESS_ALLOWED_ORIGINS: ["ws://browserless:3000"],
    });
    db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 9911, firstName: "Preview", lang: "en" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Preview" });
    const runtime = new HtmlExportRuntime("not used");
    const render = createPiToolAdapters({
      buildInput: () => ({ config, db: db!, repos, user, thread, commandRuntime: runtime }),
    }).find((tool) => tool.name === "render_office_preview")!;

    const result = await render.execute(
      "preview-invalid",
      { path: "/slide-1.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toEqual({ error: "Error: Office preview path must end in .html or .htm." });
    expect(runtime.exports).toBe(0);
    expect(renderOfficeHtml).not.toHaveBeenCalled();
  });
});

class HtmlExportRuntime implements CommandRuntime {
  exports = 0;

  constructor(private readonly html: string) {}

  async exportFile(request: SandboxFileExportRequest): Promise<void> {
    this.exports += 1;
    await fs.writeFile(request.hostDestination, this.html);
  }

  async execute(
    _request: SandboxCommandRequest,
    _lifecycle?: SandboxCommandLifecycle,
  ): Promise<SandboxCommandResult> {
    throw new Error("not used");
  }

  async reconcile(): Promise<void> {}
  async dispose(): Promise<void> {}
}
