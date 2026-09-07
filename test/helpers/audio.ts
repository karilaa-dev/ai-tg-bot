import { readFileSync } from "node:fs";
import type { AudioFormat } from "../../src/audio/transcription.js";

export function audioFixture(format: AudioFormat = "ogg"): Buffer {
  return readFileSync(new URL(`../fixtures/audio/tone.${format}`, import.meta.url));
}
