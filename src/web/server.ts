import path from "node:path";
import { readdir } from "node:fs/promises";
import { file as bunFile, serve, type BunRequest, type HTMLBundle, type Server } from "bun";
import { fileTypeFromBuffer } from "file-type";
import type { AppConfig } from "../config.js";
import type { FileResolver } from "../files/resolver.js";
import { SandboxConsentRequired } from "../files/source.js";
import { isAudioMime, imageMimeTypes } from "./media.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import type { Logger } from "../logger.js";
import { ConversationRepository, WebNotFound } from "./repository.js";

export interface WebServerOptions {
  config: Pick<AppConfig, "WEB_ENABLED" | "WEB_HOST" | "WEB_PORT" | "WEB_AUTOLOAD_MAX_BYTES">;
  repository: ConversationRepository;
  fileResolver: FileResolver;
  logger: Logger;
  assetsDirectory?: string;
  development?: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

// The same wrappers protect every API method and track work that outlives a closed socket.
export function createWebRoutes(options: WebServerOptions, shutdownSignal: AbortSignal) {
  let downloads = 0;
  const tasks = new Set<Promise<Response>>();
  function guard<Path extends string>(handler: (request: BunRequest<Path>) => Response | Promise<Response>) {
    return (request: BunRequest<Path>): Promise<Response> => {
      const task = (async () => {
        try {
          if (shutdownSignal.aborted) throw new HttpError(503, "The website is stopping.");
          const response = await handler(request);
          return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
        } catch (error) {
          const status = error instanceof HttpError ? error.status : error instanceof WebNotFound ? 404 : 500;
          if (status === 500) options.logger.error("website request failed", { error: error instanceof Error ? error.name : "unknown" });
          return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: error instanceof HttpError ? error.message : status === 404 ? "Not found." : "Could not load conversations. Try again." }), {
            status, headers: { ...headers, "Content-Type": "application/json" },
          });
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return task;
    };
  }
  function read<Path extends string>(handler: (request: BunRequest<Path>) => Response | Promise<Response>) {
    const handle = guard(handler);
    return { GET: handle, HEAD: handle };
  }
  const methodNotAllowed = () => new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  const attachment = async (request: BunRequest<"/api/threads/:threadId/files/:fileId">) => {
    const url = new URL(request.url);
    const sandboxConsent = request.method === "POST" && url.searchParams.get("sandbox") === "start" && url.searchParams.get("mode") === "download";
    if (request.method === "POST" && !sandboxConsent) return methodNotAllowed();
    // The custom header requires a CORS preflight, which this server never permits.
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (sandboxConsent && (request.headers.get("X-Conversation-Sandbox-Consent") !== "start"
      || (fetchSite && fetchSite !== "same-origin"))) throw new HttpError(403, "Sandbox consent must come from this website.");
    const file = await options.repository.file(integer(request.params.threadId), integer(request.params.fileId));
    const mode = url.searchParams.get("mode") ?? "download";
    if (mode !== "auto" && mode !== "download") throw new HttpError(400, "Invalid file mode.");
    const sandbox = url.searchParams.get("sandbox");
    if (sandbox !== null && !sandboxConsent) throw new HttpError(400, "Sandbox consent requires a same-origin POST.");
    const maxBytes = mode === "auto" ? options.config.WEB_AUTOLOAD_MAX_BYTES : MAX_FILE_BYTES;
    if (file.size > MAX_FILE_BYTES) throw new HttpError(413, "This file exceeds the 20 MiB download limit.");
    if (mode === "auto" && (maxBytes === 0 || file.size <= 0 || file.size > maxBytes)) {
      throw new HttpError(413, "Load this attachment manually.");
    }
    // HEAD never fetches a remote attachment.
    if (request.method === "HEAD") return new Response(null, { headers });
    if (downloads >= 3) throw new HttpError(503, "Other files are loading. Try again shortly.");
    downloads++;
    try {
      const signal = AbortSignal.any([request.signal, shutdownSignal, AbortSignal.timeout(120_000)]);
      const resolved = await options.fileResolver.resolveFile(file, signal, maxBytes, { allowSandboxResume: sandboxConsent, pauseAfterRead: true });
      signal.throwIfAborted();
      if (resolved.size > maxBytes) throw new HttpError(413, "Attachment exceeds the download limit.");
      const detected = await fileTypeFromBuffer(resolved.bytes).catch(() => undefined);
      const mime = detected?.mime === "video/webm" && (file.type === "audio" || file.mime_type?.startsWith("audio/"))
        ? "audio/webm" : detected?.mime === "audio/x-m4a" ? "audio/mp4" : detected?.mime ?? "application/octet-stream";
      const safeImage = imageMimeTypes.includes(mime);
      const safeAudio = isAudioMime(mime);
      const safeText = !detected && /^(text\/(plain|csv|markdown)|application\/json)$/.test(file.mime_type ?? "")
        && !resolved.bytes.subarray(0, 8192).includes(0);
      const contentType = safeImage || safeAudio ? mime : safeText ? "text/plain; charset=utf-8" : "application/octet-stream";
      const encodedName = encodeURIComponent(file.name.replace(/[\r\n\x00-\x1f]/g, "_")).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`);
      return new Response(new Uint8Array(resolved.bytes), { headers: {
        ...headers, "Content-Type": contentType, "Content-Length": String(resolved.size),
        "Content-Disposition": `${mode === "auto" && (safeImage || safeAudio) ? "inline" : "attachment"}; filename*=UTF-8''${encodedName}`,
      } });
    } catch (error) {
      if (error instanceof SandboxConsentRequired) return Response.json({ code: "sandbox_consent_required", error: error.message }, { status: 409, headers });
      if (error instanceof HttpError) throw error;
      options.logger.warn("website attachment unavailable", { fileId: file.id });
      throw new HttpError(502, "This attachment could not be retrieved. Try again later.");
    } finally { downloads--; }
  };
  return {
    routes: {
      "/api/usage": read(async request => {
        const query = new URL(request.url).searchParams;
        const days = integer(query.get("days"), 30, true);
        if (![0, 7, 30, 90].includes(days)) throw new HttpError(400, "Choose 7, 30, 90 days, or 0 for all time.");
        return Response.json(await options.repository.usageReport({
          userId: optionalInteger(query.get("user")), threadId: optionalInteger(query.get("thread")), days,
        }), { headers });
      }),
      "/api/users": read(async request => {
        const query = new URL(request.url).searchParams;
        const search = (query.get("q") ?? "").trim().replace(/^@/, "");
        if (search.length > 200) throw new HttpError(400, "Search is too long.");
        return Response.json(await options.repository.users(search, integer(query.get("offset"), 0, true)), { headers });
      }),
      "/api/users/:userId/threads": read<"/api/users/:userId/threads">(async request => {
        const query = new URL(request.url).searchParams;
        return Response.json(await options.repository.threads(integer(request.params.userId), integer(query.get("offset"), 0, true)), { headers });
      }),
      "/api/threads/:threadId/messages": read<"/api/threads/:threadId/messages">(async request => {
        const query = new URL(request.url).searchParams;
        const before = optionalInteger(query.get("before"));
        const after = optionalInteger(query.get("after"));
        if (before !== undefined && after !== undefined) throw new HttpError(400, "Use either before or after.");
        return Response.json({
          ...await options.repository.history(integer(request.params.threadId), before, after),
          autoLoadMaxBytes: options.config.WEB_AUTOLOAD_MAX_BYTES, maxFileBytes: MAX_FILE_BYTES,
        }, { headers });
      }),
      "/api/threads/:threadId/files/:fileId": { ...read(attachment), POST: guard(attachment) },
    },
    fetch: guard(request => {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
      throw new WebNotFound();
    }),
    async drain() { await Promise.allSettled([...tasks]); },
  };
}

async function assetRoutes(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.some(entry => entry.isFile() && entry.name === "index.html")) throw new Error("Website assets are missing. Run bun run build:web.");
  const routes: Record<string, { GET: () => Response; HEAD: () => Response }> = {};
  const assetTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(html|js|css)$/.test(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    // Only content-addressed bundles are safe to cache across releases.
    const cache = /-[a-z0-9]{8}\.(js|css)$/.test(entry.name) ? "public, max-age=31536000, immutable" : "no-store";
    const respond = (head: boolean) => {
      const file = bunFile(filename);
      return new Response(head ? null : file, { headers: {
        ...headers, "Cache-Control": cache,
        "Content-Type": assetTypes[path.extname(entry.name)]!, "Content-Length": String(file.size),
      } });
    };
    routes[entry.name === "index.html" ? "/" : `/${entry.name}`] = { GET: () => respond(false), HEAD: () => respond(true) };
  }
  return routes;
}

export async function startWebServer(options: WebServerOptions) {
  if (!options.config.WEB_ENABLED) return undefined;
  const assets: Record<string, HTMLBundle | { GET: () => Response; HEAD: () => Response }> = options.development
    ? { "/": (await import("./client/index.html")).default }
    : await assetRoutes(path.resolve(options.assetsDirectory ?? "dist/web"));
  const controller = new AbortController();
  const api = createWebRoutes(options, controller.signal);
  let server: Server<undefined>;
  try {
    server = serve({
      hostname: options.config.WEB_HOST,
      port: options.config.WEB_PORT,
      reusePort: false,
      idleTimeout: 130,
      development: options.development ? { hmr: true, console: false } : false,
      routes: { ...assets, ...api.routes },
      fetch: api.fetch,
      error(error) {
        options.logger.error("website response failed", { error: error.name });
        return new Response("Could not load this page.", { status: 500, headers });
      },
    });
  } catch (error) {
    throw new Error(`Could not start conversation website on ${options.config.WEB_HOST}:${options.config.WEB_PORT}: ${String(error)}`, { cause: error });
  }
  const url = new URL(server.url);
  options.logger.info("conversation website started", { url: url.toString() });
  let stopping: Promise<void> | undefined;
  return {
    url,
    stop() {
      return stopping ??= (async () => {
        controller.abort();
        await server.stop(true);
        // Closing sockets does not wait for remote download cleanup.
        await api.drain();
      })();
    },
  };
}

function optionalInteger(value: string | null): number | undefined { return value === null ? undefined : integer(value); }
function integer(value: string | null, fallback?: number, allowZero = false): number {
  if (value === null && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) throw new HttpError(400, "Invalid pagination value or ID.");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) throw new HttpError(400, "Invalid pagination value or ID.");
  return number;
}
