import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrammyError, InputFile } from "grammy";
import { z } from "zod";
import { sendFinalVisible } from "../../src/ai/responseDelivery.js";
import { currentTurnAssistantResult } from "../../src/ai/currentTurnResult.js";
import type { TurnInferenceMetadata, TurnInput } from "../../src/ai/types.js";
import type { MessageRow, ThreadRow } from "../../src/db/types.js";
import { OutgoingFiles } from "../../src/files/outgoingFiles.js";
import { RICH_MESSAGE_CHARACTER_LIMIT } from "../../src/telegram/mdRepair.js";
import { BotChatService } from "../../src/web/chat-service.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { TEST_PNG } from "../helpers/workspaceRuntime.js";

const OPENUI = 'root = Stack([Metric("Total","42","Verified count")])';
const EN_MARKER = "🧩 Interactive visualization available on the website.";
const RU_MARKER = "🧩 Интерактивная визуализация доступна на сайте.";
const REPORT = Buffer.from("name,total\nAlice,42\n");
const richPayload = z.object({ rich_message: z.object({ markdown: z.string() }) });
const environments: GrammyEmulator[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const env of environments.splice(0)) await env.dispose();
});

async function fixture(options: {
  answer?: string;
  inference?: TurnInferenceMetadata;
  publicUrl?: string | null;
  threadOrigin?: ThreadRow["origin"];
  turnOrigin?: TurnInput["origin"];
  placeholder?: boolean;
  files?: boolean;
  cancelled?: boolean;
  richFailure?: "unknown" | "rejected" | "not modified" | "parse";
} = {}) {
  const answer = options.answer ?? "Here is the result.";
  const inference = options.inference ?? { openui: OPENUI };
  const calls: Array<{ method: string; payload: unknown }> = [];
  const initialRows: MessageRow[] = [];
  const fileIds: number[] = [];
  const uploadBytes: Buffer[] = [];
  const pendingHistory: Awaited<ReturnType<BotChatService["history"]>>[] = [];
  const confirmed = vi.fn();
  const unknown = vi.fn();
  const failed = vi.fn();
  let placeholderId: number | undefined;
  let initialRow: Promise<MessageRow | undefined> | undefined;
  let deliveryError: unknown;
  let attempts = 0;
  const env = await createGrammyEmulator({
    privateTopics: true,
    config: { WEB_PUBLIC_URL: options.publicUrl === null ? undefined : options.publicUrl ?? "https://chat.example.com" },
    turnRunner: async originalInput => {
      const input = { ...originalInput, origin: options.turnOrigin ?? originalInput.origin };
      const files = new OutgoingFiles(input);
      try {
        if (options.files) {
          const photo = await files.bytes(async () => ({ bytes: TEST_PNG, name: "photo.png", mime: "image/png", caption: "Original photo caption" }));
          const report = await files.bytes(async () => ({ bytes: REPORT, name: "report.csv", mime: "text/csv", caption: "Original report caption" }));
          fileIds.push(photo.fileId, report.fileId);
        }
        if (options.placeholder) {
          const placeholder = await input.api.sendMessage(input.chatId, "Thinking…", { message_thread_id: input.messageThreadId });
          placeholderId = placeholder.message_id;
          input.telegramPlaceholder = { messageId: placeholderId, state: "pending" };
        }
        if (options.cancelled) input.signal = AbortSignal.abort(new Error("Cancelled before delivery"));
        await sendFinalVisible({ ...input, outgoingBuffers: files.buffers,
          onAwaitingDelivery: async result => {
            const row = await initialRow;
            if (row) initialRows.push(row);
            await input.onAwaitingDelivery?.(result);
            pendingHistory.push(await chat.history(input.user.tg_id, input.thread.id));
          },
          onDeliveryConfirmed: async result => { confirmed(result); await input.onDeliveryConfirmed?.(result); },
          onDeliveryUnknown: async result => { unknown(result); await input.onDeliveryUnknown?.(result); },
          onDeliveryFailed: async result => { failed(result); await input.onDeliveryFailed?.(result); },
        }, "", answer, 0, files.items, "pi-visual-entry", undefined, inference,
        () => { initialRow = input.repos.messages.latest(input.thread.id); });
      } catch (error) {
        deliveryError = error;
        throw error;
      } finally {
        await files.dispose();
      }
    },
  });
  environments.push(env);
  await env.bot.sendCommand(env.user, env.chat, "/start");
  const repository = new ConversationRepository(env.db.db, env.repos, 999);
  const chat = new BotChatService({ services: env.services, repository, api: env.bot.api });
  const thread = options.threadOrigin === "telegram"
    ? await env.repos.threads.create({ userId: env.user.id, topicId: null, title: "Telegram origin" })
    : await chat.createThread(env.user.id, "Web visual");
  env.bot.api.config.use(async (previous, method, payload, signal) => {
    calls.push({ method, payload });
    if (richPayload.safeParse(payload).success) {
      attempts++;
      if (options.richFailure === "unknown") throw new Error("Connection reset after write");
      if (options.richFailure === "parse" || (attempts === 1 && options.richFailure)) {
        const description = options.richFailure === "not modified" ? "Bad Request: message is not modified"
          : options.richFailure === "parse" ? "Bad Request: can't parse rich message"
            : "Forbidden: message edit rejected";
        throw new GrammyError(description, { ok: false, error_code: options.richFailure === "rejected" ? 403 : 400, description }, method, payload);
      }
    }
    if (method === "sendPhoto" || method === "sendDocument") {
      pendingHistory.push(await chat.history(env.user.id, thread.id));
      for (const id of fileIds) {
        expect((await env.repos.files.get(id))?.message_id).toBeTypeOf("number");
        expect((await env.repos.files.listSources(id)).some(source => source.transport === "web")).toBe(true);
      }
      const upload = "photo" in payload ? payload.photo : "document" in payload ? payload.document : undefined;
      if (!(upload instanceof InputFile)) throw new Error("Expected buffered attachment upload.");
      const bytes = await upload.toRaw();
      if (!(bytes instanceof Uint8Array)) throw new Error("Expected attachment bytes.");
      uploadBytes.push(Buffer.from(bytes));
    }
    return previous(method, payload, signal);
  });
  return {
    env, chat, thread, answer, inference, calls, initialRows, fileIds, uploadBytes, pendingHistory, confirmed, unknown, failed,
    placeholderId: () => placeholderId,
    deliveryError: () => deliveryError,
    deliver: () => chat.send(env.user.id, thread.id, { text: "Show the result", requestId: randomUUID() }),
    richCalls: () => calls.flatMap(call => {
      const parsed = richPayload.safeParse(call.payload);
      return parsed.success ? [{ ...call, markdown: parsed.data.rich_message.markdown }] : [];
    }),
    assistant: async () => (await env.repos.messages.listThread(thread.id)).find(message => message.role === "assistant"),
  };
}

