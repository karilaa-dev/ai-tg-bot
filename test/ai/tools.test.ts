import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestConfig } from "../../src/config.js";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos, type Repos } from "../../src/db/repos/index.js";
import { createLogger } from "../../src/logger.js";
import {
  buildCodexToolSpecs,
  buildToolRegistry,
  buildTools,
  formatBotToolResultForCodex,
  type BotImageGenerator,
  type CreatedFileAttachment,
} from "../../src/ai/tools/index.js";
import { ingestFileBytes } from "../../src/files/ingest.js";
import { MAX_CREATED_FILES_PER_ANSWER, MAX_FILE_BYTES } from "../../src/files/limits.js";
import { compactThread } from "../../src/memory/compactor.js";
import { clearRetrievalVectorCacheForTests, threadChainScope } from "../../src/memory/retrieval.js";

const tavilyMock = vi.hoisted(() => {
  const search = vi.fn();
  const extract = vi.fn();
  return {
    search,
    extract,
    tavily: vi.fn(() => ({ search, extract })),
  };
});

vi.mock("@tavily/core", () => ({ tavily: tavilyMock.tavily }));

describe("AI tools", () => {
  let db: AppDatabase;
  let repos: Repos;
  let tempDirs: string[] = [];

  beforeEach(async () => {
    tavilyMock.tavily.mockClear();
    tavilyMock.search.mockReset();
    tavilyMock.extract.mockReset();
    const config = loadTestConfig();
    clearRetrievalVectorCacheForTests();
    db = createDatabase(config, createLogger(config));
    await db.migrate();
    repos = createRepos(db.db, db.search);
  });

  afterEach(async () => {
    await db.destroy();
    clearRetrievalVectorCacheForTests();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("extracts known web pages through Tavily with normalized model output", async () => {
    tavilyMock.extract.mockResolvedValue({
      results: [
        {
          url: "https://example.com/a",
          rawContent: "abcdef",
          images: ["https://example.com/a.png"],
          favicon: "https://example.com/favicon.ico",
        },
        {
          url: "https://example.com/b",
          raw_content: "rest",
        },
      ],
      failedResults: [{ url: "https://bad.example/", error: "blocked" }],
      response_time: 1.5,
      request_id: "req-1",
    });
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 70, firstName: "ExtractTool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const tools = buildTools({ config, db, repos, user, thread });
    const webExtract = tools.web_extract as unknown as {
      execute(input: unknown): Promise<{
        results: Array<{ url: string; content: string; truncated: boolean; chars: number; images?: string[]; favicon?: string }>;
        failed_results: Array<{ url: string; error: string }>;
        response_time?: number;
        request_id?: string;
      }>;
    };

    const result = await webExtract.execute({
      urls: ["https://example.com/a", "https://example.com/b"],
      query: "release notes",
      chunks_per_source: 2,
      extract_depth: "advanced",
      format: "text",
      include_images: true,
      include_favicon: true,
      timeout: 12,
      max_chars_per_url: 4,
    });

    expect(tavilyMock.tavily).toHaveBeenCalledWith({ apiKey: "test-tavily" });
    expect(tavilyMock.extract).toHaveBeenCalledWith(["https://example.com/a", "https://example.com/b"], {
      query: "release notes",
      chunksPerSource: 2,
      extractDepth: "advanced",
      format: "text",
      includeImages: true,
      includeFavicon: true,
      timeout: 12,
    });
    expect(result).toEqual({
      results: [
        {
          url: "https://example.com/a",
          content: "abcd",
          truncated: true,
          chars: 6,
          images: ["https://example.com/a.png"],
          favicon: "https://example.com/favicon.ico",
        },
        {
          url: "https://example.com/b",
          content: "rest",
          truncated: false,
          chars: 4,
        },
      ],
      failed_results: [{ url: "https://bad.example/", error: "blocked" }],
      response_time: 1.5,
      request_id: "req-1",
    });
  });

  it("returns Tavily extraction errors as tool errors", async () => {
    tavilyMock.extract.mockRejectedValue(new Error("network down"));
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 76, firstName: "ExtractError", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const tools = buildTools({ config, db, repos, user, thread });
    const webExtract = tools.web_extract as unknown as {
      execute(input: unknown): Promise<{ error?: string }>;
    };

    const result = await webExtract.execute({
      urls: ["https://example.com/a"],
      chunks_per_source: 3,
      extract_depth: "basic",
      format: "markdown",
      include_images: false,
      include_favicon: false,
      max_chars_per_url: 12_000,
    });

    expect(result).toEqual({ error: "Error: network down" });
  });

  it("runs just-bash in a persistent per-thread workspace with JS, Python, SQLite, and public curl", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-bash-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot, BASH_TIMEOUT_MS: 30_000, BASH_MAX_OUTPUT_CHARS: 5000 });
    const user = await repos.users.ensure({ tgId: 77, firstName: "BashTool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const otherThread = await repos.threads.activeForUserTopic(user.tg_id, 777, "Other bash thread");

    const firstTools = buildTools({ config, db, repos, user, thread });
    const firstBash = bashTool(firstTools);
    const written = await firstBash.execute({
      script: [
        "mkdir -p work",
        "printf 'alpha\\nbeta\\n' > work/notes.txt",
        "cat work/notes.txt | grep alpha",
        "python3 -c \"print(6 * 7)\"",
        "js-exec -c \"console.log(20 + 22)\"",
        "sqlite3 :memory: \"select 40 + 2;\"",
      ].join("\n"),
    });

    expect(written).toMatchObject({ exit_code: 0, timed_out: false, stdout_truncated: false, stderr_truncated: false });
    expect(written.stdout).toContain("alpha\n");
    expect(written.stdout).toContain("42\n");

    const secondBash = bashTool(buildTools({ config, db, repos, user, thread }));
    const persisted = await secondBash.execute({ script: "cat work/notes.txt" });
    expect(persisted).toMatchObject({ exit_code: 0, timed_out: false });
    expect(persisted.stdout).toBe("alpha\nbeta\n");

    const isolatedBash = bashTool(buildTools({ config, db, repos, user, thread: otherThread }));
    const isolated = await isolatedBash.execute({ script: "cat work/notes.txt" });
    expect(isolated.exit_code).not.toBe(0);
    expect(isolated.stdout).not.toContain("alpha");

    let fetchCalls = 0;
    await withMockFetch(async (resource, init) => {
      fetchCalls += 1;
      expect(String(resource)).toBe("http://93.184.216.34/tool");
      expect(init?.method).toBe("GET");
      return new Response("network-ok\n", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
      const network = await secondBash.execute({ script: "curl -s http://93.184.216.34/tool" });
      expect(network).toMatchObject({ exit_code: 0, timed_out: false });
      expect(network.stdout).toBe("network-ok\n");
    });
    expect(fetchCalls).toBe(1);
  }, 60_000);

  it("bounds just-bash output, times out long scripts, and blocks symlink escapes from the thread workspace", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-bash-guard-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-bash-outside-"));
    tempDirs.push(workspaceRoot, outsideRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot, BASH_TIMEOUT_MS: 100, BASH_MAX_OUTPUT_CHARS: 8 });
    const user = await repos.users.ensure({ tgId: 78, firstName: "BashGuard", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const bash = bashTool(buildTools({ config, db, repos, user, thread }));

    const truncated = await bash.execute({ script: "printf 1234567890; printf abcdefghij >&2" });
    expect(truncated).toMatchObject({
      exit_code: 0,
      stdout: "12345678",
      stderr: "abcdefgh",
      stdout_truncated: true,
      stderr_truncated: true,
    });

    const timedOut = await bash.execute({ script: "while true; do sleep 1; done" });
    expect(timedOut).toMatchObject({ exit_code: null, timed_out: true });
    expect(timedOut.error).toContain("timed out");

    const secretPath = path.join(outsideRoot, "secret.txt");
    await fs.writeFile(secretPath, "HOST_SECRET_SHOULD_NOT_LEAK");
    const threadRoot = path.join(workspaceRoot, `thread-${thread.id}`);
    await fs.mkdir(threadRoot, { recursive: true });
    await fs.symlink(secretPath, path.join(threadRoot, "leak"));

    const escaped = await bash.execute({ script: "cat leak" });
    expect(escaped.exit_code).not.toBe(0);
    expect(`${escaped.stdout}\n${escaped.stderr}`).not.toContain("HOST_SECRET_SHOULD_NOT_LEAK");

    let fetchCalls = 0;
    await withMockFetch(async () => {
      fetchCalls += 1;
      throw new Error("private fetch should have been blocked before fetch");
    }, async () => {
      const privateNetwork = await bash.execute({ script: "curl -s http://127.0.0.1/secret" });
      expect(privateNetwork).toMatchObject({ timed_out: false });
      expect(privateNetwork.exit_code).not.toBe(0);
    });
    expect(fetchCalls).toBe(0);
  }, 30_000);

  it("describes bash/raw-URL guidance and sends compact recovery hints to the model", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 80, firstName: "BashHints", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const registry = buildToolRegistry({ config, db, repos, user, thread });
    const specs = await buildCodexToolSpecs(registry);
    const bashSpec = specs.find((spec) => spec.name === "bash");
    const webSearchSpec = specs.find((spec) => spec.name === "web_search");
    const webExtractSpec = specs.find((spec) => spec.name === "web_extract");
    expect(bashSpec?.description).toContain("js-exec -c");
    expect(bashSpec?.description).toContain("curl -fsSL");
    expect(bashSpec?.description).toContain("Do not use Python urllib/requests");
    expect(bashSpec?.description).toContain("before claiming online verification");
    expect(bashSpec?.description).toContain("constant-digit checks");
    expect(bashSpec?.description).toContain("Avoid command substitution");
    expect(bashSpec?.description).toContain("temp files");
    expect(bashSpec?.description).toContain("compact JSON");
    expect(bashSpec?.description).toContain("equality/lengths/counts");
    expect(bashSpec?.description).toContain("retry only the failed part");
    expect(bashSpec?.description).toContain("set -o pipefail");
    expect(bashSpec?.description).toContain("Localhost/private");
    expect(webSearchSpec?.description).toContain("discover candidate");
    expect(webSearchSpec?.description).toContain("Do not claim or cite online verification from memory");
    expect(webSearchSpec?.description).toContain("curl -fsSL");
    expect(webExtractSpec?.description).toContain("readable article/page");
    expect(webExtractSpec?.description).toContain("before claiming a web page verifies");
    expect(webExtractSpec?.description).toContain("raw JSON/API");
    expect(webExtractSpec?.description).toContain("PDF verification");
    const generateImageSpec = specs.find((spec) => spec.name === "generate_image");
    expect(generateImageSpec).toMatchObject({ exposeToContext: true });
    expect(generateImageSpec?.description).toContain("Generate or edit an image");
    expect(generateImageSpec?.description).toContain("reference_file_ids");
    expect(generateImageSpec?.description).toContain("terminal");
    const createFileSpec = specs.find((spec) => spec.name === "create_file");
    expect(createFileSpec).toMatchObject({ exposeToContext: true });
    expect(createFileSpec?.description).toContain("send back to the Telegram user");
    expect(createFileSpec?.description).toContain("Attach at most 10 files per answer");
    expect(createFileSpec?.description).toContain("do not call create_file more than 10 times");
    expect(createFileSpec?.description).toContain("20 MB");
    expect(createFileSpec?.description).toContain("compiled executables");
    const prompt = await fs.readFile(path.resolve("system_prompt.md"), "utf8");
    expect(prompt).toContain("js-exec -c");
    expect(prompt).toContain("curl -fsSL");
    expect(prompt).toContain("Do not use Python urllib/requests");
    expect(prompt).toContain("If the user asks to search the internet/web/online");
    expect(prompt).toContain("Do not claim, cite, or imply online verification");
    expect(prompt).toContain("one combined bash call");
    expect(prompt).toContain("common published-list convention");
    expect(prompt).toContain("3.` plus N digits after the decimal");
    expect(prompt).toContain("Avoid command substitution");
    expect(prompt).toContain("write each result to a temp file");
    expect(prompt).toContain("compact JSON");
    expect(prompt).toContain("equality/lengths/counts");
    expect(prompt).toContain("retry only the failed part");
    expect(prompt).toContain("Do not perform unnecessary tool calls after you have enough evidence");
    expect(prompt).toContain("set -o pipefail");
    expect(prompt).toContain("blocks localhost/private");
    expect(prompt).toContain("Use generate_image when the user asks you to create, draw, render, generate, or edit an image");
    expect(prompt).toContain("reference_file_ids");
    expect(prompt).toContain("After a successful generate_image call, treat it as the final step");
    expect(prompt).toContain("Do not use create_file for image generation requests");
    expect(prompt).toContain("call create_file");
    expect(prompt).toContain("Attach at most 10 files per answer");
    expect(prompt).toContain("do not call create_file more than 10 times");
    expect(prompt).toContain("If more files are needed, send the first 10");
    expect(prompt).toContain("Outbound files up to 20 MB are allowed");
    expect(prompt).toContain("Bash, PowerShell, Python, JavaScript, TypeScript, and similar scripts/source files are allowed");

    const nodeHint = await formatBotToolResultForCodex(
      registry,
      "bash",
      { script: "node -e 'console.log(42)'" },
      bashOutput({ stderr: "this sandbox uses js-exec instead of node\n", exit_code: 1 }),
      "bash-node",
    );
    expect(JSON.stringify(nodeHint)).toContain("Use js-exec -c");

    const commandSubstitutionHint = await formatBotToolResultForCodex(
      registry,
      "bash",
      { script: "value=$(js-exec -c 'console.log(42)')\nprintf '%s\\n' \"$value\"" },
      bashOutput({ stderr: "syntax error near unexpected token `('", exit_code: 1 }),
      "bash-command-substitution",
    );
    expect(JSON.stringify(commandSubstitutionHint)).toContain("Avoid just-bash command/process substitution");
    expect(JSON.stringify(commandSubstitutionHint)).toContain("temp files");

    const curlHint = await formatBotToolResultForCodex(
      registry,
      "bash",
      { script: "curl -s http://127.0.0.1/secret" },
      bashOutput({ exit_code: 1 }),
      "bash-curl",
    );
    expect(JSON.stringify(curlHint)).toContain("public internet URLs");

    const pipefailHint = await formatBotToolResultForCodex(
      registry,
      "bash",
      { script: "set -o pipefail\nprintf ok" },
      bashOutput({ stderr: "set: pipefail: invalid option", exit_code: 1 }),
      "bash-pipefail",
    );
    expect(JSON.stringify(pipefailHint)).toContain("without set -o pipefail");

    const rawExtractHint = await formatBotToolResultForCodex(
      registry,
      "web_extract",
      { urls: ["https://api.pi.delivery/v1/pi?start=0&numberOfDigits=2"] },
      {
        results: [],
        failed_results: [{ url: "https://api.pi.delivery/v1/pi?start=0&numberOfDigits=2", error: "no readable content" }],
      },
      "extract-api",
    );
    expect(JSON.stringify(rawExtractHint)).toContain("Use bash with curl -fsSL");

    const readablePage = await formatBotToolResultForCodex(
      registry,
      "web_extract",
      { urls: ["https://example.com/article"] },
      { results: [{ url: "https://example.com/article", content: "readable page text" }], failed_results: [] },
      "extract-page",
    );
    expect(JSON.stringify(readablePage)).not.toContain("model_hint");
  });

  it("lets bash process outputs from thread, message, file, and web tools", async () => {
    tavilyMock.extract.mockResolvedValue({
      results: [
        {
          url: "https://example.com/data",
          rawContent: "web_metric,42\nstatus,ok",
        },
      ],
      failedResults: [],
    });
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-bash-compose-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot, FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 79, firstName: "BashCompose", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "THREAD_JSON_MARKER says thread metric is 11." },
      textPlain: "THREAD_JSON_MARKER says thread metric is 11.",
    });
    const attached = await attachFile({
      repos,
      config,
      userId: user.tg_id,
      threadId: thread.id,
      name: "metrics.txt",
      mime: "text/plain",
      bytes: Buffer.from("FILE_METRIC_17 appears in this attached file.\nSecond line."),
      telegramFileId: "telegram-compose-file-id",
    });
    const tools = buildTools({
      config,
      db,
      repos,
      user,
      thread,
      embedder: { embed: async (texts) => texts.map(() => new Float32Array([1, 0])) },
    });
    const searchThread = tools.search_thread as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ kind: string; message_id?: number; snippet?: string }> }>;
    };
    const loadMessage = tools.load_message as unknown as {
      execute(input: unknown): Promise<{ text?: string }>;
    };
    const searchInFile = tools.search_in_file as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ chunk_index?: number; snippet?: string }> }>;
    };
    const readFileSection = tools.read_file_section as unknown as {
      execute(input: unknown): Promise<{ content?: string }>;
    };
    const webExtract = tools.web_extract as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ content: string }> }>;
    };
    const bash = bashTool(tools);

    const threadHits = await searchThread.execute({ query: "THREAD_JSON_MARKER", limit: 5 });
    const loaded = await loadMessage.execute({ message_id: message.id });
    const fileHits = await searchInFile.execute({ file_id: attached.fileId, query: "FILE_METRIC_17", limit: 5 });
    const fileSection = await readFileSection.execute({ file_id: attached.fileId, chunk_index: fileHits.results[0]!.chunk_index, count: 1 });
    const web = await webExtract.execute({
      urls: ["https://example.com/data"],
      chunks_per_source: 1,
      extract_depth: "basic",
      format: "text",
      include_images: false,
      include_favicon: false,
      max_chars_per_url: 1000,
    });

    const processed = await bash.execute({
      stdin: JSON.stringify({ threadHits, loaded, fileSection, web }),
      script: [
        "cat > combined.json",
        "jq -r '.threadHits.results[0].snippet' combined.json | grep THREAD_JSON_MARKER",
        "jq -r '.loaded.text' combined.json | grep 'metric is 11'",
        "jq -r '.fileSection.content' combined.json | grep FILE_METRIC_17",
        "jq -r '.web.results[0].content' combined.json | grep web_metric",
        "jq -r '[.loaded.text, .fileSection.content, .web.results[0].content] | join(\"\\n\")' combined.json > combined.txt",
        "wc -l combined.txt",
      ].join("\n"),
    });

    expect(processed).toMatchObject({ exit_code: 0, timed_out: false });
    expect(processed.stdout).toContain("THREAD_JSON_MARKER");
    expect(processed.stdout).toContain("metric is 11");
    expect(processed.stdout).toContain("FILE_METRIC_17");
    expect(processed.stdout).toContain("web_metric,42");
    expect(processed.stdout).toMatch(/\b[3-9]\b/);

    const persisted = await bash.execute({ script: "grep -E 'FILE_METRIC_17|web_metric' combined.txt" });
    expect(persisted).toMatchObject({ exit_code: 0, timed_out: false });
    expect(persisted.stdout).toContain("FILE_METRIC_17");
    expect(persisted.stdout).toContain("web_metric,42");
  }, 30_000);

  it("queues supported and safe unsupported files from the thread bash workspace for Telegram delivery", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-create-file-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot });
    const user = await repos.users.ensure({ tgId: 81, firstName: "CreateFile", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const threadRoot = path.join(workspaceRoot, `thread-${thread.id}`);
    await fs.mkdir(threadRoot, { recursive: true });
    await fs.writeFile(path.join(threadRoot, "answer.txt"), "created text file");
    await fs.writeFile(path.join(threadRoot, "table.csv"), "name,value\nalpha,42\n");
    await fs.writeFile(path.join(threadRoot, "script.ps1"), "Write-Output 'safe script'\n");
    await fs.writeFile(path.join(threadRoot, "archive.zip"), "not actually a compiled executable");
    await fs.writeFile(path.join(threadRoot, "legacy.doc"), "legacy document attachment");
    const createdFiles: Array<{ fileId: number; name: string; type: string; caption?: string | null }> = [];
    const registry = buildToolRegistry({ config, db, repos, user, thread, createdFiles: createdFiles as never });

    const textResult = await registry.create_file.execute({
      path: "/answer.txt",
      caption: "Generated notes",
    }) as { file_id?: number; name?: string; type?: string; size?: number; caption?: string | null; error?: string };
    const csvResult = await registry.create_file.execute({
      path: "/table.csv",
      name: "renamed.csv",
      mime: "text/csv",
    }) as { file_id?: number; name?: string; type?: string; error?: string };
    const scriptResult = await registry.create_file.execute({
      path: "/script.ps1",
    }) as { file_id?: number; name?: string; type?: string; error?: string };
    const zipResult = await registry.create_file.execute({
      path: "/archive.zip",
    }) as { file_id?: number; name?: string; type?: string; error?: string };
    const legacyDocResult = await registry.create_file.execute({
      path: "/legacy.doc",
    }) as { file_id?: number; name?: string; type?: string; error?: string };

    expect(textResult).toMatchObject({
      name: "answer.txt",
      type: "txt",
      size: "created text file".length,
      caption: "Generated notes",
      status: "1 file attached (1/10 used)",
      attached_files_used: 1,
      attached_files_limit: MAX_CREATED_FILES_PER_ANSWER,
    });
    expect(csvResult).toMatchObject({ name: "renamed.csv", type: "csv", status: "1 file attached (2/10 used)" });
    expect(scriptResult).toMatchObject({ name: "script.ps1", type: "other", status: "1 file attached (3/10 used)" });
    expect(zipResult).toMatchObject({ name: "archive.zip", type: "other", status: "1 file attached (4/10 used)" });
    expect(legacyDocResult).toMatchObject({ name: "legacy.doc", type: "other", status: "1 file attached (5/10 used)" });
    expect(createdFiles.map((file) => [file.name, file.type])).toEqual([
      ["answer.txt", "txt"],
      ["renamed.csv", "csv"],
      ["script.ps1", "other"],
      ["archive.zip", "other"],
      ["legacy.doc", "other"],
    ]);
    await expect(repos.files.get(textResult.file_id!)).resolves.toMatchObject({
      name: "answer.txt",
      type: "txt",
      content_md: "created text file",
    });
    await expect(repos.files.get(csvResult.file_id!)).resolves.toMatchObject({
      name: "renamed.csv",
      type: "csv",
    });
    await expect(repos.files.get(scriptResult.file_id!)).resolves.toMatchObject({
      name: "script.ps1",
      type: "other",
      content_md: null,
    });
    await expect(fs.readFile((await repos.files.get(zipResult.file_id!))!.path, "utf8")).resolves.toBe("not actually a compiled executable");
  });

  it("rejects create_file after 10 queued files without storing the extra file", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-create-file-limit-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot });
    const user = await repos.users.ensure({ tgId: 84, firstName: "CreateFileLimit", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const threadRoot = path.join(workspaceRoot, `thread-${thread.id}`);
    await fs.mkdir(threadRoot, { recursive: true });
    for (let index = 1; index <= MAX_CREATED_FILES_PER_ANSWER + 1; index += 1) {
      await fs.writeFile(path.join(threadRoot, `file-${index}.dat`), `safe generic file ${index}`);
    }
    const createdFiles: Array<{ fileId: number; name: string; type: string }> = [];
    const registry = buildToolRegistry({ config, db, repos, user, thread, createdFiles: createdFiles as never });

    let lastAccepted: { status?: string; attached_files_used?: number } | undefined;
    for (let index = 1; index <= MAX_CREATED_FILES_PER_ANSWER; index += 1) {
      lastAccepted = await registry.create_file.execute({ path: `/file-${index}.dat` }) as typeof lastAccepted;
    }
    const rejected = await registry.create_file.execute({ path: `/file-${MAX_CREATED_FILES_PER_ANSWER + 1}.dat` }) as { error?: string };

    expect(lastAccepted).toMatchObject({
      status: `1 file attached (${MAX_CREATED_FILES_PER_ANSWER}/${MAX_CREATED_FILES_PER_ANSWER} used)`,
      attached_files_used: MAX_CREATED_FILES_PER_ANSWER,
    });
    expect(rejected).toMatchObject({
      error: expect.stringContaining("File limit reached: 10 files are already attached to this answer"),
    });
    expect(rejected.error).toContain("Do not try to attach more files in this answer");
    expect(createdFiles).toHaveLength(MAX_CREATED_FILES_PER_ANSWER);
    expect(createdFiles.map((file) => file.name)).not.toContain(`file-${MAX_CREATED_FILES_PER_ANSWER + 1}.dat`);
    const files = await repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(MAX_CREATED_FILES_PER_ANSWER);
    expect(files.map((file) => file.name)).not.toContain(`file-${MAX_CREATED_FILES_PER_ANSWER + 1}.dat`);
  });

  it("queues supported document files as generic attachments when extraction fails", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-create-file-doc-fallback-"));
    tempDirs.push(workspaceRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot });
    const user = await repos.users.ensure({ tgId: 83, firstName: "CreateDocFallback", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const threadRoot = path.join(workspaceRoot, `thread-${thread.id}`);
    await fs.mkdir(threadRoot, { recursive: true });
    const bytes = Buffer.from("fake docx bytes that docling cannot convert");
    await fs.writeFile(path.join(threadRoot, "draft.docx"), bytes);
    const createdFiles: Array<{ fileId: number; name: string; type: string }> = [];
    const registry = buildToolRegistry({ config, db, repos, user, thread, createdFiles: createdFiles as never });

    const result = await withMockFetch(async () => new Response("docling down", { status: 500 }), async () => registry.create_file.execute({
      path: "/draft.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })) as { file_id?: number; name?: string; type?: string; status?: string; error?: string };

    expect(result).toMatchObject({ name: "draft.docx", type: "other", status: "1 file attached (1/10 used)" });
    expect(createdFiles).toMatchObject([{ name: "draft.docx", type: "other" }]);
    const stored = await repos.files.get(result.file_id!);
    expect(stored).toMatchObject({ name: "draft.docx", type: "other", content_md: null });
    await expect(fs.readFile(stored!.path)).resolves.toEqual(bytes);
  });

  it("rejects invalid outbound file paths and compiled generated files", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-create-file-guard-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-create-file-outside-"));
    tempDirs.push(workspaceRoot, outsideRoot);
    const config = loadTestConfig({ BASH_WORKSPACE_ROOT: workspaceRoot });
    const user = await repos.users.ensure({ tgId: 82, firstName: "CreateGuard", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const threadRoot = path.join(workspaceRoot, `thread-${thread.id}`);
    await fs.mkdir(threadRoot, { recursive: true });
    await fs.writeFile(path.join(threadRoot, "app.exe"), "plain text but executable extension");
    await fs.writeFile(path.join(threadRoot, "lib.so"), "plain text but shared library extension");
    await fs.writeFile(path.join(threadRoot, "renamed.txt"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]));
    await fs.writeFile(path.join(threadRoot, "mime-blocked.dat"), "blocked by MIME");
    await fs.writeFile(path.join(outsideRoot, "outside.txt"), "outside");
    await fs.symlink(path.join(outsideRoot, "outside.txt"), path.join(threadRoot, "escape.txt"));
    const bigPath = path.join(threadRoot, "big.txt");
    await fs.writeFile(bigPath, "");
    await fs.truncate(bigPath, MAX_FILE_BYTES + 1);
    const createdFiles: unknown[] = [];
    const registry = buildToolRegistry({ config, db, repos, user, thread, createdFiles: createdFiles as never });

    await expect(registry.create_file.execute({ path: "/missing.txt" })).resolves.toMatchObject({ error: expect.stringContaining("file not found") });
    await expect(registry.create_file.execute({ path: "/app.exe" })).resolves.toMatchObject({ error: expect.stringContaining("blocked executable file type") });
    await expect(registry.create_file.execute({ path: "/lib.so" })).resolves.toMatchObject({ error: expect.stringContaining("blocked executable file type") });
    await expect(registry.create_file.execute({ path: "/renamed.txt" })).resolves.toMatchObject({ error: expect.stringContaining("blocked compiled executable") });
    await expect(registry.create_file.execute({ path: "/mime-blocked.dat", mime: "application/x-msdownload" })).resolves.toMatchObject({
      error: expect.stringContaining("blocked executable MIME type"),
    });
    await expect(registry.create_file.execute({ path: "/big.txt" })).resolves.toMatchObject({ error: expect.stringContaining("larger than 20 MB") });
    await expect(registry.create_file.execute({ path: "/escape.txt" })).resolves.toMatchObject({ error: expect.stringContaining("escapes") });
    expect(createdFiles).toHaveLength(0);
    const files = await repos.files.listForThreads([thread.id]);
    expect(files).toHaveLength(0);
  });

  it("searches file chunks with stored embeddings when FTS has no lexical match", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 71, firstName: "Tool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      type: "txt",
      name: "semantic.txt",
      path: "data/files/semantic.txt",
      size: 12,
      summary: "semantic file",
      isInline: false,
    });
    const chunk = await repos.files.insertChunk({
      fileId: file.id,
      idx: 0,
      headingPath: "Intro",
      content: "lexical content without the query words",
    });
    await repos.files.setOutline(file.id, [{ chunk_index: 0, heading_path: "Intro" }]);
    await repos.embeddings.upsert("chunk", chunk.id, new Float32Array([1, 0]));
    const tools = buildTools({
      config,
      db,
      repos,
      user,
      thread,
      embedder: { embed: async () => [new Float32Array([1, 0])] },
    });

    const searchInFile = tools.search_in_file as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ chunk_index?: number; heading_path?: string }> }>;
    };
    const result = await searchInFile.execute({
      file_id: file.id,
      query: "semantic-only",
      limit: 5,
    });

    expect(result.results[0]?.chunk_index).toBe(0);
    expect(result.results[0]).toMatchObject({ heading_path: "Intro" });
    const readFileSection = tools.read_file_section as unknown as {
      execute(input: unknown): Promise<{ outline: Array<{ chunk_index: number; heading_path: string }> }>;
    };
    const outline = await readFileSection.execute({ file_id: file.id, chunk_index: -1 });
    expect(outline.outline[0]).toEqual({ chunk_index: 0, heading_path: "Intro" });
  });

  it("returns message metadata from search_thread results", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 73, firstName: "ThreadTool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      content: { text: "alpha searchable detail" },
      textPlain: "alpha searchable detail",
    });
    const tools = buildTools({
      config,
      db,
      repos,
      user,
      thread,
      embedder: { embed: async () => [new Float32Array([1, 0])] },
    });
    const searchThread = tools.search_thread as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ kind: string; message_id?: number; role?: string; date_iso?: string }> }>;
    };

    const result = await searchThread.execute({ query: "alpha", limit: 5 });

    expect(result.results[0]).toMatchObject({ kind: "message", message_id: message.id, role: "user" });
    expect(result.results[0]?.date_iso).toContain("T");
  });

  it("returns attached image metadata from load_message", async () => {
    const config = loadTestConfig();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-tool-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "whiteboard.jpg");
    await fs.writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
    const user = await repos.users.ensure({ tgId: 72, firstName: "ImageTool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "image",
      content: { text: "[image #1: whiteboard]" },
      textPlain: "[image: whiteboard]",
    });
    const file = await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "image",
      telegramFileId: "telegram-image-1",
      name: "whiteboard.jpg",
      path: imagePath,
      size: 4,
      summary: "[image: whiteboard]",
      isInline: true,
    });
    const tools = buildTools({ config, db, repos, user, thread });
    const loadMessage = tools.load_message as unknown as {
      execute(input: unknown): Promise<{ kind: string; images: Array<{ file_id: number; path: string; note: string }> }>;
      toModelOutput(input: unknown): Promise<{ type: string; value: Array<{ type: string; data?: string; mediaType?: string }> }>;
    };

    const result = await loadMessage.execute({ message_id: message.id });

    expect(result.kind).toBe("image");
    expect(result.images[0]).toMatchObject({
      file_id: file.id,
      path: imagePath,
    });
    expect(result.images[0]?.note).toContain("image bytes");
    const modelOutput = await loadMessage.toModelOutput({
      toolCallId: "call-1",
      input: { message_id: message.id },
      output: result,
    });
    expect(modelOutput.type).toBe("content");
    expect(modelOutput.value.some((part) => part.type === "image-data" && part.data === Buffer.from([1, 2, 3, 4]).toString("base64") && part.mediaType === "image/jpeg")).toBe(true);
  });

  it("redownloads a Telegram image when the local cache is missing", async () => {
    const config = loadTestConfig();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-tool-redownload-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "missing-cache.jpg");
    const user = await repos.users.ensure({ tgId: 74, firstName: "RedownloadTool", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const message = await repos.messages.insert({
      threadId: thread.id,
      role: "user",
      kind: "image",
      content: { text: "[image #1: cached image]" },
      textPlain: "[image: cached image]",
    });
    await repos.files.insertFile({
      userId: user.tg_id,
      threadId: thread.id,
      messageId: message.id,
      type: "image",
      telegramFileId: "telegram-cache-file-id",
      name: "missing-cache.jpg",
      path: imagePath,
      size: 3,
      summary: "[image: cached image]",
      isInline: true,
    });
    const redownloaded = Buffer.from([7, 8, 9]);
    const seenTelegramIds: Array<string | null> = [];
    const tools = buildTools({
      config,
      db,
      repos,
      user,
      thread,
      redownloadFile: async (file) => {
        seenTelegramIds.push(file.telegram_file_id);
        return redownloaded;
      },
    });
    const loadMessage = tools.load_message as unknown as {
      execute(input: unknown): Promise<unknown>;
      toModelOutput(input: unknown): Promise<{ type: string; value: Array<{ type: string; data?: string }> }>;
    };

    const result = await loadMessage.execute({ message_id: message.id });
    const modelOutput = await loadMessage.toModelOutput({ toolCallId: "call-1", input: { message_id: message.id }, output: result });

    expect(seenTelegramIds).toEqual(["telegram-cache-file-id"]);
    expect(modelOutput.value.some((part) => part.type === "image-data" && part.data === redownloaded.toString("base64"))).toBe(true);
    await expect(fs.readFile(imagePath)).resolves.toEqual(redownloaded);
  });

  it("queues generated images as photo attachments using configured image model, quality, and references", async () => {
    const bytes = pngBytes();
    const config = loadTestConfig({
      CODEX_IMAGE_MODEL: "gpt-image-2-test",
      CODEX_IMAGE_QUALITY: "low",
    });
    const user = await repos.users.ensure({ tgId: 86, firstName: "GenerateImage", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const reference = await attachFile({
      repos,
      config,
      userId: user.tg_id,
      threadId: thread.id,
      name: "reference.png",
      mime: "image/png",
      bytes,
      telegramFileId: "telegram-reference-image",
      imageSummary: "reference image",
    });
    const createdFiles: CreatedFileAttachment[] = [];
    let request: Parameters<BotImageGenerator>[0] | undefined;
    const imageGenerator: BotImageGenerator = async (input) => {
      request = input;
      return {
        imageBase64: bytes.toString("base64"),
        revisedPrompt: "A clean generated test image.",
        mediaType: "image/png",
      };
    };
    const registry = buildToolRegistry({
      config,
      db,
      repos,
      user,
      thread,
      createdFiles,
      imageGenerator,
    });

    const result = await registry.generate_image.execute({
      prompt: "  make the reference image softer  ",
      reference_file_ids: [reference.fileId],
      mode: "edit",
      size: "1024x1024",
      caption: "Generated preview",
    }) as {
      file_id?: number;
      name?: string;
      type?: string;
      caption?: string | null;
      terminal?: boolean;
      generated_image?: boolean;
      model?: string;
      quality?: string;
      requested_size?: string;
      mode?: string;
      reference_file_ids?: number[];
      revised_prompt?: string | null;
      status?: string;
      error?: string;
    };

    expect(result).toMatchObject({
      name: "generated-image.png",
      type: "image",
      caption: "Generated preview",
      terminal: true,
      generated_image: true,
      model: "gpt-image-2-test",
      quality: "low",
      requested_size: "1024x1024",
      mode: "edit",
      reference_file_ids: [reference.fileId],
      revised_prompt: "A clean generated test image.",
      status: "1 image generated (1/10 files used)",
    });
    expect(request).toMatchObject({
      prompt: "make the reference image softer",
      model: "gpt-image-2-test",
      quality: "low",
      size: "1024x1024",
      mode: "edit",
      references: [{
        fileId: reference.fileId,
        name: "reference.png",
        path: reference.file.path,
        mimeType: "image/png",
      }],
    });
    expect(createdFiles).toHaveLength(1);
    expect(createdFiles[0]).toMatchObject({
      fileId: result.file_id,
      type: "image",
      name: "generated-image.png",
      delivery: "photo",
      origin: "generated_image",
      caption: "Generated preview",
      inline: true,
    });
    const stored = await repos.files.get(result.file_id!);
    expect(stored).toMatchObject({
      type: "image",
      name: "generated-image.png",
      summary: "A clean generated test image.",
      is_inline: 1,
    });
    await expect(fs.readFile(stored!.path)).resolves.toEqual(bytes);
  });

  it("rejects generate_image references that are not images in the current thread", async () => {
    const config = loadTestConfig();
    const user = await repos.users.ensure({ tgId: 87, firstName: "ImageReferences", lang: "en" });
    const thread = await repos.threads.activeForUserTopic(user.tg_id, null);
    const otherThread = await repos.threads.activeForUserTopic(user.tg_id, 870, "Other image thread");
    const sameThreadText = await attachFile({
      repos,
      config,
      userId: user.tg_id,
      threadId: thread.id,
      name: "notes.txt",
      mime: "text/plain",
      bytes: Buffer.from("not an image"),
      telegramFileId: "telegram-notes-file",
    });
    const otherImage = await attachFile({
      repos,
      config,
      userId: user.tg_id,
      threadId: otherThread.id,
      name: "other.png",
      mime: "image/png",
      bytes: pngBytes(),
      telegramFileId: "telegram-other-image",
      imageSummary: "other thread image",
    });
    const registry = buildToolRegistry({
      config,
      db,
      repos,
      user,
      thread,
      createdFiles: [],
      imageGenerator: async () => ({ imageBase64: pngBytes().toString("base64") }),
    });

    await expect(registry.generate_image.execute({
      prompt: "edit this",
      reference_file_ids: [sameThreadText.fileId],
      mode: "edit",
    })).resolves.toMatchObject({ error: expect.stringContaining("not an image") });
    await expect(registry.generate_image.execute({
      prompt: "edit other",
      reference_file_ids: [otherImage.fileId],
      mode: "edit",
    })).resolves.toMatchObject({ error: expect.stringContaining("was not found in this thread") });
    await expect(registry.generate_image.execute({
      prompt: "edit missing",
      mode: "edit",
    })).resolves.toMatchObject({ error: expect.stringContaining("mode edit requires at least one reference_file_id") });
  });

  it("retrieves multiple compacted file types from a forked thread", async () => {
    const inlineConfig = loadTestConfig({ FILE_INLINE_TOKENS: 1000 });
    const searchableConfig = loadTestConfig({ FILE_INLINE_TOKENS: 1 });
    const user = await repos.users.ensure({ tgId: 75, firstName: "MultiFile", lang: "en" });
    const parent = await repos.threads.activeForUserTopic(user.tg_id, null, "Compacted mixed files");

    const inlineNote = await attachFile({
      repos,
      config: inlineConfig,
      userId: user.tg_id,
      threadId: parent.id,
      name: "small-notes.txt",
      mime: "text/plain",
      bytes: Buffer.from("INLINE-CODE-ALPHA says the release color is blue."),
      telegramFileId: "telegram-small-note-id",
    });
    const csv = await attachFile({
      repos,
      config: searchableConfig,
      userId: user.tg_id,
      threadId: parent.id,
      name: "large-table.csv",
      mime: "text/csv",
      bytes: Buffer.from(
        [
          "id,name,detail",
          ...Array.from({ length: 40 }, (_, index) =>
            `${index},row-${index},${index === 27 ? "CSV_TARGET_SPROCKET requires review" : "ordinary row"}`,
          ),
        ].join("\n"),
      ),
      telegramFileId: "telegram-csv-id",
    });
    const pdf = await attachFile({
      repos,
      config: searchableConfig,
      userId: user.tg_id,
      threadId: parent.id,
      name: "book-section.pdf",
      mime: "application/pdf",
      bytes: makePdf(
        "The compacted book section says SODIUM ORBIT 42 is the retrieval marker for the lifecycle chapter. ".repeat(12),
      ),
      telegramFileId: "telegram-pdf-id",
    });
    const image = await attachFile({
      repos,
      config: searchableConfig,
      userId: user.tg_id,
      threadId: parent.id,
      name: "whiteboard.jpg",
      mime: "image/jpeg",
      bytes: Buffer.from([1, 3, 5, 7]),
      telegramFileId: "telegram-image-id",
      imageSummary: "whiteboard cache marker diagram",
    });

    for (let i = 0; i < 12; i += 1) {
      await repos.messages.insert({
        threadId: parent.id,
        role: i % 2 ? "assistant" : "user",
        content: { text: `compaction filler ${i}` },
        textPlain: `compaction filler ${i}`,
      });
    }
    const compaction = await compactThread(repos, parent, { recentWindowMessages: 1 });
    const compactedParent = (await repos.threads.get(parent.id)) ?? parent;
    const forkPoint = await repos.messages.latest(compactedParent.id);
    const fork = await repos.threads.create({
      userId: user.tg_id,
      topicId: 909,
      title: "Forked mixed files",
      parentThreadId: compactedParent.id,
      forkPointMessageId: forkPoint?.id ?? null,
    });

    const scope = await threadChainScope(repos, fork);
    expect(compaction.count).toBeGreaterThanOrEqual(10);
    expect(new Set(scope.fileIds)).toEqual(new Set([inlineNote.fileId, csv.fileId, pdf.fileId, image.fileId]));
    const visibleRows = await repos.messages.listForThreadChain(await repos.threads.chain(fork));
    expect(visibleRows.map((row) => row.id)).not.toContain(pdf.messageId);

    const redownloadedImage = Buffer.from([9, 8, 7, 6]);
    const redownloads: string[] = [];
    const tools = buildTools({
      config: searchableConfig,
      db,
      repos,
      user,
      thread: fork,
      embedder: { embed: async (texts) => texts.map(() => new Float32Array([1, 0])) },
      redownloadFile: async (file) => {
        redownloads.push(file.telegram_file_id ?? "");
        return redownloadedImage;
      },
    });
    const searchInFile = tools.search_in_file as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ chunk_index?: number; snippet?: string }> }>;
    };
    const readFileSection = tools.read_file_section as unknown as {
      execute(input: unknown): Promise<{ content?: string; outline?: unknown }>;
    };
    const searchThread = tools.search_thread as unknown as {
      execute(input: unknown): Promise<{ results: Array<{ kind: string; message_id?: number; snippet?: string }> }>;
    };
    const loadMessage = tools.load_message as unknown as {
      execute(input: unknown): Promise<{
        text?: string;
        files?: Array<{ file_id: number; inline: boolean; type: string }>;
        images?: Array<{ file_id: number; path: string; telegram_file_id?: string | null }>;
      }>;
      toModelOutput(input: unknown): Promise<{ type: string; value: Array<{ type: string; data?: string }> }>;
    };

    await fs.rm(pdf.file.path, { force: true });
    const pdfHits = await searchInFile.execute({ file_id: pdf.fileId, query: "SODIUM ORBIT 42", limit: 5 });
    expect(pdfHits.results[0]?.chunk_index).toEqual(expect.any(Number));
    const pdfSection = await readFileSection.execute({ file_id: pdf.fileId, chunk_index: pdfHits.results[0]!.chunk_index, count: 2 });
    expect(pdfSection.content).toMatch(/SODIUM ORBIT 42/);

    const csvHits = await searchInFile.execute({ file_id: csv.fileId, query: "CSV_TARGET_SPROCKET", limit: 5 });
    expect(csvHits.results[0]?.chunk_index).toEqual(expect.any(Number));
    const csvSection = await readFileSection.execute({ file_id: csv.fileId, chunk_index: csvHits.results[0]!.chunk_index, count: 1 });
    expect(csvSection.content).toContain("CSV_TARGET_SPROCKET");

    const inlineHits = await searchThread.execute({ query: "INLINE-CODE-ALPHA", limit: 10 });
    const inlineMessageId = inlineHits.results.find((hit) => hit.kind === "message")?.message_id;
    expect(inlineMessageId).toBe(inlineNote.messageId);
    const inlineLoaded = await loadMessage.execute({ message_id: inlineNote.messageId });
    expect(inlineLoaded.text).toContain("INLINE-CODE-ALPHA");
    expect(inlineLoaded.files?.[0]).toMatchObject({ file_id: inlineNote.fileId, inline: true, type: "txt" });

    const imageHits = await searchThread.execute({ query: "whiteboard cache marker", limit: 10 });
    const imageMessageId = imageHits.results.find((hit) => hit.kind === "message")?.message_id;
    expect(imageMessageId).toBe(image.messageId);
    await fs.rm(image.file.path, { force: true });
    const imageLoaded = await loadMessage.execute({ message_id: image.messageId });
    expect(imageLoaded.images?.[0]).toMatchObject({ file_id: image.fileId });
    const imageOutput = await loadMessage.toModelOutput({ toolCallId: "call-image", input: {}, output: imageLoaded });
    expect(redownloads).toEqual(["telegram-image-id"]);
    expect(imageOutput.value.some((part) => part.type === "image-data" && part.data === redownloadedImage.toString("base64"))).toBe(true);
    await expect(fs.readFile(image.file.path)).resolves.toEqual(redownloadedImage);
  }, 30_000);
});

