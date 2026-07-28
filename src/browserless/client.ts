import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { AppConfig } from "../config.js";
import { raceWithAbort, throwIfAborted } from "../files/cancel.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { detectImageMediaType } from "../files/mediaType.js";

const REMOTE_CLEANUP_TIMEOUT_MS = 5_000;

type BrowserlessConfig = Pick<
  AppConfig,
  "BROWSERLESS_URL" | "BROWSERLESS_ALLOWED_ORIGINS" | "BROWSERLESS_TOKEN" | "BROWSERLESS_TIMEOUT_MS"
>;

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlParentNode = DefaultTreeAdapterMap["parentNode"];
type HtmlElement = DefaultTreeAdapterMap["element"];

const ACTIVE_HTML_ELEMENTS = new Set([
  "applet",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "object",
  "script",
]);
const SCRIPTABLE_URL_ATTRIBUTES = new Set([
  "action",
  "background",
  "formaction",
  "href",
  "poster",
  "src",
  "xlink:href",
]);
const ACTIVE_URL_PATTERN = /^\s*(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/i;

export interface BrowserlessRenderResult {
  bytes: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export async function renderOfficeHtml(
  config: BrowserlessConfig,
  html: string,
  signal?: AbortSignal,
): Promise<BrowserlessRenderResult> {
  if (!config.BROWSERLESS_URL) throw new Error("Browserless is not configured.");
  try {
    const url = trustedBrowserlessUrl(config);
    const result = url.protocol === "ws:" || url.protocol === "wss:"
      ? await renderWithPlaywright(config, html, signal)
      : await renderWithRest(config, html, signal);
    const mediaType = detectImageMediaType(result);
    if (!mediaType) throw new Error("Browserless returned an unsupported image format.");
    return { bytes: result, mediaType };
  } catch (error) {
    throw browserlessError(config, error);
  }
}

export async function checkBrowserless(config: BrowserlessConfig): Promise<void> {
  if (!config.BROWSERLESS_URL) throw new Error("Browserless is not configured.");
  try {
    const url = trustedBrowserlessUrl(config);
    if (url.protocol === "ws:" || url.protocol === "wss:") {
      const browser = await chromium.connect(browserlessEndpoint(config), { timeout: 5_000 });
      await closeWithTimeout(() => browser.close());
      return;
    }
    const response = await fetch(browserlessHttpEndpoint(config, "active"), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Browserless healthcheck returned HTTP ${response.status}.`);
  } catch (error) {
    throw browserlessError(config, error);
  }
}

async function renderWithPlaywright(
  config: BrowserlessConfig,
  html: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const timeoutSignal = AbortSignal.timeout(config.BROWSERLESS_TIMEOUT_MS);
  const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  throwIfAborted(operationSignal);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const connecting = chromium.connect(browserlessEndpoint(config), {
    timeout: config.BROWSERLESS_TIMEOUT_MS,
  });
  if (operationSignal) {
    void connecting.then(async (connected) => {
      if (operationSignal.aborted && connected !== browser) {
        await closeWithTimeout(() => connected.close()).catch(() => undefined);
      }
    }).catch(() => undefined);
  }
  try {
    browser = await raceWithAbort(connecting, operationSignal);
    context = await raceWithAbort(browser.newContext({
      viewport: { width: 1440, height: 1080 },
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      serviceWorkers: "block",
    }), operationSignal);
    await raceWithAbort(context.route("**/*", async (route) => {
      const url = route.request().url();
      if (/^(?:about|blob|data):/i.test(url)) await route.continue();
      else await route.abort("blockedbyclient");
    }), operationSignal);
    const page = await raceWithAbort(context.newPage(), operationSignal);
    await raceWithAbort(page.setContent(html, {
      waitUntil: "load",
      timeout: config.BROWSERLESS_TIMEOUT_MS,
    }), operationSignal);
    await raceWithAbort(page.waitForTimeout(250), operationSignal);
    const screenshot = await raceWithAbort(page.screenshot({
      type: "png",
      fullPage: true,
      animations: "disabled",
      timeout: config.BROWSERLESS_TIMEOUT_MS,
    }), operationSignal);
    const bytes = Buffer.from(screenshot);
    assertImageSize(bytes);
    return bytes;
  } finally {
    await closeRemoteSession(context, browser);
  }
}

async function renderWithRest(
  config: BrowserlessConfig,
  html: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const timeout = AbortSignal.timeout(config.BROWSERLESS_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(browserlessHttpEndpoint(config, "screenshot"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      html: sanitizeActiveHtml(html),
      options: {
        fullPage: true,
        type: "png",
      },
      rejectRequestPattern: [
        "/^https?:/i",
        "/^wss?:/i",
        "/^ftp:/i",
        "/^file:/i",
      ],
      waitForTimeout: 250,
    }),
    redirect: "error",
    signal: requestSignal,
  });
  if (!response.ok) throw new Error(`Browserless screenshot returned HTTP ${response.status}.`);
  return readLimitedResponse(response);
}

async function readLimitedResponse(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
    throw new Error("Browserless response is too large.");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_FILE_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("Browserless response is too large.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function assertImageSize(bytes: Buffer): void {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Browserless response is too large.");
}

async function closeRemoteSession(context: BrowserContext | undefined, browser: Browser | undefined): Promise<void> {
  let contextError: unknown;
  try {
    if (context) await closeWithTimeout(() => context.close());
  } catch (error) {
    contextError = error;
  }
  try {
    if (browser) await closeWithTimeout(() => browser.close());
  } catch (error) {
    if (contextError !== undefined) {
      throw new AggregateError([contextError, error], "Browserless session cleanup failed.");
    }
    throw error;
  }
  if (contextError !== undefined) throw contextError;
}

async function closeWithTimeout(close: () => Promise<void>): Promise<void> {
  await raceWithAbort(close(), AbortSignal.timeout(REMOTE_CLEANUP_TIMEOUT_MS));
}

function browserlessEndpoint(config: BrowserlessConfig): string {
  const url = trustedBrowserlessUrl(config);
  if (config.BROWSERLESS_TOKEN) url.searchParams.set("token", config.BROWSERLESS_TOKEN);
  return url.toString();
}

function browserlessHttpEndpoint(config: BrowserlessConfig, action: "active" | "screenshot"): string {
  const url = trustedBrowserlessUrl(config);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${action}`;
  if (config.BROWSERLESS_TOKEN) url.searchParams.set("token", config.BROWSERLESS_TOKEN);
  return url.toString();
}

function trustedBrowserlessUrl(config: BrowserlessConfig): URL {
  const url = new URL(config.BROWSERLESS_URL!);
  if (!config.BROWSERLESS_ALLOWED_ORIGINS?.includes(url.origin)) {
    throw new Error("Browserless URL origin is not trusted.");
  }
  return url;
}

function sanitizeActiveHtml(html: string): string {
  const document = parse(html);
  sanitizeChildren(document);
  return serialize(document);
}

function sanitizeChildren(parent: HtmlParentNode): void {
  for (const child of [...parent.childNodes]) {
    if (!isHtmlElement(child)) continue;
    if (isActiveElement(child)) {
      parent.childNodes.splice(parent.childNodes.indexOf(child), 1);
      continue;
    }
    child.attrs = child.attrs.filter((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") return false;
      return !SCRIPTABLE_URL_ATTRIBUTES.has(name) || !ACTIVE_URL_PATTERN.test(attribute.value);
    });
    sanitizeChildren(child);
    if ("content" in child) sanitizeChildren(child.content);
  }
}

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function isActiveElement(element: HtmlElement): boolean {
  if (ACTIVE_HTML_ELEMENTS.has(element.tagName)) return true;
  if (element.tagName !== "meta") return false;
  return element.attrs.some((attribute) =>
    attribute.name.toLowerCase() === "http-equiv" && attribute.value.trim().toLowerCase() === "refresh"
  );
}

function browserlessError(config: BrowserlessConfig, error: unknown): Error {
  let message = String(error);
  const secrets = [
    config.BROWSERLESS_URL,
    ...browserlessEndpointVariants(config),
    config.BROWSERLESS_TOKEN,
    config.BROWSERLESS_TOKEN ? encodeURIComponent(config.BROWSERLESS_TOKEN) : undefined,
    config.BROWSERLESS_TOKEN
      ? new URLSearchParams({ token: config.BROWSERLESS_TOKEN }).toString().slice("token=".length)
      : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const secret of secrets.sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, "[redacted]");
  }
  return new Error(message);
}

function browserlessEndpointVariants(config: BrowserlessConfig): string[] {
  if (!config.BROWSERLESS_URL) return [];
  try {
    const url = new URL(config.BROWSERLESS_URL);
    const variants = [url.toString()];
    if (url.protocol === "ws:" || url.protocol === "wss:") {
      variants.push(browserlessEndpoint(config));
    } else {
      variants.push(
        browserlessHttpEndpoint(config, "active"),
        browserlessHttpEndpoint(config, "screenshot"),
      );
    }
    return variants;
  } catch {
    return [];
  }
}
