import { workspaceRuntime, TEST_PNG } from "../helpers/workspaceRuntime.js";
import { testOutgoingFiles } from "../helpers/outgoingFiles.js";
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
import { InferenceUsageCollector } from "../../src/pi/usage.js";

let tempRoot: string;

describe("Pi generate_image extension", () => {
  let db: AppDatabase | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-image-extension-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await db?.destroy();
    db = undefined;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function reusableBridge() {
    const config=testConfig({DB_URL:"sqlite::memory:"});
    db=createDatabase(config);await db.initialize();
    const repos=createRepos(db.db,db.search);
    const user=await repos.users.ensure({tgId:8299,firstName:"Reusable images"});
    const thread=await repos.threads.create({userId:user.tg_id,topicId:null,title:"Images"});
    const commandRuntime=workspaceRuntime();
    const bridge:ChatImageBridge={config,repos,user,thread,commandRuntime,outgoingFiles:testOutgoingFiles({config,repos,user,thread,commandRuntime}),modelRegistry:{hasConfiguredAuth:()=>false} as unknown as ModelRegistry,providerRouter:providerRouter(backendModel()),resolveImage:async()=>({bytes:TEST_PNG,mimeType:"image/png"})};
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({data:[{b64_json:TEST_PNG.toString("base64"),media_type:"image/png"}]})));
    return {bridge,commandRuntime};
  }

  it.each([false, true])("retains cached-token usage from the image response, separate item=%s", async (separateItem) => {
    const { bridge } = await reusableBridge();
    bridge.config.CODEX_FAST_MODE = true;
    bridge.modelRegistry = { hasConfiguredAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwtWithAccount("test-account"), headers: {} }) } as unknown as ModelRegistry;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const item = { type: "image_generation_call", id: "ig_usage", status: "completed", result: TEST_PNG.toString("base64") };
      const events = [
        ...(separateItem ? [{ type: "response.output_item.done", item }] : []),
        { type: "response.completed", response: { id: "image-usage", model: "codex-test", service_tier: "priority", output: [item], usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 20, total_tokens: 1_020 } } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }));
    const capture = new InferenceUsageCollector();
    const result = await capture.run(() => createGenerateImagePiTool(bridge).execute("usage-image", { prompt: "blue circle" }, undefined, undefined, {} as never));
    expect(result.usage).toMatchObject({ input: 100, cacheRead: 900, output: 20 });
    expect(capture.usage().calls).toMatchObject([{ source: "image_generation", provider: "openai-codex", cacheReadTokens: 900, fastMode: true, serviceTier: "priority", cacheWriteReported: false }]);
  });

  it("captures OpenRouter image token usage without marking it as Codex fast mode", async () => {
    const { bridge } = await reusableBridge();
    bridge.config.CODEX_FAST_MODE = true;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ b64_json: TEST_PNG.toString("base64"), media_type: "image/png" }],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 50, cache_write_tokens: 10 } },
    })));
    const capture = new InferenceUsageCollector();
    const result = await capture.run(() => createGenerateImagePiTool(bridge).execute("usage-fallback", { prompt: "blue circle" }, undefined, undefined, {} as never));
    expect(result.usage).toMatchObject({ input: 40, cacheRead: 50, cacheWrite: 10, output: 20 });
    expect(capture.usage().calls).toMatchObject([{ source: "image_generation", provider: "openrouter", cacheReadTokens: 50, cacheWriteTokens: 10, fastMode: false, cacheWriteReported: true }]);
  });

  async function stalledCodexStream(completed: boolean, timeout = 0) {
    const { bridge } = await reusableBridge();
    bridge.config.IMAGE_TIMEOUT_MS = timeout;
    bridge.modelRegistry = { hasConfiguredAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwtWithAccount("test-account"), headers: {} }) } as unknown as ModelRegistry;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let reads = 0;
    let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const cancel = vi.fn();
    const event = completed
      ? { type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", result: TEST_PNG.toString("base64") } }
      : { type: "response.image_generation_call.partial_image", partial_image_b64: TEST_PNG.toString("base64") };
    const body = new ReadableStream<Uint8Array>({
      start(controller) { stream = controller; },
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        else ready();
      },
      cancel,
    }, { highWaterMark: 0 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }))
      .mockImplementation(async () => Response.json({ data: [{ b64_json: TEST_PNG.toString("base64"), media_type: "image/png" }] }));
    vi.stubGlobal("fetch", fetchMock);
    return { bridge, stream, waiting, cancel, fetchMock };
  }

  it("returns a completed image after a bounded usage grace period without paying for fallback", async () => {
    const { bridge, waiting, cancel, fetchMock } = await stalledCodexStream(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const capture = new InferenceUsageCollector();
    const resultPromise = capture.run(() => createGenerateImagePiTool(bridge).execute("grace", { prompt: "draw" }, undefined, undefined, {} as never));
    await waiting;
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;
    expect(result.details).toMatchObject({ provider: "codex" });
    expect(result.usage).toBeUndefined();
    expect(capture.usage().calls).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(bridge.providerRouter.circuit.state().open).toBe(false);
  });

  it("collects terminal usage arriving after the completed image", async () => {
    const { bridge, stream, waiting, fetchMock } = await stalledCodexStream(true);
    const resultPromise = createGenerateImagePiTool(bridge).execute("late-usage", { prompt: "draw" }, undefined, undefined, {} as never);
    await waiting;
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 20 } } })}\n\n`));
    expect((await resultPromise).usage).toMatchObject({ input: 100, cacheRead: 900, output: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "disconnect"])("keeps a completed image when its usage stream ends with %s", async (failure) => {
    const { bridge, stream, waiting, fetchMock } = await stalledCodexStream(true, failure === "timeout" ? 30 : 0);
    const resultPromise = createGenerateImagePiTool(bridge).execute("finished", { prompt: "draw" }, undefined, undefined, {} as never);
    await waiting;
    if (failure === "disconnect") stream.error(new Error("network connection lost"));
    expect((await resultPromise).details).toMatchObject({ provider: "codex" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bridge.providerRouter.circuit.state().open).toBe(false);
  });

  it("honors explicit cancellation after an image completes", async () => {
    const { bridge, waiting, fetchMock } = await stalledCodexStream(true);
    const cancellation = new AbortController();
    const resultPromise = createGenerateImagePiTool(bridge).execute("cancel-finished", { prompt: "draw" }, cancellation.signal, undefined, {} as never);
    const rejected = expect(resultPromise).rejects.toThrow("user cancelled");
    await waiting;
    cancellation.abort(new Error("user cancelled"));
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bridge.providerRouter.circuit.state().open).toBe(false);
  });

  it("still falls back when a stalled stream has only an incomplete partial image", async () => {
    const { bridge, fetchMock } = await stalledCodexStream(false, 30);
    const result = await createGenerateImagePiTool(bridge).execute("partial-timeout", { prompt: "draw" }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ provider: "openrouter" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("generates several assets, edits a saved asset, and queues only the selected result",async()=>{
    const {bridge,commandRuntime}=await reusableBridge();
    const tool=createGenerateImagePiTool(bridge);
    const first=await tool.execute("one",{prompt:"blue circle"},undefined,undefined,{} as never);
    const firstPath=(first.details as {path:string}).path;
    const second=await tool.execute("two",{prompt:"make it green",mode:"edit",reference_paths:[firstPath]},undefined,undefined,{} as never);
    expect(first.terminate).not.toBe(true);expect(second.terminate).not.toBe(true);
    expect(bridge.outgoingFiles.items).toHaveLength(0);
    expect(commandRuntime.writeWorkspaceFile).toHaveBeenCalledTimes(2);
    const calls=vi.mocked(fetch).mock.calls;
    const request=JSON.parse(String(calls[1]![1]!.body));
    expect(request.input_references).toHaveLength(1);
    expect(request.input_references[0].image_url.url).toBe(`data:image/png;base64,${TEST_PNG.toString("base64")}`);
    const queued=await bridge.outgoingFiles.workspace([{path:(second.details as {path:string}).path}]);
    expect(queued.errors).toEqual([]);expect(bridge.outgoingFiles.items).toHaveLength(1);
  });

  it("checks availability, combined reference limits, and thread scope before paying for generation",async()=>{
    const {bridge}=await reusableBridge();
    await expect(createGenerateImagePiTool({...bridge,commandRuntime:undefined}).execute("missing",{prompt:"draw"},undefined,undefined,{} as never)).rejects.toThrow("workspace support");
    const tool=createGenerateImagePiTool(bridge);
    await expect(tool.execute("too-many",{prompt:"draw",reference_file_ids:[1,2,3],reference_paths:["/a.png","/b.png","/c.png"]},undefined,undefined,{} as never)).rejects.toThrow("At most 5");
    const other=await bridge.repos.threads.create({userId:bridge.user.tg_id,topicId:null,title:"Other"});
    const ref=await bridge.repos.files.insertFile({userId:bridge.user.tg_id,threadId:other.id,type:"image",name:"private.png",size:TEST_PNG.length,isInline:false});
    await expect(tool.execute("cross-thread",{prompt:"draw",reference_file_ids:[ref.id]},undefined,undefined,{} as never)).rejects.toThrow("not available in this thread");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not report success or queue an attachment after a failed write or cancellation",async()=>{
    const {bridge,commandRuntime}=await reusableBridge();
    commandRuntime.writeWorkspaceFile.mockRejectedValueOnce(new Error("write failed"));
    await expect(createGenerateImagePiTool(bridge).execute("write",{prompt:"draw"},undefined,undefined,{} as never)).rejects.toThrow("write failed");
    const controller=new AbortController();controller.abort(new Error("cancelled"));
    await expect(createGenerateImagePiTool(bridge).execute("cancel",{prompt:"draw"},controller.signal,undefined,{} as never)).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bridge.outgoingFiles.items).toHaveLength(0);
  });

  it("uses Telegram references, saves the original, returns vision, and leaves delivery to the model", async () => {
    const config = testConfig({ OPENROUTER_IMAGE_MODEL: "test/image-model" });
    db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 815, firstName: "Image" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Images" });
    const reference = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "image",
      name: "telegram-reference.png",
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
    const outputBytes = TEST_PNG;
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
      outgoingFiles: testOutgoingFiles({ config, repos, user, thread }),
      commandRuntime: workspaceRuntime(),
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
    expect(bridge.outgoingFiles.items).toHaveLength(0);
    expect(bridge.commandRuntime!.writeWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({bytes:outputBytes,virtualPath:expect.stringMatching(/^\/assets\/generated-/)}));
    expect(result.terminate).not.toBe(true);
    expect(result.content.some(part=>part.type === "image")).toBe(true);
    expect(result.details).toMatchObject({generated_image:true,width:1,height:1});
    expect(JSON.stringify(result.details)).not.toContain(outputBytes.toString("base64"));

  });

  it.each([false, true])("uses Pi Codex OAuth headers and the hosted image_generation payload with fast mode=%s", async (fastMode) => {
    const config = testConfig({ CODEX_FAST_MODE: fastMode });
    db = createDatabase(config);
    await db.initialize();
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
        result: TEST_PNG.toString("base64"),
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
      outgoingFiles: testOutgoingFiles({ config, repos, user, thread }),
      commandRuntime: workspaceRuntime(),
      modelRegistry: {
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: accessToken,
          headers: { "x-pi-auth": "kept", "x-removed": null },
        }),
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
    expect(requestHeaders?.has("x-removed")).toBe(false);
    if (fastMode) expect(requestBody).toHaveProperty("service_tier", "priority");
    else expect(requestBody).not.toHaveProperty("service_tier");
    expect(requestBody).toMatchObject({
      model: "codex-test",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      tool_choice: { type: "image_generation" },
      tools: [{ type: "image_generation", output_format: "webp", action: "generate" }],
    });
    expect(bridge.commandRuntime!.writeWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({bytes:TEST_PNG}));
    expect(bridge.outgoingFiles.items).toHaveLength(0);
    expect(bridge.providerRouter.circuit.state().open).toBe(false);
  });

  it("accepts the hosted Codex partial image when the completed item omits its result", async () => {
    const config = testConfig();
    db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 819, firstName: "CodexStream" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Codex stream" });
    const accessToken = jwtWithAccount("account-stream");
    const partial = TEST_PNG.toString("base64");
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
      outgoingFiles: testOutgoingFiles({ config, repos, user, thread }),
      commandRuntime: workspaceRuntime(),
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

    expect(bridge.commandRuntime!.writeWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({bytes:TEST_PNG}));
    expect(bridge.outgoingFiles.items).toHaveLength(0);
  });

  it("accepts the latest partial when the hosted stream completes without a completed image item", async () => {
    const config = testConfig();
    db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 821, firstName: "CodexCompletedStream" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Codex completed stream" });
    const partial = TEST_PNG.toString("base64");
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        item: { type: "image_generation_call", id: "ig_hosted", status: "in_progress", result: null },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.image_generation_call.partial_image",
        partial_image_index: 0,
        partial_image_b64: partial,
        output_format: "png",
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "image_generation_call", id: "ig_hosted", status: "generating", result: null },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`,
    ].join(""), { headers: { "content-type": "text/event-stream" } })));
    const model = backendModel();
    const bridge: ChatImageBridge = {
      config,
      repos,
      user,
      thread,
      outgoingFiles: testOutgoingFiles({ config, repos, user, thread }),
      commandRuntime: workspaceRuntime(),
      modelRegistry: {
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwtWithAccount("account-completed-stream") }),
      } as unknown as ModelRegistry,
      providerRouter: providerRouter(model),
      resolveImage: async () => { throw new Error("no reference expected"); },
    };

    await createGenerateImagePiTool(bridge).execute("tool-call", {
      prompt: "stream a hosted codex image",
      output_format: "png",
    }, undefined, undefined, {} as never);

    expect(bridge.commandRuntime!.writeWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({bytes:TEST_PNG}));
    expect(bridge.providerRouter.circuit.state().open).toBe(false);
  });

  it("falls back when a Codex image stream ends after a partial without completion", async () => {
    const config = testConfig();
    db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 820, firstName: "CodexDisconnect" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Codex disconnect" });
    const partial = TEST_PNG.toString("base64");
    const fallback = TEST_PNG;
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
      outgoingFiles: testOutgoingFiles({ config, repos, user, thread }),
      commandRuntime: workspaceRuntime(),
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
    expect(bridge.commandRuntime!.writeWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({bytes:fallback}));
    expect(router.circuit.state().open).toBe(true);
  });

  it("falls back from retryable Codex image failures through the shared circuit", async () => {
    const config = testConfig({ CODEX_FAST_MODE: true });
    db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 817, firstName: "FallbackImage" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Fallback Images" });
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)));
      if (urls.length === 1) return new Response("quota", { status: 429, headers: { "retry-after": "30" } });
      return Response.json({ data: [{ b64_json: TEST_PNG.toString("base64") }] });
    }));
    const model = backendModel();
    const router = providerRouter(model);
    const bridge: ChatImageBridge = {
      config,
      repos,
      user,
      thread,
      outgoingFiles: testOutgoingFiles({ config, repos, user, thread }),
      commandRuntime: workspaceRuntime(),
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
    expect(bodies[0]).toHaveProperty("service_tier", "priority");
    expect(bodies[1]).not.toHaveProperty("service_tier");
    expect(result.details).toMatchObject({ provider: "openrouter" });
    expect(router.circuit.state().open).toBe(true);
    expect(bridge.commandRuntime!.writeWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({bytes:TEST_PNG}));
  });

  it("closes a half-open circuit after a definitive Codex image rejection", async () => {
    const config = testConfig();
    db = createDatabase(config);
    await db.initialize();
    const repos = createRepos(db.db, db.search);
    const user = await repos.users.ensure({ tgId: 818, firstName: "RejectedImage" });
    const thread = await repos.threads.create({ userId: user.tg_id, topicId: null, title: "Rejected Images" });
    let now = 10_000;
    const circuit = new CodexCircuitBreaker(() => now);
    const failure = circuit.acquire();
    if (!failure.allowed) throw new Error("Expected an allowed attempt");
    failure.recordFailure();
    now += 30 * 60_000;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: {
        message: "Billing hard limit has been reached.",
        metadata: { provider_name: "OpenAI", ignored: "do not expose this object" },
      },
    }, { status: 400 })));
    const model = backendModel();
    const router = { ...providerRouter(model), circuit };
    const bridge: ChatImageBridge = {
      config,
      repos,
      user,
      thread,
      outgoingFiles: testOutgoingFiles({ config, repos, user, thread }),
      commandRuntime: workspaceRuntime(),
      modelRegistry: {
        hasConfiguredAuth: () => true,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwtWithAccount("account-rejected") }),
      } as unknown as ModelRegistry,
      providerRouter: router,
      resolveImage: async () => { throw new Error("no reference expected"); },
    };

    await expect(createGenerateImagePiTool(bridge).execute("tool-call", {
      prompt: "policy-rejected image",
    }, undefined, undefined, {} as never)).rejects.toThrow(
      "Image request failed (400): Billing hard limit has been reached.",
    );

    expect(circuit.state().open).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function testConfig(overrides: Parameters<typeof loadTestConfig>[0] = {}) {
  return loadTestConfig(overrides);
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
