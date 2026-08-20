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
    sha256: "1da56ed53a308222ab2516a2974ae98c6703b7d504fa5158348c39a18e85a4f1",
  },
  {
    name: "officecli-pptx",
    relativePath: "skills/officecli-pptx/SKILL.md",
    sha256: "0d53192751d5770984f16f3c34f9923377651555c667150d7f96e16e8c9757b3",
  },
] as const;

const MAX_SKILL_READ_LINES = 2_000;
const validationPromises = new Map<string, Promise<void>>();

export function officeSkillPaths(cwd = process.cwd()): string[] {
  return OFFICECLI_SKILLS.map((skill) => path.resolve(cwd, skill.relativePath));
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

export function createOfficeSkillReadTool(cwd = process.cwd()): ToolDefinition {
  const roots = OFFICECLI_SKILLS.map((skill) => path.dirname(path.resolve(cwd, skill.relativePath)));
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
      const approvedRoots = await Promise.all(roots.map((root) => fs.realpath(root)));
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
  for (const skill of OFFICECLI_SKILLS) {
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
