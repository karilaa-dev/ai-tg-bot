import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
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

export function createWebHandler(options: WebServerOptions, shutdownSignal: AbortSignal, assets = new Map<string, () => Response | Promise<Response>>()) {
  let downloads = 0;
  return async (request: Request): Promise<Response> => {
    try {
      if (shutdownSignal.aborted) throw new HttpError(503, "The website is stopping.");
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
      }
      const url = new URL(request.url);
      const offset = integer(url.searchParams.get("offset"), 0, true);
      let result: unknown;
      if (url.pathname === "/api/users") {
        const search = (url.searchParams.get("q") ?? "").trim().replace(/^@/, "");
        if (search.length > 200) throw new HttpError(400, "Search is too long.");
        result = await options.repository.users(search, offset);
      } else if (/^\/api\/users\/[^/]+\/threads$/.test(url.pathname)) {
        result = await options.repository.threads(integer(url.pathname.split("/")[3]!), offset);
      } else if (/^\/api\/threads\/[^/]+\/messages$/.test(url.pathname)) {
        const before = optionalInteger(url.searchParams.get("before"));
        const after = optionalInteger(url.searchParams.get("after"));
        if (before !== undefined && after !== undefined) throw new HttpError(400, "Use either before or after.");
        result = {
          ...await options.repository.history(integer(url.pathname.split("/")[3]!), before, after),
          autoLoadMaxBytes: options.config.WEB_AUTOLOAD_MAX_BYTES, maxFileBytes: MAX_FILE_BYTES,
        };
      } else if (/^\/api\/threads\/[^/]+\/files\/[^/]+$/.test(url.pathname)) {
        const parts = url.pathname.split("/");
        const file = await options.repository.file(integer(parts[3]!), integer(parts[5]!));
        const mode = url.searchParams.get("mode") ?? "download";
        if (mode !== "auto" && mode !== "download") throw new HttpError(400, "Invalid file mode.");
        const sandbox = url.searchParams.get("sandbox");
        if (sandbox !== null && (sandbox !== "start" || mode !== "download")) throw new HttpError(400, "Invalid sandbox request.");
        const maxBytes = mode === "auto" ? options.config.WEB_AUTOLOAD_MAX_BYTES : MAX_FILE_BYTES;
        if (file.size > MAX_FILE_BYTES) throw new HttpError(413, "This file exceeds the 20 MiB download limit.");
        if (mode === "auto" && (maxBytes === 0 || file.size < 0 || file.size > maxBytes)) {
          throw new HttpError(413, "Load this attachment manually.");
        }
        // HEAD never fetches a remote attachment.
        if (request.method === "HEAD") return new Response(null, { headers });
        if (downloads >= 3) throw new HttpError(503, "Other files are loading. Try again shortly.");
        downloads++;
        try {
          const signal = AbortSignal.any([request.signal, shutdownSignal, AbortSignal.timeout(120_000)]);
          const resolved = await options.fileResolver.resolveFile(file, signal, maxBytes, { allowSandboxResume: sandbox === "start", pauseAfterRead: true });
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
      } else {
        const asset = assets.get(url.pathname);
        if (!asset) throw new WebNotFound();
        const response = await asset();
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
      }
      return request.method === "HEAD"
        ? new Response(null, { headers: { ...headers, "Content-Type": "application/json" } })
        : Response.json(result, { headers });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof WebNotFound ? 404 : 500;
      if (status === 500) options.logger.error("website request failed", { error: error instanceof Error ? error.name : "unknown" });
      return Response.json({ error: error instanceof HttpError ? error.message : status === 404 ? "Not found." : "Could not load conversations. Try again." }, { status, headers });
    }
  };
}

export async function startWebServer(options: WebServerOptions) {
  if (!options.config.WEB_ENABLED) return undefined;
  const directory = path.resolve(options.assetsDirectory ?? "dist/web");
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.some(entry => entry.name === "index.html")) throw new Error("Website assets are missing. Run npm run build:web.");
  const assets = new Map<string, () => Response | Promise<Response>>();
  const assetTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(html|js|css)$/.test(entry.name)) continue;
    assets.set(entry.name === "index.html" ? "/" : `/${entry.name}`, async () => {
      const bytes = await readFile(path.join(directory, entry.name));
      return new Response(bytes, { headers: {
        "Content-Type": assetTypes[path.extname(entry.name)]!, "Content-Length": String(bytes.length),
      } });
    });
  }
  const controller = new AbortController();
  const tasks = new Set<Promise<void>>();
  const handler = createWebHandler(options, controller.signal, assets);
  const server = createServer({ requestTimeout: 130_000 }, (incoming, outgoing) => {
    const task = respond(incoming, outgoing);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  server.setTimeout(130_000, socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.config.WEB_PORT, options.config.WEB_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    throw new Error(`Could not start conversation website on ${options.config.WEB_HOST}:${options.config.WEB_PORT}: ${String(error)}`, { cause: error });
  }
  server.on("error", error => options.logger.error("website listener failed", { error: String(error) }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Website listener has no TCP address.");
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  const url = new URL(`http://${host}:${address.port}/`);
  options.logger.info("conversation website started", { url: url.toString() });
  let stopping: Promise<void> | undefined;
  return {
    url,
    stop() {
      return stopping ??= (async () => {
        controller.abort();
        const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
        await Promise.allSettled([...tasks]);
      })();
    },
  };

  async function respond(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const disconnected = new AbortController();
    const abort = () => disconnected.abort();
    const onClose = () => { if (!outgoing.writableFinished) abort(); };
    incoming.once("aborted", abort);
    outgoing.once("close", onClose);
    const signal = AbortSignal.any([controller.signal, disconnected.signal]);
    try {
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        outgoing.writeHead(405, { ...headers, Allow: "GET, HEAD", Connection: "close" }).end("Method not allowed");
        return;
      }
      // A fixed origin keeps routing independent of untrusted Host/proxy headers.
      const request = new Request(new URL(incoming.url ?? "/", "http://localhost"), { method: incoming.method, signal });
      const response = await handler(request);
      signal.throwIfAborted();
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as NodeReadableStream), outgoing, { signal });
      else outgoing.end();
    } catch (error) {
      if (!signal.aborted) {
        options.logger.warn("website response failed", { error: error instanceof Error ? error.name : "unknown" });
        if (!outgoing.headersSent && !outgoing.destroyed) outgoing.writeHead(500, headers).end("Could not load this page.");
        else outgoing.destroy();
      }
    } finally {
      incoming.removeListener("aborted", abort);
      outgoing.removeListener("close", onClose);
    }
  }
}

function optionalInteger(value: string | null): number | undefined { return value === null ? undefined : integer(value); }
function integer(value: string | null, fallback?: number, allowZero = false): number {
  if (value === null && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) throw new HttpError(400, "Invalid pagination value or ID.");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) throw new HttpError(400, "Invalid pagination value or ID.");
  return number;
}
