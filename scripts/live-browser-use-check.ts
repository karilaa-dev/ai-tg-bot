import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { BrowserUseClient } from "../src/browserUse/client.js";
import { BrowserUseRuntimeManager } from "../src/browserUse/runtime.js";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/index.js";
import { createRepos } from "../src/db/repos/index.js";

const config = loadConfig();
if (!config.BROWSER_USE_API_KEY) throw new Error("BROWSER_USE_API_KEY is required for the live Browser Use check.");

const database = createDatabase({ ...config, DB_URL: "sqlite::memory:" });
await database.initialize();
const repos = createRepos(database.db, database.search);
const userId = randomInt(1_000_000_000, 2_000_000_000);
const threadId = 1;
const deploymentId = `live-check-${randomUUID()}`;
const runtimeConfig = { ...config, BROWSER_USE_DEPLOYMENT_ID: deploymentId };
const manager = new BrowserUseRuntimeManager({ config: runtimeConfig, repos });
const client = new BrowserUseClient(runtimeConfig);
let disposableProfileId: string | null = null;
let providerUserKey: string | null = null;

try {
  await repos.users.ensure({ tgId: userId, firstName: "Live check", lang: "en" });
  providerUserKey = (await repos.browserUseProfiles.ensure(deploymentId, userId)).provider_user_key;
  await manager.beginTurn(userId, threadId);
  const browser = manager.forThread(userId, threadId);
  const cookieValue = randomUUID();

  const persistentCookie = encodeURIComponent(
    `ai_tg_browser_use=${cookieValue}; Max-Age=3600; Path=/; Secure; HttpOnly`,
  );
  const first = await browser.open(
    `https://httpbingo.org/response-headers?Set-Cookie=${persistentCookie}`,
  );
  assert.equal(typeof first.tab_id, "string");
  const firstSnapshot = await browser.snapshot(String(first.tab_id), 0, true);
  assert.equal(typeof firstSnapshot.screenshot_base64, "string");
  assert.equal((firstSnapshot.screenshot_base64 as string).length > 100, true);
  await browser.navigate(String(first.tab_id), "https://httpbingo.org/cookies");
  const cookieSnapshot = await browser.snapshot(String(first.tab_id), 0, false);
  assert.match(String(cookieSnapshot.snapshot), new RegExp(cookieValue));

  const closed = await browser.closeSession();
  assert.deepEqual(closed, { closed: true, tabs_closed: 1, profile_preserved: true });
  const savedMapping = await repos.browserUseProfiles.get(deploymentId, userId);
  assert.ok(savedMapping?.profile_id);
  await waitForProfileCookie(client, savedMapping.profile_id, "httpbingo.org");

  const reopened = await browser.open("https://httpbingo.org/cookies");
  const secondSnapshot = await browser.snapshot(String(reopened.tab_id), 0, false);
  assert.match(String(secondSnapshot.snapshot), new RegExp(cookieValue));
  await browser.closeSession();

  const mapping = await repos.browserUseProfiles.get(deploymentId, userId);
  assert.ok(mapping?.profile_id);
  disposableProfileId = mapping.profile_id;
  process.stdout.write("Browser Use live check passed: open, screenshot, explicit stop, profile cookie restore, reopen, and stop.\n");
} finally {
  await manager.endTurn(userId, threadId).catch(() => undefined);
  await manager.dispose().catch(() => undefined);
  if (!disposableProfileId) {
    disposableProfileId = (await repos.browserUseProfiles.get(deploymentId, userId).catch(() => undefined))?.profile_id ?? null;
  }
  if (!disposableProfileId && providerUserKey) {
    disposableProfileId = (await client.listProfiles(providerUserKey).catch(() => []))
      .find((profile) => profile.userId === providerUserKey)?.id ?? null;
  }
  if (disposableProfileId) await client.deleteProfile(disposableProfileId).catch(() => undefined);
  await database.destroy();
}

async function waitForProfileCookie(client: BrowserUseClient, profileId: string, domain: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const profile = await client.getProfile(profileId);
    if (profile.cookieDomains?.some((candidate) => candidate.includes(domain))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Browser Use profile did not report the live-check cookie after explicit stop.");
}
