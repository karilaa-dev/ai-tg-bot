import { createCamofoxClient } from "../src/camofox/client.js";
import { disposableCamofoxUserId } from "../src/camofox/session.js";
import { isCamofoxConfigured, loadConfig } from "../src/config.js";

const config = loadConfig();
if (!isCamofoxConfigured(config)) {
  throw new Error("CAMOFOX_URL and CAMOFOX_ACCESS_KEY are required for the live Camofox check.");
}

const client = createCamofoxClient(config);
const userId = disposableCamofoxUserId(config, 9_999_201, 9_999_202, "live-check");
let tabId: string | undefined;

try {
  const health = await client.health();
  const tab = await client.createTab(userId, "live-check", "https://example.com");
  tabId = tab.tabId;
  const snapshot = await client.snapshot(userId, tabId);
  if (!snapshot.snapshot.toLowerCase().includes("example domain")) {
    throw new Error("Camofox snapshot did not contain the expected Example Domain content.");
  }
  const screenshot = await client.screenshot(userId, tabId, false);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    engine: typeof health.engine === "string" ? health.engine : undefined,
    url: snapshot.url,
    refs: snapshot.refsCount,
    screenshotBytes: screenshot.bytes.length,
    screenshotMediaType: screenshot.mediaType,
  }, null, 2)}\n`);
} finally {
  if (tabId) await client.closeTab(userId, tabId, AbortSignal.timeout(5_000)).catch(() => undefined);
  await client.destroySession(userId, AbortSignal.timeout(5_000)).catch(() => undefined);
}
