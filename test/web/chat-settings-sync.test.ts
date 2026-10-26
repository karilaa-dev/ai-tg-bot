import { describe, expect, it } from "vitest";
import type { ChatSettings, ChatSettingsPatch } from "../../src/web/chat-types.js";
import { SettingsSync } from "../../src/web/client/chat/settings-sync.js";
import { deferred } from "../helpers/async.js";

const base: ChatSettings = { language: "en", timeZone: null, timezoneOffsetMinutes: null, streaming: true, memoryEnabled: true };

function harness() {
  const saves: { patch: ChatSettingsPatch; reply: ReturnType<typeof deferred<ChatSettings>> }[] = [];
  const shown: ChatSettings[] = [];
  const confirmed: ChatSettings[] = [];
  const sync = new SettingsSync({
    save: patch => { const reply = deferred<ChatSettings>(); saves.push({ patch, reply }); return reply.promise; },
    changed: settings => shown.push(settings),
    confirmed: settings => confirmed.push(settings),
  });
  expect(sync.received(base, sync.beginRead())).toBe(true);
  return { sync, saves, shown, confirmed, server: { ...base } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("chat settings sync", () => {
  it("sends overlapping changes one at a time so an older response cannot overwrite a newer one", async () => {
    const { sync, saves, shown, confirmed, server } = harness();
    const language = sync.update({ language: "ru" });
    const streaming = sync.update({ streaming: false });
    expect(sync.settings).toEqual({ ...base, language: "ru", streaming: false });
    await settle();
    // The second request waits until the first one is answered.
    expect(saves.map(save => save.patch)).toEqual([{ language: "ru" }]);
    Object.assign(server, saves[0]!.patch);
    saves[0]!.reply.resolve({ ...server });
    await language;
    expect(sync.settings).toEqual({ ...base, language: "ru", streaming: false });
    await settle();
    expect(saves.map(save => save.patch)).toEqual([{ language: "ru" }, { streaming: false }]);
    Object.assign(server, saves[1]!.patch);
    saves[1]!.reply.resolve({ ...server });
    await streaming;
    expect(sync.settings).toEqual({ ...base, language: "ru", streaming: false });
    expect(confirmed.at(-1)).toEqual({ ...base, language: "ru", streaming: false });
    expect(shown.at(-1)).toEqual({ ...base, language: "ru", streaming: false });
  });

  it("rolls back only the failed change and keeps later unsaved changes visible", async () => {
    const { sync, saves, confirmed, server } = harness();
    const language = sync.update({ language: "ru" });
    const memory = sync.update({ memoryEnabled: false });
    await settle();
    saves[0]!.reply.reject(new Error("offline"));
    await expect(language).rejects.toThrow("offline");
    // The rejected language reverts while the queued memory change still shows.
    expect(sync.settings).toEqual({ ...base, memoryEnabled: false });
    await settle();
    expect(saves[1]!.patch).toEqual({ memoryEnabled: false });
    Object.assign(server, saves[1]!.patch);
    saves[1]!.reply.resolve({ ...server });
    await memory;
    expect(sync.settings).toEqual({ ...base, memoryEnabled: false });
    expect(confirmed.at(-1)?.language).toBe("en");
  });

  it("restores the latest confirmed state when a follow-up save fails after a success", async () => {
    const { sync, saves, server } = harness();
    const first = sync.update({ language: "ru" });
    await settle();
    Object.assign(server, saves[0]!.patch);
    saves[0]!.reply.resolve({ ...server });
    await first;
    const second = sync.update({ streaming: false });
    await settle();
    saves[1]!.reply.reject(new Error("rate limited"));
    await expect(second).rejects.toThrow("rate limited");
    expect(sync.settings).toEqual({ ...base, language: "ru" });
  });

  it("ignores background reads that overlap a save and accepts Telegram changes afterwards", async () => {
    const { sync, saves, server } = harness();
    const stale = sync.beginRead();
    const save = sync.update({ language: "ru" });
    // A read that started before the save, or lands while it is pending, is outdated.
    expect(sync.received({ ...base }, stale)).toBe(false);
    expect(sync.received({ ...base }, sync.beginRead())).toBe(false);
    await settle();
    Object.assign(server, saves[0]!.patch);
    saves[0]!.reply.resolve({ ...server });
    await save;
    expect(sync.received({ ...base, language: "en", timezoneOffsetMinutes: 180 }, sync.beginRead())).toBe(true);
    expect(sync.settings).toEqual({ ...base, timezoneOffsetMinutes: 180 });
  });

  it("does not send queued changes or publish after the workspace closes", async () => {
    const { sync, saves, shown } = harness();
    const first = sync.update({ language: "ru" });
    const second = sync.update({ streaming: false });
    await settle();
    sync.close();
    const published = shown.length;
    saves[0]!.reply.resolve({ ...base, language: "ru" });
    await first;
    await expect(second).rejects.toThrow("closed");
    expect(saves).toHaveLength(1);
    expect(shown).toHaveLength(published);
    expect(sync.received({ ...base, language: "ru" }, sync.beginRead())).toBe(false);
  });
});
