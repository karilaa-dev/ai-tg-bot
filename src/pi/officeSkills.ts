import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const OFFICECLI_SKILLS_REVISION = "b2f30dd9eaa7459b4d5b5ecc2387402f8e01d412";

export const OFFICECLI_SKILLS = [
  {
    name: "officecli-docx",
    relativePath: "skills/officecli-docx/SKILL.md",
    sha256: "e1540a821b78c6db605f8e676cd706cbba4f0f6136bc1a53a4f6df7229a104ae",
  },
  {
    name: "officecli-pptx",
    relativePath: "skills/officecli-pptx/SKILL.md",
    sha256: "254306663523b4ae89e3086c7e9ed520bb3e469eb78404b2e65c333621c21a1e",
  },
] as const;

export const SANDBOX_FILE_SKILLS = [
  {
    name: "sandbox-files",
    relativePath: "skills/sandbox-files/SKILL.md",
    sha256: "7257f17ac529849b6efb15d97bcdcaa84f535457e29f7c6c13358b8e41a923ac",
  },
] as const;

export const OPENSCAD_SKILLS = [
  {
    name: "openscad",
    relativePath: "skills/openscad/SKILL.md",
    sha256: "f2248d26a38700b01272a669160174c5c2e7539e7ab76b5c8975e75de9a874ea",
  },
] as const;

export const APPROVED_PI_SKILLS = [...OFFICECLI_SKILLS, ...SANDBOX_FILE_SKILLS, ...OPENSCAD_SKILLS] as const;

const MAX_SKILL_READ_LINES = 2_000;
const validationPromises = new Map<string, Promise<void>>();

export function officeSkillPaths(cwd = process.cwd()): string[] {
  return OFFICECLI_SKILLS.map((skill) => path.resolve(cwd, skill.relativePath));
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
  await validateSkills(cwd, OFFICECLI_SKILLS);
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
