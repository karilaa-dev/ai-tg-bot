import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type AppDatabase } from "../../src/db/index.js";
import { createRepos } from "../../src/db/repos/index.js";
import { loadTestConfig } from "../../src/config.js";
import { OfficeValidation, officeFormat } from "../../src/office/validation.js";
import { OutgoingFiles } from "../../src/files/outgoingFiles.js";
import { createCreateFileTool } from "../../src/ai/tools/createFile.js";
import { createFinishResponseTool } from "../../src/ai/tools/finishResponse.js";
import { createRenderOfficePreviewTool } from "../../src/ai/tools/renderOfficePreview.js";
import { workspaceRuntime } from "../helpers/workspaceRuntime.js";
let db: AppDatabase | undefined;
let outgoing: OutgoingFiles | undefined;
afterEach(async () => {
  await outgoing?.dispose();
  await db?.destroy();
  db = undefined;
  outgoing = undefined;
});
async function setup() {
  const config = loadTestConfig({ DB_URL: "sqlite::memory:" });
  db = createDatabase(config);
  await db.initialize();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: 9301, firstName: "Office" });
  const thread = await repos.threads.create({
    userId: user.tg_id,
    topicId: null,
    title: "Office",
  });
  const runtime = workspaceRuntime();
  runtime.put("/deck.pptx", Buffer.from("office candidate"));
  const officeValidation = new OfficeValidation({
    runtime,
    config,
    userId: user.tg_id,
    threadId: thread.id,
  });
  outgoing = new OutgoingFiles({
    config,
    repos,
    user,
    thread,
    commandRuntime: runtime,
    officeValidation,
  });
  const input = {
    config,
    db,
    repos,
    user,
    thread,
    commandRuntime: runtime,
    officeValidation,
    outgoingFiles: outgoing,
    responseDraft: { text: "" },
  };
  async function approve() {
    const tool = createRenderOfficePreviewTool(input);
    const result = await tool.execute({ path: "/deck.pptx", pages: [1, 2] });
    if ("error" in result) throw new Error(result.error);
    await tool.toModelOutput!({
      toolCallId: "review",
      input: { path: "/deck.pptx" },
      output: result,
    });
    return officeValidation.validate(
      "/deck.pptx",
      result.source_sha256,
      [1, 2].map((page) => ({ page, status: "passed", issues: [] })),
    );
  }
  return { input, runtime, approve };
}
describe("Office delivery gate", () => {
  it("can finish with a blocker and retain failed drafts without attaching them", async () => {
    const { input, runtime } = await setup();
    const finish = createFinishResponseTool(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        await finish.execute({
          files: [{ path: "/deck.pptx", delivery: "auto" }],
        }),
      ).toMatchObject({ completed: false });
    }
    expect(
      await finish.execute({
        text: "The draft could not pass validation; it remains in the workspace.",
        retain_drafts: ["/deck.pptx"],
      }),
    ).toMatchObject({ completed: true, file_ids: [] });
    expect(
      (
        await runtime.readWorkspaceFile({
          userId: input.user.tg_id,
          threadId: input.thread.id,
          virtualPath: "/deck.pptx",
          maxBytes: 1000,
        })
      ).bytes.toString(),
    ).toBe("office candidate");
  });
  it("blocks create_file and finish_response until every page is reviewed", async () => {
    const { input, approve } = await setup();
    expect(
      await createCreateFileTool(input).execute({
        path: "/deck.pptx",
        delivery: "auto",
      }),
    ).toHaveProperty("error");
    expect(
      await createFinishResponseTool(input).execute({
        files: [{ path: "/deck.pptx", delivery: "auto" }],
      }),
    ).toMatchObject({ completed: false });
    expect(input.outgoingFiles.items).toHaveLength(0);
    expect((await approve()).approved).toBe(true);
    expect(
      await createFinishResponseTool(input).execute({
        text: "Done",
        files: [{ path: "/deck.pptx", delivery: "auto" }],
      }),
    ).toMatchObject({ completed: true });
    expect(input.outgoingFiles.items[0]?.caption).toBeNull();
  });
  it("stages direct Office byte exports for review instead of bypassing the gate", async () => {
    const { input, runtime } = await setup();
    await expect(
      input.outgoingFiles.bytes(async () => ({
        name: "download.docx",
        bytes: Buffer.from("unvalidated"),
      })),
    ).rejects.toThrow("File staged at /office-imports/");
    expect(input.outgoingFiles.items).toHaveLength(0);
    expect(
      [...runtime.files.keys()].some((path) =>
        path.includes("/office-imports/"),
      ),
    ).toBe(true);
  });
  it("preserves a requested Office caption without adding internal check details", async () => {
    const { input, approve } = await setup();
    await approve();
    const caption = "Токио: транспорт, архитектура и городская среда.";
    await input.outgoingFiles.workspace([{ path: "/deck.pptx", caption }]);
    expect(input.outgoingFiles.items[0]?.caption).toBe(caption);
  });
  it("invalidates changed bytes and removes the stale queued replacement", async () => {
    const { input, runtime, approve } = await setup();
    await approve();
    await input.outgoingFiles.workspace([{ path: "/deck.pptx" }]);
    const id = input.outgoingFiles.items[0]!.fileId;
    runtime.put("/deck.pptx", Buffer.from("changed candidate"));
    const result = await input.outgoingFiles.workspace([
      { path: "/deck.pptx" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(input.outgoingFiles.items).toHaveLength(0);
    expect(await input.repos.files.get(id)).toBeUndefined();
    expect(
      await createFinishResponseTool(input).execute({ text: "Done" }),
    ).toMatchObject({ completed: false });
  });
  it("does not allow renamed Office packages or alternate MIME types to evade checks", () => {
    expect(
      officeFormat(
        "download.zip",
        undefined,
        Buffer.from("PK\x03\x04 word/document.xml"),
      ),
    ).toBe(".docx");
    expect(
      officeFormat(
        "download.bin",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Buffer.alloc(0),
      ),
    ).toBe(".pptx");
    expect(
      officeFormat("note.txt", "text/plain", Buffer.from("word/document.xml")),
    ).toBeUndefined();
  });
  it("checks queued Office sources again even when finish_response has no files", async () => {
    const { input, runtime, approve } = await setup();
    await approve();
    await input.outgoingFiles.workspace([{ path: "/deck.pptx" }]);
    runtime.put("/deck.pptx", Buffer.from("changed after queuing"));
    expect(
      await createFinishResponseTool(input).execute({ text: "Done" }),
    ).toMatchObject({ completed: false });
    expect(input.outgoingFiles.items).toHaveLength(0);
  });
});
