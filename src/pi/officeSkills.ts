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
    "sha256": "b47e5fc83bc2186e02b3ae1ccaa4af7541c73f1ccd5ac3a8d44a77952f653632"
  },
  {
    "name": "pptxgenjs",
    "relativePath": "skills/pptxgenjs/SKILL.md",
    "sha256": "ee9bfdd5d1d1d7aa55e5b5cd2af40584ac0c6941fb1cea12b2eda89570e922c4"
  },
  {
    "name": "pptx-edit",
    "relativePath": "skills/pptx-edit/SKILL.md",
    "sha256": "ede764eb9a1f1d2fddb7e52736f29f165535ba3fa5d90b86f76a1094d0cd349d"
  },
  {
    "name": "xlsx",
    "relativePath": "skills/xlsx/SKILL.md",
    "sha256": "c33eafaaf9d21ba5ebbd6d577f2859377c7fd764dbdf5ec45170a8ec90a41c23"
  }
] as const;

const SANDBOX_FILE_SKILLS = [
  {
    name: "sandbox-files",
    relativePath: "skills/sandbox-files/SKILL.md",
    sha256: "4540a0535723e4c9cd4c95b145f6ffe984609d56294feea5581acb2864e3f15c",
  },
] as const;

export const OPENSCAD_SKILLS = [
  {
    name: "openscad",
    relativePath: "skills/openscad/SKILL.md",
    sha256: "f2248d26a38700b01272a669160174c5c2e7539e7ab76b5c8975e75de9a874ea",
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