type BashToolForTests = {
  execute(input: unknown): Promise<{
    stdout: string;
    stderr: string;
    exit_code: number | null;
    timed_out: boolean;
    stdout_truncated: boolean;
    stderr_truncated: boolean;
    cwd: string;
    error?: string;
  }>;
};

function bashTool(tools: ReturnType<typeof buildTools>): BashToolForTests {
  return tools.bash as unknown as BashToolForTests;
}

function bashOutput(overrides: Partial<Awaited<ReturnType<BashToolForTests["execute"]>>> = {}): Awaited<ReturnType<BashToolForTests["execute"]>> {
  return {
    stdout: "",
    stderr: "",
    exit_code: 0,
    timed_out: false,
    stdout_truncated: false,
    stderr_truncated: false,
    cwd: "/",
    ...overrides,
  };
}

function pngBytes(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axw7NAAAAAASUVORK5CYII=",
    "base64",
  );
}

async function withMockFetch<T>(mockFetch: typeof globalThis.fetch, action: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function attachFile(input: {
  repos: Repos;
  config: ReturnType<typeof loadTestConfig>;
  userId: number;
  threadId: number;
  name: string;
  mime: string;
  bytes: Buffer;
  telegramFileId: string;
  imageSummary?: string;
}): Promise<{ fileId: number; messageId: number; file: NonNullable<Awaited<ReturnType<Repos["files"]["get"]>>> }> {
  const ingested = await ingestFileBytes({
    config: input.config,
    repo: input.repos.files,
    userId: input.userId,
    threadId: input.threadId,
    telegramFileId: input.telegramFileId,
    bytes: input.bytes,
    name: input.name,
    mime: input.mime,
    imageSummary: input.imageSummary,
  });
  const message = await input.repos.messages.insert({
    threadId: input.threadId,
    role: "user",
    kind: ingested.type === "image" ? "image" : "file",
    content: { text: ingested.card },
    textPlain: ingested.card,
  });
  await input.repos.files.setMessageId(ingested.fileId, message.id);
  const file = await input.repos.files.get(ingested.fileId);
  if (!file) throw new Error(`file not found after ingest: ${ingested.fileId}`);
  return { fileId: ingested.fileId, messageId: message.id, file };
}

function makePdf(text: string): Buffer {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 80) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  const textOps = lines.map((value, index) => `${index === 0 ? "" : "T*\n"}(${escapePdfText(value)}) Tj`).join("\n");
  const stream = `BT\n/F1 12 Tf\n14 TL\n72 720 Td\n${textOps}\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
