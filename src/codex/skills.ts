import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export const DOCX_SKILL_REVISION = "e528738ed22d1294be7938d7614525b4a585fa56";

export const OFFICE_SKILLS = [
  {
    "name": "docx-cli",
    "relativePath": "skills/docx-cli/SKILL.md",
    "sha256": "e3b6458217b9c2e12d19074499f5276d172c9fec771501535ae535efd4776246"
  },
  {
    "name": "pptxgenjs",
    "relativePath": "skills/pptxgenjs/SKILL.md",
    "sha256": "59e90ed85ed1c9a7205b916761b4a3bda3ce8b62ecfa39a97d4ff3ae0bc90437"
  },
  {
    "name": "pptx-edit",
    "relativePath": "skills/pptx-edit/SKILL.md",
    "sha256": "071507abb38a94108d645f6038e4674b01d6e5573b9f306e4778dba87bce5818"
  },
  {
    "name": "xlsx",
    "relativePath": "skills/xlsx/SKILL.md",
    "sha256": "9dd8d8c1e008f60007be380509bf30f420f132671f86194c84fc759f7388952d"
  }
] as const;

const SANDBOX_FILE_SKILLS = [
  {
    name: "sandbox-files",
    relativePath: "skills/sandbox-files/SKILL.md",
    sha256: "065ed085355efc8bbc9cc9d870dee53956bed7dde1438ddaab624e4449f0a04c",
  },
] as const;

export const OPENSCAD_SKILLS = [
  {
    name: "openscad",
    relativePath: "skills/openscad/SKILL.md",
    sha256: "513896c7ac6bb87f46405ed9e920b524c08a9bfc60c7fa700478f2b2cc5ce874",
  },
] as const;

export const APPROVED_SKILLS = [...OFFICE_SKILLS, ...SANDBOX_FILE_SKILLS, ...OPENSCAD_SKILLS] as const;


export async function validateSkills(): Promise<void> {
  for (const skill of APPROVED_SKILLS) {
    const bytes = await fs.readFile(path.resolve(skill.relativePath));
    if (createHash("sha256").update(bytes).digest("hex") !== skill.sha256) throw new Error(`Pinned ${skill.name} skill hash mismatch.`);
  }
}

export async function skillInstructions(): Promise<string> {
  return "Available installed skills. Read the matching skill with read_skill before this work:\n" + (await Promise.all(APPROVED_SKILLS.map(async skill => {
    const text = await fs.readFile(skill.relativePath, "utf8");
    const description = text.match(/^description:\s*(.+)$/m)?.[1] ?? skill.name;
    return `- ${skill.name}: ${description}`;
  }))).join("\n");
}

export async function readSkill(name: string): Promise<string> {
  const skill = APPROVED_SKILLS.find(skill => skill.name === name);
  if (!skill) throw new Error("Unknown installed skill.");
  return fs.readFile(skill.relativePath, "utf8");
}
