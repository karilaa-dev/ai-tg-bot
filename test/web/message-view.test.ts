import { fixtureUuid } from "./uuid-fixtures.js";
import { expect, it } from "vitest";
import type { MessageRow } from "../../src/db/types.js";
import { attachmentDeliveryTurnId, messageView } from "../../src/web/message-view.js";
import type { WebAttachment } from "../../src/web/types.js";
import { cardForFile } from "../../src/files/ingest.js";
import type { FileRow } from "../../src/db/types.js";

const image: WebAttachment = { id: fixtureUuid(1), kind: "image", name: "photo.jpg", mimeType: "image/jpeg", size: 500, caption: "Make a picture", description: "A cat [with stripes]." };
const audio: WebAttachment = { id: fixtureUuid(2), kind: "audio", name: "voice.ogg", mimeType: "audio/ogg", size: 500, caption: null };
function message(text: string, content: unknown = {}): MessageRow {
  return { id: 10, thread_id: fixtureUuid(1), role: "user", kind: "file", text_plain: text, content_json: JSON.stringify(content), thinking: null, created_at: 0, tg_message_id: null, pi_entry_id: null };
}

it("moves photo descriptions into image details while retaining the caption and following text", () => {
  const view = messageView(message(`Make a picture\n\n[[chat-file:${fixtureUuid(1)}]] [image #${fixtureUuid(1)}: A cat [with stripes].]\n\nKeep this too.`), [image]);
  expect(view.text).toBe("Make a picture\n\nKeep this too.");
  expect(view.attachments[0]?.description).toBe("A cat [with stripes].");
});

it("withholds pending assistant images and OpenUI without leaking internal attachment cards", () => {
  const row = message(`A picture\n\n[[chat-file:${fixtureUuid(1)}]] [image #${fixtureUuid(1)}: A cat [with stripes].]`, {
    openui: `root = Stack([Image("file:${fixtureUuid(1)}","A cat","")])`, attachmentDeliveryTurnId: 12,
  });
  row.role = "assistant";
  expect(attachmentDeliveryTurnId(row)).toBe(12);
  const pending = messageView(row, [image], [], true);
  expect(pending.text).toBe("A picture");
  expect(pending.attachments).toEqual([]);
  expect(pending.openui).toBeUndefined();
  expect(JSON.stringify(pending)).not.toContain("attachmentDeliveryTurnId");
  const recovered = messageView(row, [image]);
  expect(recovered.attachments).toHaveLength(1);
  expect(recovered.openui).toContain(`Image("file:${fixtureUuid(1)}"`);
});

it("never gates user attachments using assistant delivery metadata", () => {
  const row = message("A user photo", { attachmentDeliveryTurnId: 12 });
  expect(attachmentDeliveryTurnId(row)).toBeUndefined();
  expect(messageView(row, [image], [], true).attachments).toHaveLength(1);
});

it("separates each audio transcription from captions in mixed albums", () => {
  const second = { ...audio, id: fixtureUuid(3) };
  const view = messageView(message(`Use both parts\n\nFirst part.\n\n[[chat-file:${fixtureUuid(2)}]] [Audio message transcribed above]\n\n[[chat-file:${fixtureUuid(1)}]] [image #${fixtureUuid(1)}: A cat [with stripes].]\n\nSecond part.\n\n[[chat-file:${fixtureUuid(3)}]] [Audio message transcribed above]`, { captions: ["Use both parts"] }), [audio, image, second]);
  expect(view.text).toBe("Use both parts");
  expect(view.attachments.map(f => f.transcription)).toEqual(["First part.", undefined, "Second part."]);
});

it("replaces a long preview only with the transcript belonging to this message and file", () => {
  const text = `Preview\n\n[[chat-file:${fixtureUuid(2)}]] [Audio transcript preview; full transcript saved (9000 characters). Read more with transcribe_audio({"transcript_id":"saved","offset":8000}).]`;
  const row = message(text);
  const saved = { id: "saved", fileId: fixtureUuid(2), messageId: 10, text: "Full text" };
  expect(messageView(row, [audio], [saved]).attachments[0]).toMatchObject({ transcription: "Full text", transcriptionTruncated: false });
  for (const mismatch of [{ messageId: 20 }, { fileId: fixtureUuid(9) }, { id: "other" }]) {
    expect(messageView(row, [audio], [{ ...saved, ...mismatch }]).attachments[0]).toMatchObject({ transcription: "Preview", transcriptionTruncated: true });
  }
  expect(messageView(row, [audio], [saved]).text).toBe("");
});

