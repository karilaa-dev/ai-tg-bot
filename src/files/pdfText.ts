import { extractText } from "unpdf";
import { throwIfAborted } from "./cancel.js";

export interface PdfTextExtraction {
  markdown: string;
  pages: number;
  textChars: number;
}

export async function extractPdfText(input: { bytes: Buffer; signal?: AbortSignal }): Promise<PdfTextExtraction> {
  throwIfAborted(input.signal);
  const result = await extractText(new Uint8Array(input.bytes), { mergePages: false });
  throwIfAborted(input.signal);
  const pages = Array.isArray(result.text) ? result.text : [result.text];
  const parts: string[] = [];
  let textChars = 0;
  pages.forEach((pageText, index) => {
    const text = normalizeText(pageText);
    if (!text) return;
    textChars += text.length;
    parts.push(`## Page ${index + 1}\n\n${text}`);
  });
  return {
    markdown: parts.join("\n\n"),
    pages: result.totalPages,
    textChars,
  };
}

function normalizeText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
