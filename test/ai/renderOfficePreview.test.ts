import { describe, it, expect } from "vitest";
import { workspaceRuntime } from "../helpers/workspaceRuntime.js";
import { loadTestConfig } from "../../src/config.js";
import { OfficeValidation } from "../../src/office/validation.js";
import { createRenderOfficePreviewTool } from "../../src/ai/tools/renderOfficePreview.js";
import type { ToolBuildInput } from "../../src/ai/tools/types.js";

export function officeTestSetup() {
  const runtime = workspaceRuntime();
  const bytes = Buffer.from("deck revision one");
  runtime.put("/deck.pptx", bytes);
  const config = loadTestConfig();
  const officeValidation = new OfficeValidation({
    runtime,
    config,
    userId: 1,
    threadId: 2,
  });
  const input = {
    config,
    user: { tg_id: 1 },
    thread: { id: 2 },
    commandRuntime: runtime,
    officeValidation,
  } as unknown as ToolBuildInput;
  return {
    runtime,
    bytes,
    officeValidation,
    tool: createRenderOfficePreviewTool(input),
  };
}
describe("actual Office previews", () => {
  it("renders multiple pages without a browser, strips image bytes from details, and requires explicit visual review", async () => {
    const { tool, officeValidation } = officeTestSetup();
    const output = await tool.execute({ path: "/deck.pptx", pages: [1, 2] });
    if ("error" in output) throw new Error(output.error);
    expect(output.page_count).toBe(2);
    expect(output.images).toHaveLength(2);
    expect((await officeValidation.validate("/deck.pptx")).approved).toBe(
      false,
    );
    await expect(
      officeValidation.validate("/deck.pptx", output.source_sha256, [
        { page: 1, status: "passed", issues: [] },
      ]),
    ).rejects.toThrow("not been returned");
    const model = await tool.toModelOutput!({
      toolCallId: "preview",
      input: { path: "/deck.pptx", pages: [1, 2] },
      output,
    });
    expect(model).toMatchObject({ type: "content" });
    const details = await tool.toToolDetails!({
      toolCallId: "preview",
      input: { path: "/deck.pptx" },
      output,
    });
    expect(JSON.stringify(details)).not.toContain("image_base64");
    const report = await officeValidation.validate(
      "/deck.pptx",
      output.source_sha256,
      [1, 2].map((page) => ({ page, status: "passed", issues: [] })),
    );
    expect(report.approved).toBe(true);
  });
  it("supports legacy single-page input and rejects missing pages", async () => {
    const { tool } = officeTestSetup();
    expect(await tool.execute({ path: "/deck.pptx", page: 2 })).toMatchObject({
      images: [{ page: 2 }],
    });
    expect(
      await tool.execute({ path: "/deck.pptx", pages: [3] }),
    ).toHaveProperty("error");
    expect(
      await tool.execute({ path: "/deck.pptx", pages: [1, 1] }),
    ).toHaveProperty("error");
    expect(
      await tool.inputSchema.safeParseAsync({
        path: "/deck.pptx",
        page: 1,
        pages: [1],
      }),
    ).toMatchObject({ success: false });
  });
  it("rejects stale reviews and failed structural checks", async () => {
    const { tool, runtime, officeValidation, bytes } = officeTestSetup();
    const output = await tool.execute({ path: "/deck.pptx", pages: [1, 2] });
    if ("error" in output) throw new Error(output.error);
    await tool.toModelOutput!({
      toolCallId: "preview",
      input: { path: "/deck.pptx" },
      output,
    });
    await officeValidation.validate(
      "/deck.pptx",
      output.source_sha256,
      [1, 2].map((page) => ({ page, status: "passed", issues: [] })),
    );
    expect(() => officeValidation.assertApproved(bytes)).not.toThrow();
    runtime.put("/deck.pptx", Buffer.from("changed deck"));
    runtime.setChecks([
      {
        name: "ooxml_package",
        status: "failed",
        issues: ["broken relationship"],
      },
    ]);
    await expect(
      officeValidation.validate("/deck.pptx", output.source_sha256, [
        { page: 1, status: "passed", issues: [] },
      ]),
    ).rejects.toThrow("stale");
    expect(() =>
      officeValidation.assertApproved(Buffer.from("changed deck")),
    ).toThrow("validation required");
    expect(
      (await officeValidation.validate("/deck.pptx")).checks[0]?.status,
    ).toBe("failed");
  });
  it("withholds approval for partial, failed, or unavailable reviews and checks", async () => {
    const { tool, runtime, officeValidation, bytes } = officeTestSetup();
    const output = await tool.execute({ path: "/deck.pptx", pages: [1, 2] });
    if ("error" in output) throw new Error(output.error);
    await tool.toModelOutput!({
      toolCallId: "preview",
      input: { path: "/deck.pptx" },
      output,
    });
    expect(
      (
        await officeValidation.validate("/deck.pptx", output.source_sha256, [
          { page: 1, status: "passed", issues: [] },
        ])
      ).approved,
    ).toBe(false);
    expect(
      (
        await officeValidation.validate("/deck.pptx", output.source_sha256, [
          { page: 2, status: "failed", issues: ["Clipped title"] },
        ])
      ).approved,
    ).toBe(false);
    expect(() => officeValidation.assertApproved(bytes)).toThrow(
      "validation required",
    );
    officeValidation.clear();
    runtime.setChecks([
      {
        name: "actual_file_render",
        status: "unavailable",
        issues: ["LibreOffice missing"],
      },
    ]);
    expect((await officeValidation.validate("/deck.pptx")).approved).toBe(
      false,
    );
  });
});
