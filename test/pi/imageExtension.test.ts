import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { createGenerateImagePiTool, type ChatImageBridge } from "../../src/pi/imageExtension.js";
import { CodexCircuitBreaker } from "../../src/pi/circuit.js";
import type { PiProviderRouter } from "../../src/pi/provider.js";

let bashRoot: string;

describe("Pi generate_image extension", () => {
  let db: AppDatabase | undefined;

  beforeEach(async () => {
    bashRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-image-extension-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db?.destroy();
    db = undefined;
    await fs.rm(bashRoot, { recursive: true, force: true });
  });

  it("uses Telegram-backed references and persists the generated original without putting bytes in Pi results", async () => {
    const config = testConfig({ OPENROUTER_IMAGE_MODEL: "test/image-model" });
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 815, firstName: "Image" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Images" });
    const reference = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "image",
      name: "telegram-reference.png",
      path: null,
      size: 8,
      mimeType: "image/png",
      summary: "a Telegram reference",
      isInline: false,
    });
    await repos.files.rememberSource(reference.id, {
      transport: "telegram",
      connectionKey: "default",
      remoteKey: "unique-reference",
      locator: { file_id: "AgAC-reference", file_unique_id: "unique-reference" },
      mimeType: "image/png",
    });
    const outputBytes = Buffer.from("generated-image-bytes");
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        data: [{
          b64_json: outputBytes.toString("base64"),
          media_type: "image/png",
          revised_prompt: "a revised image prompt",
        }],
      });
    }));

    const model = backendModel();
    const bridge: ChatImageBridge = {
      config,
      repos,
      user,
      thread,
      attachments: [],
      modelRegistry: {
        hasConfiguredAuth: () => false,
      } as unknown as ModelRegistry,
      providerRouter: {
        circuit: new CodexCircuitBreaker(),
        mainModel: model,
        helperModel: model,
        codexModel: () => model as Model<"openai-codex-responses">,
        openRouterModel: () => model as Model<"openai-completions">,
        codexConfigured: () => false,
      } satisfies PiProviderRouter,
      resolveImage: async (file) => {
        expect(file.id).toBe(reference.id);
        expect(file.path).toBeNull();
        return { bytes: Buffer.from("reference-bytes"), mimeType: "image/png" };
      },
    };

    const tool = createGenerateImagePiTool(bridge);
    const result = await tool.execute("tool-call", {
      prompt: "edit the reference",
      mode: "edit",
      reference_file_ids: [reference.id],
      output_format: "png",
      caption: "finished",
    }, undefined, undefined, {} as never);

    expect(requestBody).toMatchObject({
      model: "test/image-model",
      prompt: "edit the reference",
      n: 1,
      output_format: "png",
    });
    const inputReferences = requestBody?.input_references as Array<{ image_url: { url: string } }>;
    expect(inputReferences).toHaveLength(1);
    expect(inputReferences[0]?.image_url.url).toBe(`data:image/png;base64,${Buffer.from("reference-bytes").toString("base64")}`);
    expect(bridge.attachments).toHaveLength(1);
    expect(bridge.attachments[0]?.data).toEqual(outputBytes);
    expect(bridge.attachments[0]?.caption).toBe("finished");
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("[[chat-file:");
    const generated = await repos.files.get(bridge.attachments[0]!.fileId);
    expect(generated?.path).toBe(path.join(bashRoot, ".chat-files", String(generated?.id), "content"));
    await expect(fs.readFile(generated!.path!)).resolves.toEqual(outputBytes);
    await expect(repos.files.listSources(generated!.id)).resolves.toEqual([]);
    const persisted = JSON.stringify({ generated, result });
    expect(persisted).not.toContain(outputBytes.toString("base64"));
    expect(persisted).not.toContain("reference-bytes");
  });

  it("uses Pi Codex OAuth headers and the hosted image_generation payload", async () => {
    const config = testConfig();
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 816, firstName: "CodexImage" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Codex Images" });
    const accessToken = jwtWithAccount("account-123");
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestHeaders = new Headers(init?.headers);
      const item = {
        type: "image_generation_call",
        id: "ig_123",
        status: "completed",
        result: Buffer.from("codex-image").toString("base64"),
        revised_prompt: "Codex revised prompt",
      };
      return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const model = backendModel();
    const bridge: ChatImageBridge = {
      config,
      repos,
      user,
      thread,
      attachments: [],
      modelRegistry: {
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: accessToken, headers: { "x-pi-auth": "kept" } }),
      } as unknown as ModelRegistry,
      providerRouter: providerRouter(model),
      resolveImage: async () => { throw new Error("no reference expected"); },
    };

    await createGenerateImagePiTool(bridge).execute("tool-call", {
      prompt: "make a codex image",
      mode: "generate",
      output_format: "webp",
    }, undefined, undefined, {} as never);

    expect(requestHeaders?.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(requestHeaders?.get("chatgpt-account-id")).toBe("account-123");
    expect(requestHeaders?.get("originator")).toBe("pi");
    expect(requestHeaders?.get("x-pi-auth")).toBe("kept");
    expect(requestBody).toMatchObject({
      model: "codex-test",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      tool_choice: { type: "image_generation" },
      tools: [{ type: "image_generation", output_format: "webp", action: "generate" }],
    });
    expect(bridge.attachments[0]?.data).toEqual(Buffer.from("codex-image"));
    expect(bridge.providerRouter.circuit.state().open).toBe(false);
  });

  it("accepts the hosted Codex partial image when the completed item omits its result", async () => {
    const config = testConfig();
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 819, firstName: "CodexStream" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Codex stream" });
    const accessToken = jwtWithAccount("account-stream");
    const partial = Buffer.from("latest-codex-partial").toString("base64");
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      `data: ${JSON.stringify({
        type: "response.image_generation_call.partial_image",
        partial_image_index: 0,
        partial_image_b64: partial,
        output_format: "jpeg",
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "image_generation_call", id: "ig_stream", status: "completed", result: null },
      })}`,
    ].join(""), { headers: { "content-type": "text/event-stream" } })));
    const model = backendModel();
    const bridge: ChatImageBridge = {
      config,
      repos,
      user,
      thread,
      attachments: [],
      modelRegistry: {
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: accessToken }),
      } as unknown as ModelRegistry,
      providerRouter: providerRouter(model),
      resolveImage: async () => { throw new Error("no reference expected"); },
    };

    await createGenerateImagePiTool(bridge).execute("tool-call", {
      prompt: "stream a codex image",
      output_format: "jpeg",
    }, undefined, undefined, {} as never);

    expect(bridge.attachments[0]?.data).toEqual(Buffer.from("latest-codex-partial"));
    const stored = await repos.files.get(bridge.attachments[0]!.fileId);
    expect(stored?.mime_type).toBe("image/jpeg");
  });

  it("falls back when a Codex image stream ends after a partial without completion", async () => {
    const config = testConfig();
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 820, firstName: "CodexDisconnect" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Codex disconnect" });
    const partial = Buffer.from("incomplete-codex-partial").toString("base64");
    const fallback = Buffer.from("complete-openrouter-image");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify({
        type: "response.image_generation_call.partial_image",
        partial_image_index: 0,
        partial_image_b64: partial,
        output_format: "png",
      })}\n\n`, { headers: { "content-type": "text/event-stream" } }))
      .mockResolvedValueOnce(Response.json({
        data: [{ b64_json: fallback.toString("base64"), media_type: "image/png" }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    const model = backendModel();
    const router = providerRouter(model);
    const bridge: ChatImageBridge = {
      config,
      repos,
      user,
      thread,
      attachments: [],
      modelRegistry: {
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwtWithAccount("account-disconnect") }),
      } as unknown as ModelRegistry,
      providerRouter: router,
      resolveImage: async () => { throw new Error("no reference expected"); },
    };

    const result = await createGenerateImagePiTool(bridge).execute("tool-call", {
      prompt: "recover from an incomplete stream",
      output_format: "png",
    }, undefined, undefined, {} as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({ provider: "openrouter" });
    expect(bridge.attachments[0]?.data).toEqual(fallback);
    expect(router.circuit.state().open).toBe(true);
  });

  it("falls back from retryable Codex image failures through the shared circuit", async () => {
    const config = testConfig();
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 817, firstName: "FallbackImage" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Fallback Images" });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) return new Response("quota", { status: 429, headers: { "retry-after": "30" } });
      return Response.json({ data: [{ b64_json: Buffer.from("fallback-image").toString("base64") }] });
    }));
    const model = backendModel();
    const router = providerRouter(model);
    const bridge: ChatImageBridge = {
      config,
      repos,
      user,
      thread,
      attachments: [],
      modelRegistry: {
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwtWithAccount("account-fallback") }),
      } as unknown as ModelRegistry,
      providerRouter: router,
      resolveImage: async () => { throw new Error("no reference expected"); },
    };

    const result = await createGenerateImagePiTool(bridge).execute("tool-call", {
      prompt: "fallback image",
    }, undefined, undefined, {} as never);

    expect(urls).toEqual([
      "https://chatgpt.com/backend-api/codex/responses",
      "https://openrouter.ai/api/v1/images",
    ]);
    expect(result.details).toMatchObject({ provider: "openrouter" });
    expect(router.circuit.state().open).toBe(true);
    expect(bridge.attachments[0]?.data).toEqual(Buffer.from("fallback-image"));
  });

  it("closes a half-open circuit after a definitive Codex image rejection", async () => {
    const config = testConfig();
    db = createDatabase(config);
    await db.migrate();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 818, firstName: "RejectedImage" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Rejected Images" });
    let now = 10_000;
    const circuit = new CodexCircuitBreaker(() => now);
    circuit.recordFailure();
    now += 30 * 60_000;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid", { status: 400 })));
    const model = backendModel();
    const router = { ...providerRouter(model), circuit };
    const bridge: ChatImageBridge = {
      config,
      repos,
      user,
      thread,
      attachments: [],
      modelRegistry: {
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwtWithAccount("account-rejected") }),
      } as unknown as ModelRegistry,
      providerRouter: router,
      resolveImage: async () => { throw new Error("no reference expected"); },
    };

    await expect(createGenerateImagePiTool(bridge).execute("tool-call", {
      prompt: "policy-rejected image",
    }, undefined, undefined, {} as never)).rejects.toThrow("400");

    expect(circuit.state().open).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function testConfig(overrides: Parameters<typeof loadTestConfig>[0] = {}) {
  return loadTestConfig({ BASH_WORKSPACE_ROOT: bashRoot, ...overrides });
}

function backendModel(): Model<Api> {
  return {
    id: "codex-test",
    name: "codex-test",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  };
}

function providerRouter(model: Model<Api>): PiProviderRouter {
  return {
    circuit: new CodexCircuitBreaker(),
    mainModel: model,
    helperModel: model,
    codexModel: () => model as Model<"openai-codex-responses">,
    openRouterModel: () => model as Model<"openai-completions">,
    codexConfigured: () => true,
  };
}

function jwtWithAccount(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.signature`;
}
