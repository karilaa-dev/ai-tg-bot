import { describe, expect, it } from "vitest";
import { renderSystemPrompt } from "../../src/ai/prompt.js";
import type { ThreadRow, UserRow } from "../../src/db/types.js";

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
  pi_session_file: null,
  pi_session_id: null,
  archived: 0,
  created_at: 1,
};

describe("renderSystemPrompt", () => {
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
});
