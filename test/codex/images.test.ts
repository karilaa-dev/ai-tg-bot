import type { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import { ThreadBridge } from "../../src/codex/threadBridge.js";
import { createGenerateImageTool } from "../../src/codex/images.js";
import { dynamicToolSpecs, executeBotTool } from "../../src/codex/tools.js";
import { workspaceRuntime, TEST_PNG } from "../helpers/workspaceRuntime.js";

const databases: AppDatabase[] = [];
const bridges: ThreadBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.endTurn();
  for (const db of databases.splice(0)) await db.destroy();
  vi.unstubAllGlobals();
});

async function setup() {
  const config = loadTestConfig({ OPENROUTER_IMAGE_MODEL: "fixture/image", IMAGE_TIMEOUT_MS: 1000 });
  const db = createDatabase(config); databases.push(db); await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 901, firstName: "Images" });
  const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Images" });
  const commandRuntime = workspaceRuntime();
  const bridge = new ThreadBridge({ config, db, repos, user, thread, commandRuntime, logger: createLogger(config) });
  bridges.push(bridge);
  await bridge.beginTurn({ api: {} as Api, chatId: user.tg_id, resolveFile: async () => ({ bytes: TEST_PNG, mimeType: "image/png", size: TEST_PNG.length, contentSha256: "fixture", source: { transport: "telegram", connectionKey: "default", remoteKey: "fixture", locator: {} } }) });
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ data: [{ b64_json: TEST_PNG.toString("base64"), media_type: "image/png", revised_prompt: "Revised fixture" }] }));
  vi.stubGlobal("fetch", fetchMock);
  return { config, repos, user, thread, commandRuntime, bridge, fetchMock, tool: createGenerateImageTool(bridge) };
}

