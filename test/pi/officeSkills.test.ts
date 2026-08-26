import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  loadSkills,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  OFFICECLI_SKILLS,
  OFFICECLI_SKILLS_REVISION,
  OPENSCAD_SKILLS,
  approvedSkillPaths,
  createApprovedSkillReadTool,
  officeSkillPaths,
  validateApprovedSkills,
  validateOfficeSkills,
} from "../../src/pi/officeSkills.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("pinned OfficeCLI Pi skills", () => {
  it("loads exactly the two reviewed, checksum-verified skills", async () => {
    await expect(validateOfficeSkills()).resolves.toBeUndefined();
    expect(OFFICECLI_SKILLS_REVISION).toMatch(/^[a-f0-9]{40}$/u);
    expect(OFFICECLI_SKILLS.map((skill) => skill.sha256))
      .toEqual(OFFICECLI_SKILLS.map(() => expect.stringMatching(/^[a-f0-9]{64}$/u)));

    const loaded = loadSkills({
      cwd: process.cwd(),
      agentDir: path.resolve("data/pi"),
      skillPaths: officeSkillPaths(),
      includeDefaults: false,
    });

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills.map((skill) => skill.name).sort()).toEqual([
      "officecli-docx",
      "officecli-pptx",
    ]);
    expect(loaded.skills.every((skill) => path.isAbsolute(skill.filePath))).toBe(true);

  });

  it("loads every approved local skill", async () => {
    await expect(validateApprovedSkills()).resolves.toBeUndefined();
    expect(OPENSCAD_SKILLS.map((skill) => skill.sha256))
      .toEqual([expect.stringMatching(/^[a-f0-9]{64}$/u)]);
    const loaded = loadSkills({
      cwd: process.cwd(),
      agentDir: path.resolve("data/pi"),
      skillPaths: approvedSkillPaths(),
      includeDefaults: false,
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills.map((skill) => skill.name).sort()).toEqual([
      "officecli-docx",
      "officecli-pptx",
      "openscad",
      "sandbox-files",
    ]);
  });

  it("keeps explicit OfficeCLI skills when default skill discovery is disabled", async () => {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: path.resolve("data/pi"),
      settingsManager: SettingsManager.inMemory(),
      additionalSkillPaths: officeSkillPaths(),
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();
    expect(loader.getSkills().diagnostics).toEqual([]);
    expect(loader.getSkills().skills.map((skill) => skill.name).sort()).toEqual([
      "officecli-docx",
      "officecli-pptx",
    ]);
  });

  it("reads a complete advertised skill but rejects all other host files", async () => {
    const tool = createApprovedSkillReadTool();
    const result = await tool.execute(
      "read-skill",
      { path: officeSkillPaths()[0]! },
      undefined,
      undefined,
      {} as never,
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("# OfficeCLI DOCX skill");
    expect(text).toContain("## Scope");
    expect(text).toContain("### Delivery gate");
    expect(result.details).toMatchObject({ truncated: false, start_line: 1 });

    const openscadResult = await tool.execute(
      "read-openscad",
      { path: path.resolve(OPENSCAD_SKILLS[0].relativePath) },
      undefined,
      undefined,
      {} as never,
    );
    const openscadText = openscadResult.content[0]?.type === "text" ? openscadResult.content[0].text : "";
    expect(openscadText).toContain("# OpenSCAD models");
    expect(openscadText).toContain("delivery: \"photo_only\"");
    await expect(tool.execute(
      "read-source",
      { path: path.resolve("package.json") },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("restricted to approved installed skill files");
    await expect(tool.execute(
      "read-license",
      { path: path.resolve("skills/officecli/LICENSE") },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("restricted to approved installed skill files");
  });

  it("blocks symlinks that escape an approved skill directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-office-skills-"));
    tempRoots.push(root);
    const docxRoot = path.join(root, "skills/officecli-docx");
    const pptxRoot = path.join(root, "skills/officecli-pptx");
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
