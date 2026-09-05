import type { Page } from "playwright-core";
import { MAX_FILE_BYTES } from "../files/limits.js";

export const SCREEN = { width: 2560, height: 1440 } as const;
export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
const COMPACT_VIEWPORT = { width: 1600, height: 900 } as const;
const SNAPSHOT_CHUNK_CHARS = 12_000;
const MAX_SNAPSHOT_CHARS = 120_000;
const MAX_INTERACTIVE_REFS = 500;

export class BrowserUseRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrowserUseRuntimeError";
  }
}

export async function inspectPage(page: Page, offset: number, includeScreenshot: boolean) {
  const refs = await page.evaluate<InteractiveRef[]>(interactiveRefsScript(MAX_INTERACTIVE_REFS));
  let semantic = "";
  try {
    semantic = await page.locator("body").ariaSnapshot({ timeout: 10_000 });
  } catch {
    semantic = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  }
  const refText = refs.map((ref) =>
    `[ref=${ref.ref}] ${ref.role}${ref.name ? ` ${JSON.stringify(ref.name)}` : ""}${ref.href ? ` href=${ref.href}` : ""}`
  ).join("\n");
  const full = [semantic, refText && `Interactive elements:\n${refText}`]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_SNAPSHOT_CHARS);
  const chunk = full.slice(offset, offset + SNAPSHOT_CHUNK_CHARS);
  const nextOffset = offset + chunk.length;
  const output: Record<string, unknown> = {
    url: page.url(),
    snapshot: chunk,
    refs_count: refs.length,
    truncated: full.length >= MAX_SNAPSHOT_CHARS,
    total_chars: full.length,
    has_more: nextOffset < full.length,
    ...(nextOffset < full.length ? { next_offset: nextOffset } : {}),
  };
  if (includeScreenshot) {
    const screenshot = await page.screenshot({ type: "png", fullPage: false });
    if (screenshot.length <= MAX_FILE_BYTES) {
      output.screenshot_base64 = screenshot.toString("base64");
      output.screenshot_media_type = "image/png";
      output.screenshot_size = screenshot.length;
    }
  }
  return { output, refs: new Map(refs.map((ref) => [ref.ref, { href: ref.href }])) };
}

export async function capturePage(page: Page, fullPage: boolean) {
  const viewport = await chooseScreenshotViewport(page);
  let bytes = await page.screenshot({ type: "png", fullPage });
  let mediaType = "image/png";
  if (bytes.length > MAX_FILE_BYTES && fullPage) {
    bytes = await page.screenshot({ type: "jpeg", quality: 85, fullPage: true });
    mediaType = "image/jpeg";
  }
  assertImageSize(bytes);
  return { bytes, mediaType, viewport };
}

export async function renderOfficePage(page: Page, html: string, selector: string | undefined, timeoutMs: number): Promise<Buffer> {
  // Browser Use's remote CDP page can leave Playwright setContent() waiting
  // forever for a lifecycle event. The HTML is already sanitized and contains
  // no active elements or remote resources, so replace the blank document
  // directly without depending on navigation lifecycle reporting.
  await withinTimeout(
    page.evaluate((markup) => {
      document.open();
      document.write(markup);
      document.close();
    }, html),
    timeoutMs,
    () => new BrowserUseRuntimeError(
      "office_preview_timeout",
      "The remote browser timed out while loading the Office preview.",
    ),
  );
  await withinTimeout(
    page.evaluate("document.fonts?.ready"),
    timeoutMs,
    () => new BrowserUseRuntimeError(
      "office_preview_timeout",
      "The remote browser timed out while loading the Office preview fonts.",
    ),
  ).catch((error) => {
    if (error instanceof BrowserUseRuntimeError) throw error;
    return undefined;
  });
  await page.waitForTimeout(250);
  let bytes: Buffer;
  if (selector) {
    const target = page.locator(selector).first();
    if (await target.count() === 0) {
      throw new BrowserUseRuntimeError(
        "office_preview_page_not_found",
        "OfficeCLI preview HTML did not contain the requested page or slide.",
      );
    }
    bytes = await target.screenshot({ type: "png" });
  } else {
    bytes = await page.screenshot({ type: "png", fullPage: true });
  }
  assertImageSize(bytes);
  return bytes;
}

interface InteractiveRef {
  ref: string;
  role: string;
  name: string;
  href?: string;
}

function interactiveRefsScript(limit: number): string {
  return `(() => {
    const marker = "data-ai-tg-browser-ref";
    document.querySelectorAll("[" + marker + "]").forEach((element) => element.removeAttribute(marker));
    const selector = ["a[href]", "button", "input", "select", "textarea", "[contenteditable=true]", "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[tabindex]"] .join(",");
    const visible = Array.from(document.querySelectorAll(selector)).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }).slice(0, ${limit});
    return visible.map((element, index) => {
      const ref = "e" + (index + 1);
      element.setAttribute(marker, ref);
      const role = element.getAttribute("role") || ({A:"link",BUTTON:"button",INPUT:"input",SELECT:"select",TEXTAREA:"textarea"}[element.tagName] || element.tagName.toLowerCase());
      const label = element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.value || "";
      const href = element instanceof HTMLAnchorElement ? element.href : undefined;
      return {ref, role, name: String(label).trim().replace(/\\s+/g, " ").slice(0, 300), ...(href ? {href} : {})};
    });
  })()`;
}

async function chooseScreenshotViewport(page: Page): Promise<{ width: number; height: number }> {
  await page.setViewportSize(DEFAULT_VIEWPORT);
  await page.waitForTimeout(100);
  const measured = await page.evaluate<{ scrollWidth: number; contentWidth: number }>(`(() => {
    const root = document.documentElement;
    const main = document.querySelector("main, [role=main]");
    const elements = main ? [main] : Array.from(document.body?.children || []);
    const rects = elements.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
    const left = rects.length ? Math.min(...rects.map((rect) => rect.left)) : 0;
    const right = rects.length ? Math.max(...rects.map((rect) => rect.right)) : window.innerWidth;
    return {scrollWidth: root.scrollWidth, contentWidth: Math.max(0, right - left)};
  })()`);
  if (measured.scrollWidth > DEFAULT_VIEWPORT.width + 8) {
    await page.setViewportSize(SCREEN);
    return SCREEN;
  }
  if (measured.contentWidth < DEFAULT_VIEWPORT.width * 0.65) {
    await page.setViewportSize(COMPACT_VIEWPORT);
    const compactOverflow = await page.evaluate<number>("document.documentElement.scrollWidth - window.innerWidth");
    if (compactOverflow <= 8) return COMPACT_VIEWPORT;
    await page.setViewportSize(DEFAULT_VIEWPORT);
  }
  return DEFAULT_VIEWPORT;
}

function assertImageSize(bytes: Buffer): void {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Browser screenshot is too large to attach.");
}

export async function withinTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
