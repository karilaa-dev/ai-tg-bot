import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  approvedSkillPaths,
  createApprovedSkillReadTool,
  validateApprovedSkills,
} from "../../src/pi/officeSkills.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("approved Pi skills", () => {
  it("loads checksum-verified approved skills with default discovery disabled", async () => {
    await expect(validateApprovedSkills()).resolves.toBeUndefined();
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: path.resolve("data/pi"),
      settingsManager: SettingsManager.inMemory(),
      additionalSkillPaths: approvedSkillPaths(),
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();
    expect(loader.getSkills().diagnostics).toEqual([]);
    expect(loader.getSkills().skills.map((skill) => skill.name).sort()).toEqual([
      "docx-cli",
      "openscad",
      "pptx-edit",
      "pptxgenjs",
      "sandbox-files",
      "xlsx",
    ]);
  });

  it("reads a complete advertised skill but rejects all other host files", async () => {
    const tool = createApprovedSkillReadTool();
    const skillPath = approvedSkillPaths()[0]!;
    const result = await tool.execute(
      "read-skill",
      { path: skillPath },
      undefined,
      undefined,
      {} as never,
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toBe(await fs.readFile(skillPath, "utf8"));
    expect(result.details).toMatchObject({ truncated: false, start_line: 1 });

    await expect(tool.execute(
      "read-source",
      { path: path.resolve("package.json") },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("restricted to approved installed skill files");
    await expect(tool.execute(
      "read-license",
      { path: path.resolve("skills/sandbox-files/../../README.md") },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("restricted to approved installed skill files");
  });

  it("blocks symlinks that escape an approved skill directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-office-skills-"));
    tempRoots.push(root);
    const docxRoot = path.join(root, "skills/docx-cli");
    const pptxRoot = path.join(root, "skills/pptxgenjs");
    await fs.mkdir(docxRoot, { recursive: true });
    await fs.mkdir(pptxRoot, { recursive: true });
    await fs.symlink(path.resolve("package.json"), path.join(docxRoot, "SKILL.md"));

    const tool = createApprovedSkillReadTool(root);
    await expect(tool.execute(
      "read-escape",
      { path: path.join(docxRoot, "SKILL.md") },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("restricted to approved installed skill files");
  });
});
