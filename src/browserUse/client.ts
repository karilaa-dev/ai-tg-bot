import { z } from "zod";
import type { AppConfig } from "../config.js";
import { raceWithAbort, throwIfAborted } from "../files/cancel.js";

const API_BASE_URL = "https://api.browser-use.com/api/v3/";
const MAX_JSON_BYTES = 2 * 1024 * 1024;

type BrowserUseConfig = Pick<AppConfig, "BROWSER_USE_API_KEY" | "BROWSER_USE_API_TIMEOUT_MS">;

const ProfileSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  userId: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  lastUsedAt: z.string().nullable().optional(),
  cookieDomains: z.array(z.string()).nullable().optional(),
});

const ProfileListSchema = z.object({
  items: z.array(ProfileSchema),
  totalItems: z.number().int().nonnegative(),
  pageNumber: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

const BrowserSessionSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["active", "stopped"]),
  timeoutAt: z.string(),
  startedAt: z.string(),
  cdpUrl: z.string().nullable(),
  liveUrl: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  proxyUsedMb: z.string().optional(),
  proxyCost: z.string().optional(),
  browserCost: z.string().optional(),
});

const BrowserListSchema = z.object({
  items: z.array(BrowserSessionSchema),
  totalItems: z.number().int().nonnegative(),
  pageNumber: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

const DownloadSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  lastModified: z.string(),
  url: z.string().optional(),
});

const DownloadListSchema = z.object({
  files: z.array(DownloadSchema),
  nextCursor: z.string().nullable().optional(),
  hasMore: z.boolean().default(false),
});

export type BrowserUseProfile = z.infer<typeof ProfileSchema>;
export type BrowserUseSession = z.infer<typeof BrowserSessionSchema>;
export type BrowserUseDownload = z.infer<typeof DownloadSchema>;

export class BrowserUseHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BrowserUseHttpError";
  }
}

export class BrowserUseClient {
  constructor(private readonly config: BrowserUseConfig) {
    if (!config.BROWSER_USE_API_KEY) throw new Error("Browser Use Cloud is not configured.");
  }

  async listProfiles(query: string, signal?: AbortSignal): Promise<BrowserUseProfile[]> {
    const params = new URLSearchParams({ query, pageSize: "100", pageNumber: "1" });
    const response = await this.requestJson("GET", `profiles?${params}`, undefined, ProfileListSchema, signal);
    return response.items;
  }

  createProfile(input: { name: string; userId: string }, signal?: AbortSignal): Promise<BrowserUseProfile> {
    return this.requestJson("POST", "profiles", input, ProfileSchema, signal);
  }

  getProfile(profileId: string, signal?: AbortSignal): Promise<BrowserUseProfile> {
    return this.requestJson("GET", `profiles/${encodeURIComponent(profileId)}`, undefined, ProfileSchema, signal);
  }

  async deleteProfile(profileId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request("DELETE", `profiles/${encodeURIComponent(profileId)}`, undefined, signal);
    await response.body?.cancel().catch(() => undefined);
  }

  createBrowser(input: {
    profileId: string;
    proxyCountryCode: null;
    timeout: number;
    browserScreenWidth: number;
    browserScreenHeight: number;
    allowResizing: boolean;
    enableRecording: false;
  }, signal?: AbortSignal): Promise<BrowserUseSession> {
    return this.requestJson("POST", "browsers", input, BrowserSessionSchema, signal);
  }

  getBrowser(sessionId: string, signal?: AbortSignal): Promise<BrowserUseSession> {
    return this.requestJson("GET", `browsers/${encodeURIComponent(sessionId)}`, undefined, BrowserSessionSchema, signal);
  }

  async listActiveBrowsers(signal?: AbortSignal): Promise<{ totalItems: number }> {
    const params = new URLSearchParams({ filterBy: "active", pageSize: "1", pageNumber: "1" });
    const response = await this.requestJson("GET", `browsers?${params}`, undefined, BrowserListSchema, signal);
    return { totalItems: response.totalItems };
  }

  stopBrowser(sessionId: string, signal?: AbortSignal): Promise<BrowserUseSession> {
    return this.requestJson(
      "PATCH",
      `browsers/${encodeURIComponent(sessionId)}`,
      { action: "stop" },
      BrowserSessionSchema,
      signal,
    );
  }

  listDownloads(
    sessionId: string,
    input: { includeUrls?: boolean; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<z.infer<typeof DownloadListSchema>> {
    const params = new URLSearchParams({
      includeUrls: String(input.includeUrls ?? false),
      limit: String(input.limit ?? 100),
    });
    if (input.cursor) params.set("cursor", input.cursor);
    return this.requestJson(
      "GET",
      `browsers/${encodeURIComponent(sessionId)}/downloads?${params}`,
      undefined,
      DownloadListSchema,
      signal,
    );
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(method, path, body, signal);
    const bytes = await readLimitedResponse(response, MAX_JSON_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Browser Use Cloud returned invalid JSON.");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error(`Browser Use Cloud returned an invalid response: ${parsed.error.message}`);
    return parsed.data;
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.config.BROWSER_USE_API_TIMEOUT_MS);
    const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    throwIfAborted(operationSignal);
    const url = new URL(path, API_BASE_URL);
    try {
      const response = await raceWithAbort(fetch(url, {
        method,
        headers: {
          "X-Browser-Use-API-Key": this.config.BROWSER_USE_API_KEY!,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: operationSignal,
      }), operationSignal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new BrowserUseHttpError(
          response.status,
          `Browser Use Cloud HTTP ${response.status}.`,
        );
      }
      return response;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw redactBrowserUseError(this.config, error);
    }
  }
}

export function createBrowserUseClient(config: BrowserUseConfig): BrowserUseClient {
  return new BrowserUseClient(config);
}

export function redactBrowserUseError(config: BrowserUseConfig, error: unknown): Error {
  const original = error instanceof BrowserUseHttpError ? error : undefined;
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [
    config.BROWSER_USE_API_KEY,
    config.BROWSER_USE_API_KEY ? encodeURIComponent(config.BROWSER_USE_API_KEY) : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const secret of secrets.sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, "[redacted]");
  }
  message = message
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted-authorization]")
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [redacted]")
    .replace(/(?:https?|wss):\/\/[^\s"']*(?:cdp|live|connect)[^\s"']*/gi, "[redacted-browser-url]")
    .replace(/([?&][A-Za-z0-9_.-]*(?:apiKey|token|key|secret|signature|credential)[A-Za-z0-9_.-]*=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(?:https?|wss):\/\/[^\s"']+/gi, "[redacted-url]");
  return original
    ? new BrowserUseHttpError(original.status, message)
    : new Error(message);
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Browser Use Cloud response is too large.");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("Browser Use Cloud response is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}
