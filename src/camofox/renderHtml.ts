import type { AppConfig } from "../config.js";
import { createCamofoxClient } from "./client.js";

const HTML_CHUNK_BYTES = 384 * 1024;

export async function renderHtmlWithCamofox(
  config: Pick<
    AppConfig,
    "CAMOFOX_URL" | "CAMOFOX_ACCESS_KEY" | "CAMOFOX_TIMEOUT_MS"
  >,
  userId: string,
  html: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mediaType: string }> {
  const client = createCamofoxClient(config);
  let tabId: string | undefined;
  try {
    const tab = await client.createTab(userId, "office-preview", undefined, signal);
    tabId = tab.tabId;
    await client.setViewport(userId, tabId, 1600, 1200, signal);
    await client.evaluate(userId, tabId, "globalThis.__aiTgBotOfficeChunks = []", signal);
    const encoded = Buffer.from(html, "utf8").toString("base64");
    for (let offset = 0; offset < encoded.length; offset += HTML_CHUNK_BYTES) {
      const chunk = encoded.slice(offset, offset + HTML_CHUNK_BYTES);
      await client.evaluate(
        userId,
        tabId,
        `globalThis.__aiTgBotOfficeChunks.push(${JSON.stringify(chunk)})`,
        signal,
      );
    }
    await client.evaluate(userId, tabId, [
      "(() => {",
      "const binary = atob(globalThis.__aiTgBotOfficeChunks.join(''));",
      "const bytes = new Uint8Array(binary.length);",
      "for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);",
      "const html = new TextDecoder().decode(bytes);",
      "const parsed = new DOMParser().parseFromString(html, 'text/html');",
      "document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement);",
      "delete globalThis.__aiTgBotOfficeChunks;",
      "return html.length;",
      "})()",
    ].join(""), signal);
    await client.wait(userId, tabId, 250, signal);
    return await client.screenshot(userId, tabId, true, signal);
  } finally {
    if (tabId) await client.closeTab(userId, tabId, cleanupSignal()).catch(() => undefined);
    await client.destroySession(userId, cleanupSignal()).catch(() => undefined);
  }
}

function cleanupSignal(): AbortSignal {
  return AbortSignal.timeout(5_000);
}
