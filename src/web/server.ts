import path from "node:path";
import { readdir } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";
import type { AppConfig } from "../config.js";
import type { FileResolver } from "../files/resolver.js";
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
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

export function createWebHandler(options: WebServerOptions, shutdownSignal: AbortSignal, assets = new Map<string, () => Response>()) {
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
          const resolved = await options.fileResolver.resolveFile(file, signal, maxBytes);
          signal.throwIfAborted();
          if (resolved.size > maxBytes) throw new HttpError(413, "Attachment exceeds the download limit.");
          const detected = await fileTypeFromBuffer(resolved.bytes).catch(() => undefined);
          const mime = detected?.mime ?? "application/octet-stream";
          const safeImage = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime);
          const safeText = !detected && /^(text\/(plain|csv|markdown)|application\/json)$/.test(file.mime_type ?? "")
            && !resolved.bytes.subarray(0, 8192).includes(0);
          const contentType = safeImage ? mime : safeText ? "text/plain; charset=utf-8" : "application/octet-stream";
          const encodedName = encodeURIComponent(file.name.replace(/[\r\n\x00-\x1f]/g, "_")).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`);
          return new Response(new Uint8Array(resolved.bytes), { headers: {
            ...headers, "Content-Type": contentType, "Content-Length": String(resolved.size),
            "Content-Disposition": `${mode === "auto" && safeImage ? "inline" : "attachment"}; filename*=UTF-8''${encodedName}`,
          } });
        } catch (error) {
          if (error instanceof HttpError) throw error;
          options.logger.warn("website attachment unavailable", { fileId: file.id });
          throw new HttpError(502, "This attachment could not be retrieved. Try again later.");
        } finally { downloads--; }
      } else {
        const asset = assets.get(url.pathname);
        if (!asset) throw new WebNotFound();
        const response = asset();
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
  const assets = new Map<string, () => Response>();
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(html|js|css)$/.test(entry.name)) continue;
    assets.set(entry.name === "index.html" ? "/" : `/${entry.name}`, () => new Response(Bun.file(path.join(directory, entry.name))));
  }
  const controller = new AbortController();
  const tasks = new Set<Promise<Response>>();
  const handler = createWebHandler(options, controller.signal, assets);
  const server = Bun.serve({
    hostname: options.config.WEB_HOST, port: options.config.WEB_PORT, idleTimeout: 130,
    fetch(request) {
      const task = handler(request);
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return task;
    },
  });
  options.logger.info("conversation website started", { url: server.url.toString() });
  return {
    url: server.url,
    async stop() {
      controller.abort();
      await server.stop(true);
      await Promise.allSettled([...tasks]);
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
