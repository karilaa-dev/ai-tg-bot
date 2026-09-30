import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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

export const APPROVED_PI_SKILLS = [...OFFICE_SKILLS, ...SANDBOX_FILE_SKILLS, ...OPENSCAD_SKILLS] as const;

const MAX_SKILL_READ_LINES = 2_000;
const validationPromises = new Map<string, Promise<void>>();

export function officeSkillPaths(cwd = process.cwd()): string[] {
  return OFFICE_SKILLS.map((skill) => path.resolve(cwd, skill.relativePath));
}

export function approvedSkillPaths(cwd = process.cwd()): string[] {
  return APPROVED_PI_SKILLS.map((skill) => path.resolve(cwd, skill.relativePath));
}

export function validateOfficeSkills(cwd = process.cwd()): Promise<void> {
  const root = path.resolve(cwd);
  let pending = validationPromises.get(root);
  if (!pending) {
    pending = validateOfficeSkillsUncached(root).catch((error) => {
      validationPromises.delete(root);
      throw error;
    });
    validationPromises.set(root, pending);
  }
  return pending;
}

export function validateApprovedSkills(cwd = process.cwd()): Promise<void> {
  return validateSkills(cwd, APPROVED_PI_SKILLS);
}

export function createApprovedSkillReadTool(cwd = process.cwd()): ToolDefinition {
  const roots = APPROVED_PI_SKILLS.map((skill) => path.dirname(path.resolve(cwd, skill.relativePath)));
  return {
    name: "read",
    label: "Read skill",
    description:
      "Read an approved installed Pi skill file by its advertised path. This tool cannot read bot source, credentials, Telegram attachments, or E2B workspace files; use the corresponding chat or sandbox tools for those.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 4_096 }),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SKILL_READ_LINES })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as { path: string; offset?: number; limit?: number };
      signal?.throwIfAborted();
      const resolvedRoots = await Promise.allSettled(roots.map((root) => fs.realpath(root)));
      const approvedRoots = resolvedRoots.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const requested = path.isAbsolute(params.path)
        ? params.path
        : path.resolve(cwd, params.path);
      const canonical = await fs.realpath(requested);
      if (!approvedRoots.some((root) => isSameOrDescendant(canonical, root))) {
        throw new Error("The read tool is restricted to approved installed skill files.");
      }
      const stat = await fs.stat(canonical);
      if (!stat.isFile()) throw new Error("The requested skill path is not a file.");
      const text = await fs.readFile(canonical, "utf8");
      signal?.throwIfAborted();
      const lines = text.split(/\r?\n/u);
      const offset = params.offset ?? 1;
      const limit = params.limit ?? MAX_SKILL_READ_LINES;
      const start = Math.min(lines.length, offset - 1);
      const selected = lines.slice(start, start + limit);
      const end = start + selected.length;
      const truncated = end < lines.length;
      const suffix = truncated
        ? `\n\n[Truncated: showing lines ${start + 1}-${end} of ${lines.length}. Continue with offset=${end + 1}.]`
        : "";
      return {
        content: [{ type: "text", text: `${selected.join("\n")}${suffix}` }],
        details: {
          path: canonical,
          start_line: selected.length ? start + 1 : null,
          end_line: selected.length ? end : null,
          total_lines: lines.length,
          truncated,
        },
      };
    },
  };
}

async function validateOfficeSkillsUncached(cwd: string): Promise<void> {
  await validateSkills(cwd, OFFICE_SKILLS);
}

async function validateSkills(
  cwd: string,
  skills: ReadonlyArray<{ name: string; relativePath: string; sha256: string }>,
): Promise<void> {
  for (const skill of skills) {
    const filePath = path.resolve(cwd, skill.relativePath);
    const bytes = await fs.readFile(filePath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== skill.sha256) {
      throw new Error(`Pinned ${skill.name} skill hash mismatch: expected ${skill.sha256}, got ${actual}.`);
    }
  }
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
