import { describe, expect, it } from "vitest";
import { renderSystemPrompt } from "../../src/ai/prompt.js";
import type { ThreadRow, UserRow } from "../../src/db/types.js";
import { loadTestConfig } from "../../src/config.js";

const baseUser: UserRow = {
  tg_id: 123,
  first_name: "Alice",
  username: "alice",
  lang: "en",
  tz_offset_min: null,
  stream_mode: 1,
  created_at: 1,
};

const thread: ThreadRow = {
  id: 10,
  user_id: baseUser.tg_id,
  topic_id: null,
  parent_thread_id: null,
  fork_point_message_id: null,
  title: "General",
  title_source: "explicit",
  title_attempts: 0,
  topic_title_synced: 1,
  pi_session_file: null,
  pi_session_id: null,
  archived: 0,
  created_at: 1,
};

describe("renderSystemPrompt", () => {
  it("archives only when requested and otherwise preserves natural file delivery", async () => {
    const prompt = await renderSystemPrompt({ user: baseUser, thread });

    expect(prompt).toContain("Deliver ordinary files individually in their natural format");
    expect(prompt).toContain("Create an archive only when explicitly requested");
    expect(prompt).toContain("Default to ZIP");
    expect(prompt).toContain("Do not use an archive merely to evade this limit");
  });

  it("describes the custom toolbox without allowing automatic dependency installs", async () => {
    const prompt = await renderSystemPrompt({ user: baseUser, thread });

    expect(prompt).toContain("Never automatically run package-manager installs");
    expect(prompt).toContain("Check uncertain dependencies with `command -v`");
    expect(prompt).toContain("/home/user/telegram-files");
    expect(prompt).toContain("There is no shared filesystem");
    expect(prompt).toContain("ImageMagick");
    expect(prompt).toContain("Chromium and browser automation bundles are intentionally absent");
  });

  it("uses UTC time and timezone when the user has no stored timezone", async () => {
    const prompt = await renderSystemPrompt({
      user: { ...baseUser, tz_offset_min: null },
      thread,
      now: new Date("2026-06-16T02:05:30.000Z"),
    });

    expect(prompt).toContain("Current time: 2026-06-16 02:05");
    expect(prompt).toContain("Timezone: UTC+00:00");
    expect(prompt).not.toContain("Local time:");
    expect(prompt).not.toContain("Date:");
    expect(prompt).not.toContain("unknown (suggest /timezone)");
  });

  it("uses the stored timezone offset for the current date and time", async () => {
    const prompt = await renderSystemPrompt({
      user: { ...baseUser, tz_offset_min: -420 },
      thread,
      now: new Date("2026-06-16T02:05:30.000Z"),
    });

    expect(prompt).toContain("Current time: 2026-06-15 19:05");
    expect(prompt).toContain("Timezone: UTC-07:00");
    expect(prompt).not.toContain("Local time:");
    expect(prompt).not.toContain("Date:");
    expect(prompt).not.toContain("unknown (suggest /timezone)");
  });

  it("routes Office authoring through Bash without promising installed preview tooling", async () => {
    const prompt = await renderSystemPrompt({ user: baseUser, thread });

    expect(prompt).toContain("through `bash` to create");
    expect(prompt).toContain("never install or update it");
    expect(prompt).not.toContain("render_office_preview");
    expect(prompt).not.toContain("Browserless");
  });

  it("adds per-thread browser and model-only Office QA guidance when Camofox is configured", async () => {
    const prompt = await renderSystemPrompt({
      user: baseUser,
      thread,
      config: loadTestConfig({
        WEB_EXTRACT_PROVIDER: "camofox",
        CAMOFOX_URL: "https://browser.example",
        CAMOFOX_ACCESS_KEY: "secret",
      }),
    });

    expect(prompt).toContain("`web_extract` loads known URLs through Camofox");
    expect(prompt).toContain("`camofox_create_tab`");
    expect(prompt).toContain("For every real-browser action");
    expect(prompt).toContain("`camofox_navigate`");
    expect(prompt).toContain("`camofox_click`");
    expect(prompt).toContain("`camofox_send_file`");
    expect(prompt).toContain("Never use `bash`, E2B, Chrome/Chromium");
    expect(prompt).toContain("Do not use `create_file`");
    expect(prompt).toContain("isolated to this Telegram thread");
    expect(prompt).toContain("`camofox_screenshot`");
    expect(prompt).toContain("Keep full_page=false");
    expect(prompt).toContain("set delivery=document");
    expect(prompt).toContain("never use `bash`");
    expect(prompt).toContain("`camofox_send_file`");
    expect(prompt).toContain("does not use E2B");
    expect(prompt).toContain("`render_office_preview`");
    expect(prompt).toContain("not sent to Telegram");
  });
});