describe("OpenRouter fallback image generation", () => {
  it("is declared only for fallback and automatically prepares Telegram files before workspace use", async () => {
    const input = await setup();
    expect(dynamicToolSpecs(input.bridge).some(tool => tool.name === "generate_image")).toBe(false);
    expect(dynamicToolSpecs(input.bridge, true).some(tool => tool.name === "generate_image")).toBe(true);
    const result = await executeBotTool(input.bridge, "generate_image", { prompt: "A blue circle" }, "image");
    expect(result.isError).toBe(false);
    expect(input.commandRuntime.materializeFiles).toHaveBeenCalledTimes(1);
    expect(result.content.some(part => part.type === "image")).toBe(true);
    expect(input.bridge.attachments).toHaveLength(0);
  });

  it("saves original bytes, returns model vision without caching bytes in tool details, and edits saved assets", async () => {
    const input = await setup();
    const first = await input.tool.execute({ prompt: "A blue circle" });
    const edited = await input.tool.execute({ prompt: "Make it green", mode: "edit", reference_paths: [first.path] });
    expect(first).toMatchObject({ generated_image: true, provider: "openrouter", model: "fixture/image", width: 1, height: 1, revised_prompt: "Revised fixture" });
    expect(input.commandRuntime.writeWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ virtualPath: expect.stringMatching(/^\/assets\/generated-.*\.png$/), bytes: TEST_PNG }));
    const secondBody = JSON.parse(String(input.fetchMock.mock.calls[1]![1]?.body));
    expect(secondBody).toMatchObject({ model: "fixture/image", n: 1, output_format: "png", input_references: [{ type: "image_url", image_url: { url: `data:image/png;base64,${TEST_PNG.toString("base64")}` } }] });
    expect(input.fetchMock.mock.calls.map(call => call[0])).toEqual(["https://openrouter.ai/api/v1/images", "https://openrouter.ai/api/v1/images"]);
    const output = await input.tool.toModelOutput!({ toolCallId: "edit", input: { prompt: "edit" }, output: edited });
    expect(output).toMatchObject({ type: "content", value: expect.arrayContaining([expect.objectContaining({ type: "image-data" })]) });
    const details = await input.tool.toToolDetails!({ toolCallId: "edit", input: { prompt: "edit" }, output: edited });
    expect(JSON.stringify(details)).not.toContain(TEST_PNG.toString("base64"));
    expect(input.bridge.attachments).toHaveLength(0);
  });

  it("resolves scoped Telegram references and blocks images from unrelated chats before inference", async () => {
    const input = await setup();
    const reference = await input.repos.files.insertFile({ userId: input.user.tg_id, threadId: input.thread.id, type: "image", name: "reference.png", size: TEST_PNG.length, isInline: false });
    await input.repos.files.rememberSource(reference.id, { transport: "telegram", connectionKey: "default", remoteKey: "reference", locator: { file_id: "reference" }, mimeType: "image/png" });
    await input.bridge.beginTurn({ api: {} as Api, chatId: input.user.tg_id, currentFileIds: [reference.id], resolveFile: async file => {
      expect(file.id).toBe(reference.id);
      return { bytes: TEST_PNG, mimeType: "image/png", size: TEST_PNG.length, contentSha256: "fixture", source: { transport: "telegram", connectionKey: "default", remoteKey: "reference", locator: {} } };
    } });
    await input.tool.execute({ prompt: "Edit Telegram image", mode: "edit", reference_file_ids: [reference.id] });
    const body = JSON.parse(String(input.fetchMock.mock.calls[0]![1]?.body));
    expect(body.input_references[0].image_url.url).toBe(`data:image/png;base64,${TEST_PNG.toString("base64")}`);
    const other = await input.repos.threads.create({ userId: input.user.tg_id, topicId: null, title: "Unrelated" });
    const privateFile = await input.repos.files.insertFile({ userId: input.user.tg_id, threadId: other.id, type: "image", name: "private.png", size: TEST_PNG.length, isInline: false });
    await expect(input.tool.execute({ prompt: "Edit private image", reference_file_ids: [privateFile.id] })).rejects.toThrow("not available in this thread");
    expect(input.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks combined limits and sandbox inspection before inference", async () => {
    const input = await setup();
    await expect(input.tool.execute({ prompt: "Draw", reference_file_ids: [1, 2, 3], reference_paths: ["/a.png", "/b.png", "/c.png"] })).rejects.toThrow("At most 5");
    await expect(input.tool.execute({ prompt: "Edit", mode: "edit" })).rejects.toThrow("requires at least one");
    input.commandRuntime.execute.mockResolvedValueOnce({ stdout: "", stderr: "MISSING:magick", exitCode: 127, timedOut: false, stdoutTruncated: false, stderrTruncated: false, threadFiles: { directory: "", available: 0, files: [] } });
    await expect(input.tool.execute({ prompt: "Draw" })).rejects.toThrow("Generation was not started");
    expect(input.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects provider failures and invalid image content without writing or queuing attachments", async () => {
    const input = await setup();
    input.fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "Image model unavailable" } }, { status: 503 }));
    await expect(input.tool.execute({ prompt: "Draw" })).rejects.toThrow("OpenRouter image request failed (503): Image model unavailable");
    input.fetchMock.mockResolvedValueOnce(Response.json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }));
    await expect(input.tool.execute({ prompt: "Draw" })).rejects.toThrow("unsupported image");
    expect(input.commandRuntime.writeWorkspaceFile).not.toHaveBeenCalled();
    expect(input.bridge.attachments).toHaveLength(0);
  });

  it("honors cancellation before inference and while a provider ignores its abort signal", async () => {
    const input = await setup();
    const stopped = new AbortController(); stopped.abort(new Error("Cancelled before request"));
    await expect(input.tool.execute({ prompt: "Draw" }, stopped.signal)).rejects.toThrow("Cancelled before request");
    expect(input.fetchMock).not.toHaveBeenCalled();
    input.fetchMock.mockImplementationOnce(async () => new Promise<Response>(() => {}));
    const running = new AbortController();
    const pending = input.tool.execute({ prompt: "Draw" }, running.signal);
    await vi.waitFor(() => expect(input.fetchMock).toHaveBeenCalledOnce());
    running.abort(new Error("Cancelled provider"));
    await expect(pending).rejects.toThrow("Cancelled provider");
    expect(input.commandRuntime.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("keeps successful saved images available if later preview or persistence fails", async () => {
    const input = await setup();
    input.commandRuntime.writeWorkspaceFile.mockRejectedValueOnce(new Error("Workspace write failed"));
    await expect(input.tool.execute({ prompt: "Draw" })).rejects.toThrow("Workspace write failed");
    input.commandRuntime.execute.mockImplementationOnce(async () => ({ stdout: "ImageMagick", stderr: "", exitCode: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false, threadFiles: { directory: "", available: 0, files: [] } }));
    input.commandRuntime.readWorkspaceFile.mockRejectedValueOnce(new Error("Preview unavailable"));
    await expect(input.tool.execute({ prompt: "Draw again" })).rejects.toThrow(/Image saved at .*preview failed/);
    expect(input.commandRuntime.files.size).toBe(1);
    expect(input.bridge.attachments).toHaveLength(0);
  });
});