describe("web-created visual answers mirrored to Telegram", () => {
  it.each([
    { answer: "Here is the comparison.", language: "en", preference: "ru", marker: EN_MARKER },
    { answer: "Вот сравнение вариантов.", language: "ru", preference: "en", marker: RU_MARKER },
    { answer: "OK", language: "ru", preference: "en", marker: RU_MARKER, explicit: "ru" },
  ] satisfies Array<{ answer: string; language: string; preference: "en" | "ru"; marker: string; explicit?: "ru" }>) (
    "persists clean $language prose and language while mirroring the marker", async scenario => {
      const result = currentTurnAssistantResult([{
        role: "toolResult", toolCallId: "finish", toolName: "finish_response", isError: false, timestamp: 1,
        content: [{ type: "text", text: "completed" }], details: {
          completed: true, text: scenario.answer, openui: OPENUI, ...(scenario.explicit ? { openuiLanguage: scenario.explicit } : {}),
        },
      }]);
      const f = await fixture({ answer: result.text, inference: result });
      await f.chat.updateSettings(f.env.user.id, { language: scenario.preference });
      const before = JSON.stringify(result);
      const sent = await f.deliver();
      expect(f.deliveryError()).toBeUndefined();
      expect(JSON.stringify(result)).toBe(before);
      const assistant = await f.assistant();
      for (const row of [...f.initialRows, assistant]) {
        expect(row).toMatchObject({ text_plain: scenario.answer, pi_entry_id: "pi-visual-entry" });
        expect(JSON.parse(row?.content_json ?? "null")).toEqual({ text: scenario.answer, openui: OPENUI, openuiLanguage: scenario.language });
      }
      expect(f.initialRows).toHaveLength(1);
      const history = await f.chat.history(f.env.user.id, f.thread.id);
      expect(history.messages.at(-1)).toMatchObject({ text: scenario.answer, openui: OPENUI, openuiLanguage: scenario.language });
      const rich = f.richCalls();
      expect(rich).toHaveLength(1);
      expect(rich[0]?.markdown).toBe(`${scenario.answer}\n\n<a href="https://chat.example.com/?thread=${f.thread.id}">${scenario.marker}</a>`);
      expect(rich[0]?.markdown).not.toContain(OPENUI);
      expect(f.confirmed).toHaveBeenCalledOnce();
      expect(f.unknown).not.toHaveBeenCalled();
      expect(f.failed).not.toHaveBeenCalled();
      expect((await f.env.repos.turnRuns.get(sent.turnId))?.status).toBe("succeeded");
    },
  );

  it("derives language from legacy inference metadata without a configured website URL", async () => {
    const f = await fixture({ answer: "Вот краткий ответ.", publicUrl: null });
    await f.deliver();
    expect(f.richCalls()[0]?.markdown).toBe(`${f.answer}\n\n${RU_MARKER}`);
    expect(JSON.parse((await f.assistant())?.content_json ?? "null")).toMatchObject({ openuiLanguage: "ru" });
  });

  it("escapes the configured origin inside the link and targets the current thread", async () => {
    const f = await fixture({ publicUrl: 'https://chat"qa&stage.example:8443/' });
    await f.deliver();
    expect(f.richCalls()[0]?.markdown).toContain(`<a href="https://chat&quot;qa&amp;stage.example:8443/?thread=${f.thread.id}">`);
    expect(f.richCalls()[0]?.markdown).not.toContain('href="https://chat"qa');
  });

  it.each(["web", "telegram"] satisfies ThreadRow["origin"][])("leaves text-only %s-created threads unchanged", async threadOrigin => {
    const f = await fixture({ threadOrigin, inference: { openuiLanguage: "ru" } });
    await f.deliver();
    expect(f.richCalls().map(call => call.markdown)).toEqual([f.answer]);
    expect(JSON.parse((await f.assistant())?.content_json ?? "null")).toEqual({ text: f.answer });
    expect(JSON.parse(f.initialRows[0]?.content_json ?? "null")).toEqual({ text: f.answer });
  });

  it("uses immutable thread origin for a Telegram turn in a web-created thread", async () => {
    const f = await fixture({ turnOrigin: "telegram" });
    await f.deliver();
    expect(f.richCalls()[0]?.markdown).toContain(EN_MARKER);
    expect(f.confirmed).toHaveBeenCalledOnce();
  });

  it.each([
    { threadOrigin: "telegram", inference: { openui: OPENUI }, error: /threads created on the website/u },
    { threadOrigin: "web", inference: { openui: "invalid source" }, error: /OpenUI/u },
  ] satisfies Array<{ threadOrigin: ThreadRow["origin"]; inference: TurnInferenceMetadata; error: RegExp }>) (
    "rejects unadmitted UI before storage or Telegram delivery: $threadOrigin", async scenario => {
      const f = await fixture(scenario);
      await f.deliver();
      expect(f.deliveryError()).toBeInstanceOf(Error);
      expect(String(f.deliveryError())).toMatch(scenario.error);
      expect(await f.assistant()).toBeUndefined();
      expect(f.richCalls()).toEqual([]);
    },
  );

  it("keeps one visible marker after chunking a long answer with an unfinished code fence", async () => {
    const answer = `${"🌳 Results stay intact.\n".repeat(1_800)}\n\`\`\`txt\nlast result`;
    const f = await fixture({ answer });
    await f.deliver();
    const parts = f.richCalls().map(call => call.markdown);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => Array.from(part).length <= RICH_MESSAGE_CHARACTER_LIMIT)).toBe(true);
    expect(parts.join("\n").split(EN_MARKER)).toHaveLength(2);
    expect(parts.at(-1)).toContain("last result\n```\n\n<a href=");
    expect(parts.join("\n").match(/🌳 Results stay intact\./gu)).toHaveLength(1_800);
    expect((await f.assistant())?.text_plain).toBe(answer);
  });

  it.each([undefined, "not modified", "rejected", "unknown"] satisfies Array<"not modified" | "rejected" | "unknown" | undefined>)(
    "keeps the static placeholder replacement rules for %s", async richFailure => {
      const f = await fixture({ placeholder: true, richFailure });
      await f.deliver();
      const edits = f.richCalls().filter(call => call.method === "editMessageText");
      const sends = f.richCalls().filter(call => call.method === "sendRichMessage");
      expect(edits).toHaveLength(1);
      expect(edits[0]?.payload).toMatchObject({ message_id: f.placeholderId() });
      expect(edits[0]?.markdown).toContain(EN_MARKER);
      expect(sends).toHaveLength(richFailure === "rejected" ? 1 : 0);
      if (richFailure === "unknown") {
        expect(f.unknown).toHaveBeenCalledOnce();
        expect(f.confirmed).not.toHaveBeenCalled();
        expect(f.deliveryError()).toBeInstanceOf(Error);
      } else {
        expect(f.confirmed).toHaveBeenCalledOnce();
        expect(f.unknown).not.toHaveBeenCalled();
        if (richFailure !== "rejected") expect((await f.assistant())?.tg_message_id).toBe(f.placeholderId());
      }
      expect(f.failed).not.toHaveBeenCalled();
      expect((await f.assistant())?.text_plain).toBe(f.answer);
    },
  );

  it("retains the marker and thread URL through plain delivery fallback", async () => {
    const f = await fixture({ richFailure: "parse" });
    await f.deliver();
    const fallback = f.calls.filter(call => call.method === "sendMessage").map(call => z.object({ text: z.string() }).parse(call.payload).text)
      .filter(text => text.includes(EN_MARKER));
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toContain(`https://chat.example.com/?thread=${f.thread.id}`);
    expect(fallback[0]?.split(EN_MARKER)).toHaveLength(2);
    expect(f.confirmed).toHaveBeenCalledOnce();
  });

  it("cancels before persistence without sending a marker or running terminal delivery callbacks", async () => {
    const f = await fixture({ cancelled: true });
    await f.deliver();
    expect(String(f.deliveryError())).toContain("Cancelled before delivery");
    expect(await f.assistant()).toBeUndefined();
    expect(f.richCalls()).toEqual([]);
    expect(f.confirmed).not.toHaveBeenCalled();
    expect(f.unknown).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it("preserves photo/file bytes, captions, archival and publication fences", async () => {
    const f = await fixture({ files: true, placeholder: true });
    const sent = await f.deliver();
    expect(f.deliveryError()).toBeUndefined();
    expect(f.uploadBytes).toEqual([TEST_PNG, REPORT]);
    const uploads = f.calls.filter(call => call.method === "sendPhoto" || call.method === "sendDocument");
    expect(uploads.map(call => call.method)).toEqual(["sendPhoto", "sendDocument"]);
    const echo = await f.env.repos.messages.get(sent.messageId);
    for (const [index, call] of uploads.entries()) {
      expect(call.payload).toMatchObject({ caption: index === 0 ? "Original photo caption" : "Original report caption",
        disable_notification: true, reply_parameters: { message_id: echo?.tg_message_id, allow_sending_without_reply: true } });
    }
    expect(f.richCalls()).toHaveLength(1);
    expect(f.richCalls()[0]?.markdown.split(EN_MARKER)).toHaveLength(2);
    expect(f.pendingHistory).toHaveLength(3);
    for (const history of f.pendingHistory) {
      expect(history.messages.at(-1)).toMatchObject({ text: f.answer, attachments: [] });
      expect(history.messages.at(-1)?.openui).toBeUndefined();
      expect(history.messages.at(-1)?.openuiLanguage).toBeUndefined();
    }
    expect(JSON.parse(f.initialRows[0]?.content_json ?? "null")).toMatchObject({
      text: f.answer, openui: OPENUI, openuiLanguage: "en", attachmentDeliveryTurnId: sent.turnId,
    });
    const assistant = await f.assistant();
    expect(JSON.parse(assistant?.content_json ?? "null")).toMatchObject({
      text: f.answer, openui: OPENUI, openuiLanguage: "en", files: f.fileIds.map(id => ({ id })),
    });
    const history = await f.chat.history(f.env.user.id, f.thread.id);
    expect(history.messages.at(-1)).toMatchObject({ text: f.answer, openui: OPENUI, openuiLanguage: "en" });
    expect(history.messages.at(-1)?.attachments.map(file => file.id)).toEqual(f.fileIds);
    for (const id of f.fileIds) {
      const file = await f.env.repos.files.get(id);
      if (!file) throw new Error("Missing archived file.");
      expect(file.message_id).toBe(assistant?.id);
      expect((await f.env.repos.files.listSources(id)).map(source => source.transport)).toEqual(expect.arrayContaining(["web", "telegram"]));
      expect((await f.env.services.fileResolver.resolveFile(file)).bytes).toEqual(id === f.fileIds[0] ? TEST_PNG : REPORT);
    }
    expect(f.confirmed).toHaveBeenCalledOnce();
  });
});
