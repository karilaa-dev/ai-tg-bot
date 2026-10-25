import type { BunRequest, Server } from "bun";
import { z } from "zod";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { WebHttpError } from "./auth.js";
import { chatClientAddress, ChatRateLimit, readBoundedBody, requireChatMutation, WebChatAuth } from "./chat-auth.js";
import type { ChatService, ChatSession } from "./chat-types.js";
import { WebNotFound } from "./repository.js";
import type { WebServerOptions } from "./server.js";

import { readChatUpload } from "./chat-upload.js";
export { MAX_CHAT_BODY_BYTES } from "./chat-upload.js";
const MAX_JSON_BYTES = 256 * 1024;
const TitleSchema = z.object({ title: z.string().trim().min(1).refine(value => Array.from(value).length <= 128).optional() }).strict();
const SendSchema = z.object({ text: z.string().max(32_000), requestId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }).strict();
const ForkSchema = z.object({ messageId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const ReadSchema = z.object({ messageId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const SettingsSchema = z.object({
  language: z.enum(["en", "ru"]).optional(),
  timeZone: z.string().trim().min(1).max(64).nullable().optional(),
  streaming: z.boolean().optional(), memoryEnabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Choose a setting to update.");
const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };

export function createChatRoutes(options: WebServerOptions, shutdownSignal: AbortSignal,
  attachment: (request: Request & { params: { threadId: string; fileId: string } }) => Promise<Response>, auth: WebChatAuth) {
  const reads = new ChatRateLimit(240);
  const writes = new ChatRateLimit(30);
  const tasks = new Set<Promise<Response>>();
  const submitting = new Set<number>();
  shutdownSignal.addEventListener("abort", () => { auth.clear(); reads.clear(); writes.clear(); }, { once: true });
  const service = (): ChatService => {
    if (!options.chat) throw new WebHttpError(503, "Web chat is unavailable.");
    return options.chat.service;
  };
  const session = async (request: Request): Promise<ChatSession> => {
    const userId = auth.userId(request);
    if (userId === undefined || !options.chat) return { authenticated: false, loginAvailable: auth.available && Boolean(options.chat) };
    reads.take(String(userId));
    try { return { authenticated: true, user: await service().profile(userId), botUsername: options.chat.botUsername, admin: auth.isAdmin(userId) }; }
    catch (error) { if (error instanceof WebNotFound) return { authenticated: false, loginAvailable: auth.available }; throw error; }
  };
  function guard<Path extends string>(handler: (request: BunRequest<Path>, server?: Pick<Server<unknown>, "requestIP">) => Promise<Response> | Response) {
    return (request: BunRequest<Path>, server?: Pick<Server<unknown>, "requestIP">): Promise<Response> => {
      const task = (async () => {
        try {
          if (shutdownSignal.aborted) throw new WebHttpError(503, "The website is stopping.");
          if (!["GET", "HEAD"].includes(request.method)) requireChatMutation(request, options.config.WEB_PUBLIC_URL);
          const result = await handler(request, server);
          const headers = new Headers(result.headers);
          for (const [key, value] of Object.entries(responseHeaders)) if (!headers.has(key)) headers.set(key, value);
          return new Response(request.method === "HEAD" ? null : result.body, { status: result.status, headers });
        } catch (error) {
          const status = request.signal.aborted ? 499 : error instanceof WebHttpError ? error.status : error instanceof WebNotFound ? 404 : error instanceof z.ZodError ? 400 : 500;
          if (status === 500) options.logger.error("web chat request failed", { error: error instanceof Error ? error.name : "unknown" });
          return new Response(request.method === "HEAD" || status === 499 ? null : JSON.stringify({ error: error instanceof WebHttpError ? error.message : status === 400 ? "Invalid request." : status === 404 ? "Not found." : "Could not complete the request. Try again." }), {
            status, headers: { ...responseHeaders, ...(error instanceof WebHttpError ? error.headers : {}), "Content-Type": "application/json" },
          });
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return task;
    };
  }
  function requireBoundSession(request: Request): number {
    const userId = auth.requireSession(request);
    if (request.headers.get("X-Chat-User") !== String(userId)) {
      throw new WebHttpError(401, "Your account changed. Reload the page to continue.");
    }
    return userId;
  }
  function user<Path extends string>(handler: (request: BunRequest<Path>, userId: number, chat: ChatService) => Promise<Response>) {
    return guard<Path>(async request => {
      const userId = requireBoundSession(request);
      const chat = service();
      (request.method === "GET" || request.method === "HEAD" ? reads : writes).take(String(userId));
      await chat.profile(userId);
      return handler(request, userId, chat);
    });
  }
  function read<Path extends string>(handler: (request: BunRequest<Path>, userId: number, chat: ChatService) => Promise<Response>) {
    const handle = user(handler);
    return { GET: handle, HEAD: handle };
  }
  async function owned(request: Request & { params: { threadId: string } }, userId: number, chat: ChatService) {
    const id = integer(request.params.threadId);
    await chat.requireThread(userId, id);
    return id;
  }
  const sessionRead = guard(async request => Response.json(await session(request)));
  return {
    routes: {
      "/api/chat/session": {
        GET: sessionRead, HEAD: sessionRead,
        DELETE: guard(request => {
          requireBoundSession(request);
          return Response.json({ authenticated: false, loginAvailable: auth.available && Boolean(options.chat) } satisfies ChatSession,
            { headers: { "Set-Cookie": auth.logout(request) } });
        }),
      },
      "/api/auth/telegram/start": { GET: guard((request, server) => { service(); return auth.start(request, chatClientAddress(request, server?.requestIP(request)?.address, options.config.WEB_TRUSTED_PROXY_IPS)); }) },
      "/api/auth/telegram/callback": { GET: guard((request, server) => {
        const chat = service();
        return auth.callback(request, async userId => {
          try { await chat.profile(userId); }
          catch (error) { if (error instanceof WebNotFound) throw new WebHttpError(403, "Start a conversation with the bot in Telegram before signing in here."); throw error; }
        }, chatClientAddress(request, server?.requestIP(request)?.address, options.config.WEB_TRUSTED_PROXY_IPS));
      }) },
      "/api/chat/threads": {
        ...read(async (request, userId, chat) => {
          const query = new URL(request.url).searchParams;
          const search = z.string().trim().max(200).parse(query.get("q") ?? "");
          return Response.json(await chat.threads(userId, integer(query.get("offset"), 0), search));
        }),
        POST: user(async (request, userId, chat) => {
          const input = TitleSchema.parse(await json(request));
          return Response.json(await chat.createThread(userId, input.title), { status: 201 });
        }),
      },
      "/api/chat/threads/:threadId/messages": {
        ...read<"/api/chat/threads/:threadId/messages">(async (request, userId, chat) => {
          const threadId = await owned(request, userId, chat);
          const query = new URL(request.url).searchParams;
          const before = query.has("before") ? integer(query.get("before")) : undefined;
          const after = query.has("after") ? integer(query.get("after")) : undefined;
          if (before !== undefined && after !== undefined) throw new WebHttpError(400, "Use either before or after.");
          return Response.json({ ...await chat.history(userId, threadId, before, after), autoLoadMaxBytes: options.config.WEB_AUTOLOAD_MAX_BYTES, maxFileBytes: MAX_FILE_BYTES });
        }),
        POST: user<"/api/chat/threads/:threadId/messages">(async (request, userId, chat) => {
          const threadId = await owned(request, userId, chat);
          if (submitting.has(userId)) throw new WebHttpError(429, "Your previous message is still being accepted. Try again shortly.", { "Retry-After": "1" });
          if (submitting.size >= 3) throw new WebHttpError(503, "Other uploads are processing. Try again shortly.");
          submitting.add(userId);
          try {
            const input = await sendInput(request);
            try { return Response.json(await chat.send(userId, threadId, input.value), { status: 202 }); }
            finally { await input.dispose(); }
          }
          finally { submitting.delete(userId); }
        }),
      },
      "/api/chat/threads/:threadId/stop": { POST: user<"/api/chat/threads/:threadId/stop">(async (request, userId, chat) => {
        await chat.stop(userId, await owned(request, userId, chat));
        return new Response(null, { status: 204 });
      }) },
      "/api/chat/threads/:threadId/read": { POST: user<"/api/chat/threads/:threadId/read">(async (request, userId, chat) => {
        const threadId = await owned(request, userId, chat);
        const input = ReadSchema.parse(await json(request));
        return Response.json(await chat.markRead(userId, threadId, input.messageId));
      }) },
      "/api/chat/threads/:threadId/fork": { POST: user<"/api/chat/threads/:threadId/fork">(async (request, userId, chat) => {
        const threadId = await owned(request, userId, chat);
        const input = ForkSchema.parse(await json(request));
        return Response.json(await chat.fork(userId, threadId, input.messageId), { status: 201 });
      }) },
      "/api/chat/threads/:threadId/compact": { POST: user<"/api/chat/threads/:threadId/compact">(async (request, userId, chat) => {
        await chat.compact(userId, await owned(request, userId, chat));
        return new Response(null, { status: 204 });
      }) },
      "/api/chat/threads/:threadId/files/:fileId": {
        ...read<"/api/chat/threads/:threadId/files/:fileId">(async (request, userId, chat) => { await owned(request, userId, chat); return attachment(request); }),
        POST: user<"/api/chat/threads/:threadId/files/:fileId">(async (request, userId, chat) => { await owned(request, userId, chat); return attachment(request); }),
      },
      "/api/chat/avatar": read(async (_request, userId, chat) => {
        const avatar = await chat.avatar(userId);
        // No photo, or Telegram hides it: the client keeps showing the initial.
        if (!avatar) return new Response(null, { status: 204 });
        return new Response(new Uint8Array(avatar.bytes), { headers: { "Content-Type": avatar.mime, "Content-Length": String(avatar.bytes.byteLength) } });
      }),
      "/api/chat/settings": {
        ...read(async (_request, userId, chat) => Response.json(await chat.settings(userId))),
        PATCH: user(async (request, userId, chat) => Response.json(await chat.updateSettings(userId, SettingsSchema.parse(await json(request))))),
      },
      "/api/chat/memories": read(async (request, userId, chat) => Response.json(await chat.memories(userId, integer(new URL(request.url).searchParams.get("offset"), 0)))),
      "/api/chat/memories/:memoryId": { DELETE: user<"/api/chat/memories/:memoryId">(async (request, userId, chat) => {
        await chat.deleteMemory(userId, integer(request.params.memoryId, 0));
        return Response.json({ deleted: true });
      }) },
      "/api/chat/usage": read(async (request, userId, chat) => {
        const days = integer(new URL(request.url).searchParams.get("days"), 30);
        if (![0, 7, 30, 90].includes(days)) throw new WebHttpError(400, "Choose 7, 30, 90 days, or 0 for all time.");
        return Response.json(await chat.usage(userId, days, AbortSignal.any([request.signal, shutdownSignal])));
      }),
    },
    async drain() { await Promise.allSettled([...tasks]); },
  };
}

function integer(value: string | null, fallback?: number): number {
  if (value === null && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) throw new WebHttpError(400, "Invalid pagination value or ID.");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (fallback === undefined ? 1 : 0)) throw new WebHttpError(400, "Invalid pagination value or ID.");
  return number;
}
async function json(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new WebHttpError(415, "Send JSON.");
  const body = await readBoundedBody(request, MAX_JSON_BYTES);
  try { return JSON.parse(body); }
  catch { throw new WebHttpError(400, "Invalid JSON."); }
}
async function sendInput(request: Request): Promise<{ value: Parameters<ChatService["send"]>[2]; dispose(): Promise<void> }> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("multipart/form-data;")) {
    const input = SendSchema.parse(await json(request));
    if (!input.text.trim()) throw new WebHttpError(400, "Write a message or attach a file.");
    return { value: input, async dispose() {} };
  }
  const { dispose, ...value } = await readChatUpload(request);
  return { value, dispose };
}
