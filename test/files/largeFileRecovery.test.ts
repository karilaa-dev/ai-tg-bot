import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InputFile } from "grammy";
import { sendFinal } from "../../src/ai/responseDelivery.js";
import type { TurnInput } from "../../src/ai/types.js";
import { e2bFileSource } from "../../src/e2b/fileSource.js";
import { sha256Hex } from "../../src/files/hash.js";
import { TG_DOWNLOAD_MAX_BYTES } from "../../src/files/limits.js";
import { OutgoingBuffers } from "../../src/files/outgoingBuffers.js";
import type { CreatedFileAttachment } from "../../src/files/types.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";

let env: GrammyEmulator;
let input: TurnInput;
let large: CreatedFileAttachment;
let healthy: CreatedFileAttachment;
let buffers: OutgoingBuffers;
let sends: string[];
let uploads: string[];
let turnId: number;

beforeEach(async () => {
  env = await createGrammyEmulator();
  const user = await env.repos.users.ensure({ tgId: env.user.id });
  const thread = await env.repos.threads.activeForUserTopic(user.tg_id, null);
  const accepted = await env.repos.turnRuns.accept({ userId: user.tg_id, threadId: thread.id, chatId: user.tg_id,
    messageThreadId: null, locale: "en", kind: "text", textPlain: "Make files", content: {}, sources: [{ updateId: 800, messageId: 800 }] });
  turnId = accepted.turnRun.id;
  await env.repos.turnRuns.claimRunning(turnId, "large-file-recovery", Date.now() + 60_000);
  const stored = await env.repos.files.insertFile({ userId: user.tg_id, threadId: thread.id,
    type: "other", name: "large.bin", size: TG_DOWNLOAD_MAX_BYTES + 1, isInline: false, requireMessage: true });
  await env.repos.files.rememberSource(stored.id, e2bFileSource(env.config, {
    fileId: stored.id, userId: user.tg_id, threadId: thread.id, sandboxId: "expired",
    sourceCanonicalPath: `/home/user/file-sources/${"a".repeat(64)}`, size: stored.size, contentSha256: "a".repeat(64),
  }));
  large = { fileId: stored.id, name: stored.name, size: stored.size, type: "other", inline: false,
    card: "Large file", delivery: "document", origin: "created_file" };
  const bytes = Buffer.from("hello");
  const sibling = await env.repos.files.insertFile({ userId: user.tg_id, threadId: thread.id,
    type: "other", name: "healthy.bin", size: bytes.length, contentSha256: sha256Hex(bytes), isInline: false, requireMessage: true });
  healthy = { fileId: sibling.id, name: sibling.name, size: sibling.size, type: "other", inline: false,
    card: "Healthy file", data: bytes, delivery: "document", origin: "created_file" };
  buffers = new OutgoingBuffers();
  input = { api: env.bot.api, config: env.config, db: env.db, repos: env.repos, logger: env.services.logger,
    user, thread, chatId: user.tg_id, text: "Make files", turnRunId: turnId, t: key => key, outgoingBuffers: buffers,
    resolveFile: vi.fn(async () => { throw new Error("Immutable source unavailable"); }),
    onAwaitingDelivery: async ({ assistantMessageId }) => {
      await env.repos.turnRuns.markAwaitingDelivery(turnId, { resultMessageId: assistantMessageId });
    },
    onDeliveryConfirmed: vi.fn(async ({ assistantMessageId }) => { await env.repos.turnRuns.markSucceeded(turnId, assistantMessageId); }),
  };
  sends = [];
  uploads = [];
  env.bot.api.config.use((previous, method, payload, signal) => {
    if (method.startsWith("send")) sends.push(method);
    if (method === "sendDocument" && "document" in payload && payload.document instanceof InputFile) {
      uploads.push(payload.document.filename ?? "");
    }
    return previous(method, payload, signal);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await buffers?.dispose();
  await env?.dispose();
});

it.each(["source read", "source integrity", "backup registration"])("isolates a large-file %s failure while delivering text and a healthy sibling", async failure => {
  if (failure === "source integrity") {
    input.resolveFile = vi.fn(async () => ({ bytes: Buffer.from("wrong"), size: 5, mimeType: null, contentSha256: "wrong",
      source: { transport: "e2b", connectionKey: env.config.E2B_DEPLOYMENT_ID, remoteKey: "expired", locator: {} } }));
  }
  if (failure === "backup registration") {
    large.data = Buffer.alloc(large.size);
    const rememberSource = env.repos.files.rememberSource.bind(env.repos.files);
    vi.spyOn(env.repos.files, "rememberSource").mockImplementation((id, source) => {
      if (id === large.fileId && source.transport === "local") return Promise.reject(new Error("Backup unavailable"));
      return rememberSource(id, source);
    });
  }
  await sendFinal(input, "", "Here is the answer.", 0, [large, healthy]);
  expect(large.telegramDeliveryFailure).toBe("source_unavailable");
  expect(large.telegramDelivery).toBeUndefined();
  expect(uploads).toEqual(["healthy.bin"]);
  expect(sends.indexOf("sendRichMessage")).toBeGreaterThanOrEqual(0);
  expect(sends.indexOf("sendRichMessage")).toBeLessThan(sends.indexOf("sendDocument"));
  expect(input.resolveFile).toHaveBeenCalledTimes(failure === "backup registration" ? 0 : 1);
  const saved = await env.repos.messages.latest(input.thread.id);
  if (!saved) throw new Error("Missing final answer");
  expect(saved.text_plain).toBe("Here is the answer.");
  expect(JSON.parse(saved.content_json)).toMatchObject({
    files: [{ id: healthy.fileId }], attachment_failures: [{ file_id: large.fileId, status: "source_unavailable" }],
  });
  expect(await env.repos.files.listForMessage(saved.id)).toMatchObject([{ id: healthy.fileId }]);
  expect((await env.repos.turnRuns.get(turnId))?.status).toBe("succeeded");
  expect(input.onDeliveryConfirmed).toHaveBeenCalledOnce();
  expect(buffers.snapshot().bufferedBytes).toBe(0);
});

it.each(["signal", "AbortError"])("propagates %s cancellation during the large-file backup read", async kind => {
  const controller = new AbortController();
  input.signal = controller.signal;
  const error = kind === "signal" ? new Error("Backup cancelled") : new DOMException("Backup cancelled", "AbortError");
  input.resolveFile = vi.fn(async () => {
    if (kind === "signal") controller.abort(error);
    throw error;
  });
  await expect(sendFinal(input, "", "Do not send after cancellation.", 0, [large, healthy])).rejects.toBe(error);
  expect(sends).toEqual([]);
  expect(large.telegramDeliveryFailure).toBeUndefined();
  expect(input.onDeliveryConfirmed).not.toHaveBeenCalled();
  expect(buffers.snapshot().bufferedBytes).toBe(0);
});
