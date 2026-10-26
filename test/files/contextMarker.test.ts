import { describe, expect, it } from "vitest";
import { chatFileIdsFromText, chatFileMarker } from "../../src/files/contextMarker.js";

const firstFileId = "d15a9ac0-4791-4f73-9487-a855f08b76ca";
const secondFileId = "0c44fc8e-4f4a-4414-88e8-a15219a862f8";

describe("chat file markers", () => {
  it("round-trips UUIDs and preserves the first appearance of each file", () => {
    expect(chatFileMarker(firstFileId)).toBe(`[[chat-file:${firstFileId}]]`);
    const text = `Read ${chatFileMarker(secondFileId)} and ${chatFileMarker(firstFileId)}.\nAgain: ${chatFileMarker(secondFileId)}`;
    expect(chatFileIdsFromText(text)).toEqual([secondFileId, firstFileId]);
  });

  it.each([
    "1",
    "001",
    "-1",
    "not-a-uuid",
    firstFileId.replaceAll("-", ""),
    `${firstFileId}0`,
    ` ${firstFileId}`,
    `${firstFileId} `,
  ])("ignores invalid file ID %s while reading adjacent UUID markers", fileId => {
    expect(chatFileIdsFromText(`[[chat-file:${fileId}]]${chatFileMarker(firstFileId)}`)).toEqual([firstFileId]);
  });

  it("ignores bare UUIDs and incomplete markers", () => {
    expect(chatFileIdsFromText(`${firstFileId} [[chat-file:${secondFileId}]`)).toEqual([]);
  });
});
