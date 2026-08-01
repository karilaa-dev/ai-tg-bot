import type { AppConfig } from "../config.js";
import { raceWithAbort, throwIfAborted } from "../files/cancel.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { asRecord, numberField, stringField } from "../util/records.js";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 32 * 1024;

type CamofoxConfig = Pick<
  AppConfig,
  "CAMOFOX_URL" | "CAMOFOX_ACCESS_KEY" | "CAMOFOX_TIMEOUT_MS"
>;

export interface CamofoxTab {
  tabId: string;
  url: string;
  title?: string;
  sessionKey?: string;
}

export interface CamofoxSnapshot {
  url: string;
  snapshot: string;
  refsCount: number;
  truncated: boolean;
  totalChars: number;
  hasMore: boolean;
  nextOffset?: number;
  screenshot?: {
    bytes: Buffer;
    mediaType: string;
  };
}

export interface CamofoxPageImage {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface CamofoxPageLink {
  text: string;
  href: string;
  ref?: string;
}

export interface CamofoxDownload {
  filename: string;
  url: string;
  state: string;
}

export class CamofoxClient {
  private readonly baseUrl: URL;

  constructor(private readonly config: CamofoxConfig) {
    if (!config.CAMOFOX_URL || !config.CAMOFOX_ACCESS_KEY) {
      throw new Error("Camofox is not configured.");
    }
    this.baseUrl = new URL(config.CAMOFOX_URL);
  }

  health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson("GET", "/health", undefined, signal);
  }

  async createTab(
    userId: string,
    sessionKey: string,
    url?: string,
    signal?: AbortSignal,
  ): Promise<CamofoxTab> {
    const value = await this.requestJson("POST", "/tabs", {
      userId,
      sessionKey,
      ...(url ? { url } : {}),
    }, signal);
    const tabId = stringField(value, "tabId");
    if (!tabId) throw new Error("Camofox did not return a tabId.");
    return { tabId, url: stringField(value, "url") ?? url ?? "about:blank" };
  }

  async listTabs(userId: string, signal?: AbortSignal): Promise<CamofoxTab[]> {
    const value = await this.requestJson(
      "GET",
      `/tabs?${new URLSearchParams({ userId })}`,
      undefined,
      signal,
    );
    const tabs = Array.isArray(value.tabs) ? value.tabs : [];
    return tabs.flatMap((item) => {
      const record = asRecord(item);
      const tabId = stringField(record, "tabId");
      if (!tabId) return [];
      return [{
        tabId,
        url: stringField(record, "url") ?? "about:blank",
        title: stringField(record, "title"),
        sessionKey: stringField(record, "sessionKey") ?? stringField(record, "listItemId"),
      }];
    });
  }

