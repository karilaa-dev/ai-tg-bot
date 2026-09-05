import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { CommandRuntime } from "../sandbox/types.js";
import { E2B_WORKSPACE, sandboxWorkspaceFile } from "../e2b/paths.js";
import { MAX_FILE_BYTES } from "../files/limits.js";
import { sha256Hex } from "../files/hash.js";

export const OfficeCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["passed", "failed", "unavailable", "not_run"]),
  issues: z.array(z.string()),
  detail: z.unknown().optional(),
});
const RenderReportSchema = z.object({
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  checks: z.array(OfficeCheckSchema).min(1),
  page_count: z.number().int().nonnegative(),
  renderer: z.literal("LibreOffice"),
  renderer_version: z.string(),
  pdf_path: z.string().nullable(),
  elapsed_ms: z.number(),
  peak_child_rss_kib: z.number(),
});
export const VisualReviewSchema = z.object({
  page: z.number().int().positive(),
  status: z.enum(["passed", "failed"]),
  issues: z.array(z.string().min(1)).max(20).default([]),
});
export type VisualReview = z.infer<typeof VisualReviewSchema>;
type RenderReport = z.infer<typeof RenderReportSchema>;
type Entry = {
  format: OfficeFormat;
  report: RenderReport;
  directory: string;
  seen: Set<number>;
  reviews: Map<number, VisualReview>;
};
type OfficeFormat = ".docx" | ".pptx" | ".xlsx";
const OFFICE_MIME: Record<OfficeFormat, string> = {
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function officeFormat(
  name: string,
  mime: string | undefined | null,
  bytes: Buffer,
): ".docx" | ".pptx" | ".xlsx" | undefined {
  const extension = path.posix.extname(name).toLowerCase();
  if (extension === ".docx" || extension === ".pptx" || extension === ".xlsx")
    return extension;
  for (const [format, part, media] of [
    [".docx", "word/document.xml", "wordprocessingml.document"],
    [".pptx", "ppt/presentation.xml", "presentationml.presentation"],
    [".xlsx", "xl/workbook.xml", "spreadsheetml.sheet"],
  ] as const) {
    if (
      mime?.includes(media) ||
      (bytes.subarray(0, 2).toString() === "PK" &&
        bytes.includes(Buffer.from(part)))
    )
      return format;
  }
  return undefined;
}

/** Host-owned review state. Sandbox reports cannot grant their own visual approval. */
export class OfficeValidation {
  private readonly entries = new Map<string, Entry>();
  private readonly scratchDirectories = new Set<string>();
  constructor(
    private readonly input: {
      runtime?: CommandRuntime;
      config: AppConfig;
      userId: number;
      threadId: number;
    },
  ) {}
  clear(): void {
    this.entries.clear();
  }

  async dispose(): Promise<void> {
    this.clear();
    if (!this.scratchDirectories.size || !this.input.runtime) return;
    const directories = [...this.scratchDirectories];
    const result = await this.input.runtime.execute({
      userId: this.input.userId,
      threadId: this.input.threadId,
      command: "rm",
      args: ["-rf", "--", ...directories.map(sandboxWorkspaceFile)],
      env: {},
      stdin: "",
      workingDir: E2B_WORKSPACE,
      timeoutMs: this.input.config.BASH_TIMEOUT_MS,
      maxOutputChars: 1000,
    });
    if (result.exitCode !== 0 || result.error || result.timedOut)
      throw new Error(result.error || "Office preview cleanup failed");
    for (const directory of directories)
      this.scratchDirectories.delete(directory);
  }

  private async command(args: string[], signal?: AbortSignal) {
    const runtime = this.input.runtime;
    if (!runtime) throw new Error("E2B command runtime is unavailable.");
    const result = await runtime.execute({
      userId: this.input.userId,
      threadId: this.input.threadId,
      command: "office-files",
      args,
      env: { TZ: "UTC" },
      stdin: "",
      workingDir: E2B_WORKSPACE,
      timeoutMs: this.input.config.BASH_TIMEOUT_MS,
      maxOutputChars: 32_000,
      signal,
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.error ||
      result.stdoutTruncated
    )
      throw new Error(
        result.error || result.stderr || result.stdout || "Office check failed",
      );
    return result.stdout;
  }

  private async entry(
    virtualPath: string,
    signal?: AbortSignal,
  ): Promise<Entry> {
    const runtime = this.input.runtime;
    if (!runtime?.writeWorkspaceFile)
      throw new Error("E2B Office workspace support is unavailable.");
    const source = await runtime.readWorkspaceFile({
      userId: this.input.userId,
      threadId: this.input.threadId,
      virtualPath,
      maxBytes: MAX_FILE_BYTES,
      signal,
    });
    const hash = sha256Hex(source.bytes);
    const format = officeFormat(virtualPath, undefined, source.bytes);
    if (!format)
      throw new Error("Office validation accepts DOCX, PPTX, and XLSX files.");
    const existing = this.entries.get(hash);
    if (existing && existing.format !== format)
      throw new Error(
        `Office format mismatch: these bytes were validated as ${existing.format}.`,
      );
    if (
      existing &&
      existing.report.checks.every((check) => check.status === "passed")
    )
      return existing;
    const directory = `/.office-qa/${randomUUID()}`;
    this.scratchDirectories.add(directory);
    const snapshotPath = `${directory}/source${format}`;
    await runtime.writeWorkspaceFile({
      userId: this.input.userId,
      threadId: this.input.threadId,
      virtualPath: snapshotPath,
      bytes: source.bytes,
      signal,
    });
    const stdout = await this.command(
      [
        "validate",
        sandboxWorkspaceFile(snapshotPath),
        sandboxWorkspaceFile(directory),
      ],
      signal,
    );
    const report = RenderReportSchema.parse(JSON.parse(stdout));
    const names = new Set(report.checks.map((check) => check.name));
    if (names.size !== report.checks.length)
      throw new Error("Office validation returned duplicate checks.");
    const required = [
      "ooxml_package",
      "actual_file_render",
      ...(format === ".docx"
        ? ["docx_schema"]
        : format === ".pptx"
          ? ["pptx_readability"]
          : ["xlsx_readability", "xlsx_formulas"]),
    ];
    for (const name of required) {
      if (!names.has(name))
        report.checks.push({
          name,
          status: "not_run",
          issues: ["Required check was not returned by the validator"],
        });
    }
    if (report.source_sha256 !== hash)
      throw new Error("Office source changed during validation.");
    if (
      report.pdf_path &&
      path.posix.dirname(report.pdf_path) !== sandboxWorkspaceFile(directory)
    )
      throw new Error("Office renderer returned an invalid artifact path.");
    const entry = {
      format,
      report,
      directory,
      seen: new Set<number>(),
      reviews: new Map<number, VisualReview>(),
    };
    this.entries.set(hash, entry);
    return entry;
  }

  async validate(
    virtualPath: string,
    sourceHash?: string,
    reviews: VisualReview[] = [],
    signal?: AbortSignal,
  ) {
    const entry = await this.entry(virtualPath, signal);
    if (reviews.length && sourceHash !== entry.report.source_sha256)
      throw new Error(
        "Visual review is stale. Render and review the current file.",
      );
    if (new Set(reviews.map((r) => r.page)).size !== reviews.length)
      throw new Error("Review page numbers must be unique.");
    for (const review of reviews) {
      if (!entry.seen.has(review.page))
        throw new Error(
          `Page ${review.page} has not been returned to the model. Render it before recording review.`,
        );
      if (review.status === "passed" && review.issues.length)
        throw new Error("A passed review cannot contain unresolved issues.");
    }
    for (const review of reviews) entry.reviews.set(review.page, review);
    return this.report(entry, virtualPath);
  }

  private report(entry: Entry, virtualPath: string) {
    const { pdf_path: _pdf, ...report } = entry.report;
    const reviews = [...entry.reviews.values()].sort((a, b) => a.page - b.page);
    const passed = reviews.filter((r) => r.status === "passed").length;
    return {
      ...report,
      path: virtualPath,
      visual_review: {
        status: reviews.some((r) => r.status === "failed")
          ? "failed"
          : passed === report.page_count && passed > 0
            ? "passed"
            : "not_run",
        reviewed_pages: reviews,
        rendered_pages: [...entry.seen].sort((a, b) => a - b),
        passed_pages: passed,
      },
      approved: this.approved(entry),
    };
  }

  private approved(entry: Entry): boolean {
    return (
      entry.report.checks.every(
        (check) => check.status === "passed" && !check.issues.length,
      ) &&
      Boolean(entry.report.pdf_path && entry.report.renderer_version) &&
      entry.report.page_count > 0 &&
      Array.from(
        { length: entry.report.page_count },
        (_, index) => index + 1,
      ).every(
        (page) =>
          entry.seen.has(page) && entry.reviews.get(page)?.status === "passed",
      )
    );
  }

  async preview(virtualPath: string, pages: number[], signal?: AbortSignal) {
    const entry = await this.entry(virtualPath, signal);
    if (!entry.report.pdf_path)
      throw new Error(
        "Actual-file rendering failed. Run validate_office_file for the check results.",
      );
    if (
      pages.length < 1 ||
      pages.length > 4 ||
      new Set(pages).size !== pages.length ||
      pages.some(
        (p) => !Number.isInteger(p) || p < 1 || p > entry.report.page_count,
      )
    )
      throw new Error(
        `Choose 1 to 4 unique pages between 1 and ${entry.report.page_count}.`,
      );
    await this.command(
      [
        "pages",
        entry.report.pdf_path,
        sandboxWorkspaceFile(entry.directory),
        ...pages.map(String),
      ],
      signal,
    );
    const images = [];
    for (const page of pages) {
      const file = await this.input.runtime!.readWorkspaceFile({
        userId: this.input.userId,
        threadId: this.input.threadId,
        virtualPath: `${entry.directory}/page-${page}.jpg`,
        maxBytes: MAX_FILE_BYTES,
        signal,
      });
      images.push({
        page,
        media_type: "image/jpeg" as const,
        size: file.size,
        image_base64: file.bytes.toString("base64"),
      });
    }
    return {
      rendered: true as const,
      path: virtualPath,
      source_sha256: entry.report.source_sha256,
      page_count: entry.report.page_count,
      renderer: entry.report.renderer,
      renderer_version: entry.report.renderer_version,
      images,
    };
  }

  markSeen(hash: string, pages: number[]): void {
    const entry = this.entries.get(hash);
    if (!entry) throw new Error("Office preview is no longer available.");
    for (const page of pages) entry.seen.add(page);
  }

  assertApproved(
    bytes: Buffer,
    delivery?: { name: string; mime?: string | null },
  ): void {
    this.assertApprovedHash(sha256Hex(bytes), delivery);
  }

  assertApprovedHash(
    hash: string,
    delivery?: { name: string; mime?: string | null },
  ): void {
    const entry = this.entries.get(hash);
    if (!entry || !this.approved(entry))
      throw new Error(
        "Office validation required: run validate_office_file, render every page with render_office_preview, then record passing visual_reviews for this source_sha256.",
      );
    if (delivery) {
      const extension = path.posix.extname(delivery.name).toLowerCase();
      const mime = delivery.mime?.split(";", 1)[0]?.trim().toLowerCase();
      if (
        extension !== entry.format ||
        (mime &&
          mime !== "application/octet-stream" &&
          mime !== OFFICE_MIME[entry.format])
      )
        throw new Error(
          `Office delivery format mismatch: validated ${entry.format}; use that extension and ${OFFICE_MIME[entry.format]}.`,
        );
    }
  }
}