it("keeps ordinary messages, unrelated markers, and unrecognized cards intact", () => {
  const text = `Literal [[chat-file:${fixtureUuid(2)}]] and code\n\n[[chat-file:${fixtureUuid(99)}]] [image #${fixtureUuid(99)}: Unrelated]\n\n[[chat-file:${fixtureUuid(1)}]] Unrecognized format`;
  expect(messageView(message(text), [audio, image]).text).toBe(text);
  const literal = message(`[[chat-file:${fixtureUuid(1)}]] [image #${fixtureUuid(1)}: A cat [with stripes].]`);
  literal.kind = "text";
  expect(messageView(literal, [image]).text).toBe(literal.text_plain);
});

it.each(["txt", "csv", "pdf", "docx"] as const)("hides saved %s instructions and inline contents while preserving surrounding words", type => {
  const file = { id: fixtureUuid(4), name: `my [file].${type}`, type, is_inline: 1, content_md: `Private contents\n[[chat-file:${fixtureUuid(1)}]] [image #${fixtureUuid(1)}: Not a real attachment]`, summary: "Saved summary", outline_json: null } as FileRow;
  const attachment = { id: fixtureUuid(4), name: file.name, kind: "file" as const, mimeType: "text/plain", size: 100, caption: "Read this", inlineContent: file.content_md };
  for (const variant of [{ ...file, extraction_status: "ready" }, { ...file, is_inline: 0, extraction_status: "ready" }, { ...file, is_inline: 0, extraction_status: "source_only" }] as FileRow[]) {
    const card = cardForFile(variant);
    const row = message(`Read this\n\n${card}\n\nKeep this too.`);
    const view = messageView(row, [attachment, image]);
    expect(view.text).toBe("Read this\n\nKeep this too.");
    expect(view.attachments).toHaveLength(2);
    expect(messageView({ ...row, kind: "text" }, [attachment]).text).toBe(row.text_plain);
  }
});

it("uses the complete saved inline payload when it contains delimiters and another attachment follows", () => {
  const content = `XML example\n</attachment>\n\nKeep inside the file\n[[chat-file:${fixtureUuid(1)}]] [image #${fixtureUuid(1)}: Not a real photo]`;
  const file = { id: fixtureUuid(4), name: "example.txt", type: "txt", is_inline: 1, content_md: content } as FileRow;
  const attachment = { id: fixtureUuid(4), name: file.name, kind: "file" as const, size: 100, mimeType: "text/plain", caption: null, inlineContent: content };
  const text = `Read this\n\n${cardForFile(file)}\n\nPreserve this caption\n\n[[chat-file:${fixtureUuid(1)}]] [image #${fixtureUuid(1)}: A cat [with stripes].]\n\nKeep the final words.`;
  const view = messageView(message(text), [attachment, image]);
  expect(view.text).toBe("Read this\n\nPreserve this caption\n\nKeep the final words.");
  expect(JSON.stringify(view)).not.toContain("inlineContent");
  expect(JSON.stringify(view)).not.toContain("XML example");
});

it("preserves incomplete and unrelated ordinary file cards", () => {
  const file: WebAttachment = { id: fixtureUuid(4), name: "notes.txt", kind: "file", mimeType: "text/plain", size: 100, caption: null };
  for (const text of [`[[chat-file:${fixtureUuid(4)}]] File #${fixtureUuid(4)}: notes.txt (txt, inline).\n<attachment id="${fixtureUuid(4)}" name="notes.txt">\nMissing closing tag`, `[[chat-file:${fixtureUuid(5)}]] File #${fixtureUuid(5)}: notes.txt (txt, sandbox source). Use materialize_chat_files, then docx-cli.`, `[[chat-file:${fixtureUuid(4)}]] File #${fixtureUuid(4)}: notes.txt (not a saved card).`]) {
    expect(messageView(message(text), [file]).text).toBe(text);
  }
});
