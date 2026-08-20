import { describe, expect, it } from "vitest";
import {
  E2B_TELEGRAM_FILES,
  E2B_WORKSPACE,
  sandboxWorkingDirectory,
  sandboxWorkspaceFile,
} from "../../src/e2b/paths.js";

describe("E2B paths", () => {
  it("maps logical paths into the writable thread workspace", () => {
    expect(sandboxWorkingDirectory("/")).toBe(E2B_WORKSPACE);
    expect(sandboxWorkingDirectory("/reports/2026")).toBe(`${E2B_WORKSPACE}/reports/2026`);
    expect(sandboxWorkspaceFile("/report.txt")).toBe(`${E2B_WORKSPACE}/report.txt`);
  });

  it("allows the read-only Telegram directory as a command cwd but maps exports into the workspace", () => {
    expect(sandboxWorkingDirectory(E2B_TELEGRAM_FILES)).toBe(E2B_TELEGRAM_FILES);
    expect(sandboxWorkspaceFile(`${E2B_TELEGRAM_FILES}/input.txt`))
      .toBe(`${E2B_WORKSPACE}/home/user/telegram-files/input.txt`);
  });
});
