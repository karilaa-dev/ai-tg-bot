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
    expect(prompt).toContain("/usr/local/share/officecli/skills/officecli-pptx/SKILL.md");
    expect(prompt).toContain("read");
    expect(prompt).toContain("completely");
    expect(prompt).toContain("delivery gates as required");
    expect(prompt).toContain("make `view issues` clean");
    expect(prompt).toContain("Overlap, clipping, off-slide elements");
    expect(prompt).not.toContain("render_office_preview");
    expect(prompt).not.toContain("Browserless");
  });

  it("adds profile-backed Browser Use and model-only Office QA guidance when configured", async () => {
    const prompt = await renderSystemPrompt({
      user: baseUser,
      thread,
      config: loadTestConfig({
        BROWSER_USE_API_KEY: "secret",
      }),
    });

    expect(prompt).toContain("`web_search` and `web_extract` use Tavily");
    expect(prompt).toContain("`browser_open`");
    expect(prompt).toContain("`browser_navigate`");
    expect(prompt).toContain("`browser_click`");
    expect(prompt).toContain("`browser_send_file`");
    expect(prompt).toContain("Never use `bash`, E2B, Chrome/Chromium");
    expect(prompt).toContain("shared across all Telegram threads");
    expect(prompt).toContain("Tabs remain private");
    expect(prompt).toContain("`browser_screenshot`");
    expect(prompt).toContain("full_page=false");
    expect(prompt).toContain("delivery=document");
    expect(prompt).toContain("`browser_extend_session`");
    expect(prompt).toContain("`browser_close_tab`");
    expect(prompt).toContain("`browser_close_session`");
    expect(prompt).toContain("Before giving the final answer");
    expect(prompt).toContain("you MUST call `browser_close_session`");
    expect(prompt).toContain("default after delivering screenshots or files");
    expect(prompt).toContain("possible future user request is not a reason");
    expect(prompt).toContain("final browser tool call");
    expect(prompt).toContain("session_busy");
    expect(prompt).toContain("delivered directly without E2B");
    expect(prompt).toContain("`render_office_preview`");
    expect(prompt).toContain("not sent to Telegram");
    expect(prompt).toContain("once for every slide");
    expect(prompt).toContain("overlap, clipping, off-slide objects");
    expect(prompt).toContain("at most three fix-and-preview cycles");
    expect(prompt).toContain("Do not call `create_file`");
    expect(prompt).toContain("not visually verified");
  });
});