  navigate(
    userId: string,
    tabId: string,
    input: { url?: string; macro?: string; query?: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.requestJson("POST", `/tabs/${encodeURIComponent(tabId)}/navigate`, {
      userId,
      ...input,
    }, signal);
  }

  async snapshot(
    userId: string,
    tabId: string,
    input: { offset?: number; includeScreenshot?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<CamofoxSnapshot> {
    const params = new URLSearchParams({
      userId,
      format: "text",
      includeScreenshot: String(input.includeScreenshot ?? false),
    });
    if (input.offset !== undefined) params.set("offset", String(input.offset));
    const value = await this.requestJson(
      "GET",
      `/tabs/${encodeURIComponent(tabId)}/snapshot?${params}`,
      undefined,
      signal,
    );
    const screenshot = asRecord(value.screenshot);
    const screenshotData = stringField(screenshot, "data");
    const screenshotMediaType = stringField(screenshot, "mimeType") ?? "image/png";
    const screenshotBytes = screenshotData ? Buffer.from(screenshotData, "base64") : undefined;
    if (screenshotBytes) assertImageSize(screenshotBytes);
    return {
      url: stringField(value, "url") ?? "",
      snapshot: stringField(value, "snapshot") ?? "",
      refsCount: numberField(value, "refsCount") ?? 0,
      truncated: value.truncated === true,
      totalChars: numberField(value, "totalChars") ?? 0,
      hasMore: value.hasMore === true,
      nextOffset: numberField(value, "nextOffset"),
      ...(screenshotBytes ? { screenshot: { bytes: screenshotBytes, mediaType: screenshotMediaType } } : {}),
    };
  }

  click(
    userId: string,
    tabId: string,
    input: { ref?: string; selector?: string; doubleClick?: boolean },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.requestJson("POST", `/tabs/${encodeURIComponent(tabId)}/click`, {
      userId,
      ...input,
    }, signal);
  }

  type(
    userId: string,
    tabId: string,
    input: { ref?: string; selector?: string; text: string; clear?: boolean; submit?: boolean },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.requestJson("POST", `/tabs/${encodeURIComponent(tabId)}/type`, {
      userId,
      ...input,
    }, signal);
  }

  press(userId: string, tabId: string, key: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson("POST", `/tabs/${encodeURIComponent(tabId)}/press`, {
      userId,
      key,
    }, signal);
  }

  scroll(
    userId: string,
    tabId: string,
    direction: "up" | "down" | "left" | "right",
    amount: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.requestJson("POST", `/tabs/${encodeURIComponent(tabId)}/scroll`, {
      userId,
      direction,
      amount,
    }, signal);
  }

  setViewport(
    userId: string,
    tabId: string,
    width: number,
    height: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.requestJson("POST", `/tabs/${encodeURIComponent(tabId)}/viewport`, {
      userId,
      width,
      height,
    }, signal);
  }

  wait(userId: string, tabId: string, timeout: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson("POST", `/tabs/${encodeURIComponent(tabId)}/wait`, {
      userId,
      timeout,
    }, signal);
  }

  evaluate(
    userId: string,
    tabId: string,
    expression: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.requestJson("POST", `/tabs/${encodeURIComponent(tabId)}/evaluate`, {
      userId,
      expression,
    }, signal, 4 * 1024 * 1024);
  }

  async images(userId: string, tabId: string, signal?: AbortSignal): Promise<CamofoxPageImage[]> {
    const value = await this.requestJson(
      "GET",
      `/tabs/${encodeURIComponent(tabId)}/images?${new URLSearchParams({ userId })}`,
      undefined,
      signal,
    );
    const images = Array.isArray(value.images) ? value.images : [];
    return images.flatMap((item) => {
      const record = asRecord(item);
      const src = stringField(record, "src");
      if (!src) return [];
      return [{
        src,
        alt: stringField(record, "alt"),
        width: numberField(record, "width"),
        height: numberField(record, "height"),
      }];
    });
  }

  async downloads(userId: string, tabId: string, signal?: AbortSignal): Promise<CamofoxDownload[]> {
    const value = await this.requestJson(
      "GET",
      `/tabs/${encodeURIComponent(tabId)}/downloads?${new URLSearchParams({ userId })}`,
      undefined,
      signal,
    );
    const downloads = Array.isArray(value.downloads) ? value.downloads : [];
    return downloads.flatMap((item) => {
      const record = asRecord(item);
      const filename = stringField(record, "filename");
      const url = stringField(record, "url");
      if (!filename || !url) return [];
      return [{
        filename,
        url,
        state: stringField(record, "state") ?? "unknown",
      }];
    });
  }

  async links(userId: string, tabId: string, signal?: AbortSignal): Promise<CamofoxPageLink[]> {
    const value = await this.requestJson(
      "GET",
      `/tabs/${encodeURIComponent(tabId)}/links?${new URLSearchParams({ userId })}`,
      undefined,
      signal,
    );
    const links = Array.isArray(value.links) ? value.links : [];
    return links.flatMap((item) => {
      const record = asRecord(item);
      const href = stringField(record, "href");
      if (!href) return [];
      return [{
        text: stringField(record, "text") ?? "",
        href,
        ref: stringField(record, "ref"),
      }];
    });
  }

  async screenshot(
    userId: string,
    tabId: string,
    fullPage: boolean,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; mediaType: string }> {
    const params = new URLSearchParams({ userId, fullPage: String(fullPage) });
    const response = await this.request(
      "GET",
      `/tabs/${encodeURIComponent(tabId)}/screenshot?${params}`,
      undefined,
      signal,
    );
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (mediaType.startsWith("image/")) {
      const bytes = await readLimitedResponse(response, MAX_FILE_BYTES);
      assertPng(bytes);
      return { bytes, mediaType };
    }
    const value = asRecord(JSON.parse((await readLimitedResponse(response, MAX_JSON_BYTES)).toString("utf8")));
    const screenshot = asRecord(value?.screenshot);
    const data = stringField(screenshot, "data");
    if (!data) throw new Error("Camofox screenshot response did not contain an image.");
    const bytes = Buffer.from(data, "base64");
    assertImageSize(bytes);
    assertPng(bytes);
    return { bytes, mediaType: stringField(screenshot, "mimeType") ?? "image/png" };
  }

  async closeTab(userId: string, tabId: string, signal?: AbortSignal): Promise<void> {
    await this.requestJson(
      "DELETE",
      `/tabs/${encodeURIComponent(tabId)}?${new URLSearchParams({ userId })}`,
      undefined,
      signal,
    );
  }

  async destroySession(userId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.requestJson("DELETE", `/sessions/${encodeURIComponent(userId)}`, undefined, signal);
    } catch (error) {
      if (!String(error).includes("HTTP 404")) throw error;
    }
  }

  private async requestJson(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    maxBytes = MAX_JSON_BYTES,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(method, path, body, signal);
    const bytes = await readLimitedResponse(response, maxBytes);
    try {
      return asRecord(JSON.parse(bytes.toString("utf8"))) ?? {};
    } catch {
      throw new Error("Camofox returned invalid JSON.");
    }
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.config.CAMOFOX_TIMEOUT_MS);
    const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    throwIfAborted(operationSignal);
    const url = new URL(path, this.baseUrl);
    try {
      const response = await raceWithAbort(fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.config.CAMOFOX_ACCESS_KEY}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: operationSignal,
      }), operationSignal);
      if (!response.ok) {
        const detail = (await readLimitedResponse(response, MAX_ERROR_BYTES).catch(() => Buffer.alloc(0)))
          .toString("utf8")
          .trim();
        throw new Error(`Camofox HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      return response;
    } catch (error) {
      throw redactCamofoxError(this.config, error);
    }
  }
}

export function createCamofoxClient(config: CamofoxConfig): CamofoxClient {
  return new CamofoxClient(config);
}

export async function checkCamofox(config: CamofoxConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return createCamofoxClient(config).health(signal);
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Camofox response is too large.");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("Camofox response is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function assertImageSize(bytes: Buffer): void {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Camofox response is too large.");
}

function assertPng(bytes: Buffer): void {
  assertImageSize(bytes);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Camofox returned an invalid PNG screenshot.");
  }
}

function redactCamofoxError(config: CamofoxConfig, error: unknown): Error {
  let message = String(error);
  const secrets = [
    config.CAMOFOX_URL,
    config.CAMOFOX_ACCESS_KEY,
    config.CAMOFOX_ACCESS_KEY ? encodeURIComponent(config.CAMOFOX_ACCESS_KEY) : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const secret of secrets.sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, "[redacted]");
  }
  return new Error(message);
}
