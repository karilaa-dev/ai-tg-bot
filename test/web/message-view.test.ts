import { expect, it } from "vitest";
import type { MessageRow } from "../../src/db/types.js";
import { messageView } from "../../src/web/message-view.js";
import type { WebAttachment } from "../../src/web/types.js";

const image: WebAttachment = { id: 1, kind: "image", name: "photo.jpg", mimeType: "image/jpeg", size: 500, caption: "Make a picture", description: "A cat [with stripes]." };
const audio: WebAttachment = { id: 2, kind: "audio", name: "voice.ogg", mimeType: "audio/ogg", size: 500, caption: null };
function message(text: string, content: unknown = {}): MessageRow {
  return { id: 10, thread_id: 1, role: "user", kind: "file", text_plain: text, content_json: JSON.stringify(content), thinking: null, created_at: 0, tg_message_id: null, pi_entry_id: null };
}

it("moves photo descriptions into image details while retaining the caption and following text", () => {
  const view = messageView(message("Make a picture\n\n[[chat-file:1]] [image #1: A cat [with stripes].]\n\nKeep this too."), [image]);
  expect(view.text).toBe("Make a picture\n\nKeep this too.");
  expect(view.attachments[0]?.description).toBe("A cat [with stripes].");
});

it("separates each audio transcription from captions in mixed albums", () => {
  const second = { ...audio, id: 3 };
  const view = messageView(message("Use both parts\n\nFirst part.\n\n[[chat-file:2]] [Audio message transcribed above]\n\n[[chat-file:1]] [image #1: A cat [with stripes].]\n\nSecond part.\n\n[[chat-file:3]] [Audio message transcribed above]", { captions: ["Use both parts"] }), [audio, image, second]);
  expect(view.text).toBe("Use both parts");
  expect(view.attachments.map(f => f.transcription)).toEqual(["First part.", undefined, "Second part."]);
});

it("replaces a long preview only with the transcript belonging to this message and file", () => {
  const text = 'Preview\n\n[[chat-file:2]] [Audio transcript preview; full transcript saved (9000 characters). Read more with transcribe_audio({"transcript_id":"saved","offset":8000}).]';
  const row = message(text);
  const saved = { id: "saved", fileId: 2, messageId: 10, text: "Full text" };
  expect(messageView(row, [audio], [saved]).attachments[0]).toMatchObject({ transcription: "Full text", transcriptionTruncated: false });
  for (const mismatch of [{ messageId: 20 }, { fileId: 9 }, { id: "other" }]) {
    expect(messageView(row, [audio], [{ ...saved, ...mismatch }]).attachments[0]).toMatchObject({ transcription: "Preview", transcriptionTruncated: true });
  }
  expect(messageView(row, [audio], [saved]).text).toBe("");
});

it("keeps ordinary messages, unrelated markers, and unrecognized cards intact", () => {
  const text = 'Literal [[chat-file:2]] and code\n\n[[chat-file:99]] [image #99: Unrelated]\n\n[[chat-file:1]] Unrecognized format';
  expect(messageView(message(text), [audio, image]).text).toBe(text);
  const literal = message("[[chat-file:1]] [image #1: A cat [with stripes].]");
  literal.kind = "text";
  expect(messageView(literal, [image]).text).toBe(literal.text_plain);
});
