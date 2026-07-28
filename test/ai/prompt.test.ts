import fs from "node:fs/promises";
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

    expect(prompt).toContain("deliver those files individually in their natural format");
    expect(prompt).toContain("Create an archive only when the user explicitly asks");
    expect(prompt).toContain("Never create an archive merely to work around attachment count or size limits");
    expect(prompt).toContain("do not substitute an archive");
    expect(prompt).toContain("default to ZIP");
    expect(prompt).toContain("zip -r archive.zip folder");
    expect(prompt).toContain("do not use Python or JavaScript to build an archive");
  });

  it("lists every contracted runner command and recommends the modern ImageMagick CLI", async () => {
    const prompt = await renderSystemPrompt({ user: baseUser, thread });
    const contract = await fs.readFile("docker/ai-agent-box/tool-contract.sh", "utf8");
    const requiredBlock = contract.match(/required_commands=\(\n([\s\S]*?)\n\)/)?.[1];

    expect(requiredBlock).toBeDefined();
    const commands = requiredBlock!.trim().split(/\s+/);
    for (const command of commands) expect(prompt).toContain(`\`${command}\``);
    expect(prompt).toContain("ImageMagick 7 through `magick`");
    expect(prompt).toContain("Use `magick identify`");
    expect(prompt).toContain("do not use the legacy `convert` command");
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

  it("routes Office work through the installed OfficeCLI skills and visual QA tool", async () => {
    const prompt = await renderSystemPrompt({ user: baseUser, thread });

    expect(prompt).toContain("/usr/local/share/officecli/skills/officecli-pptx/SKILL.md");
    expect(prompt).toContain("/usr/local/share/officecli/skills/officecli-docx/SKILL.md");
    expect(prompt).toContain("officecli validate output.pptx");
    expect(prompt).toContain("render_office_preview");
    expect(prompt).toContain("visually inspect every PPTX slide");
    expect(prompt).toContain("Do not download OfficeCLI");
  });
});
