import { parse } from "csv-parse/sync";
import { MAX_INDEXED_TEXT_BYTES } from "./limits.js";

export class CsvIndexLimitError extends Error {}
export interface CsvRecord { raw: string; record: string[] }

/** Bound work before parsing, then stop at record/cell limits. Used once per ingestion. */
export function parseIndexedCsv(raw: string): CsvRecord[] {
  if (Buffer.byteLength(raw) > MAX_INDEXED_TEXT_BYTES) throw new CsvIndexLimitError();
  let rows = 0;
  let cells = 0;
  return parse(raw, {
    raw: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true,
    max_record_size: 64 * 1024,
    on_record(record) {
      // csv-parse's types omit the raw:true wrapper passed to on_record.
      const value = record as unknown as CsvRecord;
      cells += value.record.length;
      if (++rows > 10_000 || value.record.length > 2_048 || cells > 50_000 || Buffer.byteLength(value.raw) > 64 * 1024) throw new CsvIndexLimitError();
      return record;
    },
  }) as unknown as CsvRecord[];
}

interface Chunk {
  idx: number;
  headingPath: string | null;
  content: string;
}

export function chunkMarkdown(md: string, targetChars = 1800, overlapChars = 270): Chunk[] {
  const sections = splitSections(md);
  const chunks: Chunk[] = [];
  for (const section of sections) {
    if (section.content.length <= targetChars) {
      chunks.push({ idx: chunks.length, headingPath: section.headingPath, content: section.content.trim() });
      continue;
    }
    let start = 0;
    while (start < section.content.length) {
      const end = Math.min(section.content.length, start + targetChars);
      chunks.push({
        idx: chunks.length,
        headingPath: section.headingPath,
        content: section.content.slice(start, end).trim(),
      });
      start = end - overlapChars;
      if (start < 0 || end === section.content.length) break;
    }
  }
  return chunks.filter((chunk) => chunk.content);
}

export function chunkCsv(raw: string | CsvRecord[], targetRows = 500): Chunk[] {
  const records = typeof raw === "string" ? parseIndexedCsv(raw) : raw;
  const rows = records.map((record) => record.raw.replace(/(?:\r\n|\r|\n)$/, ""));
  const header = rows[0] ?? "";
  if (rows.length === 1) return [{ idx: 0, headingPath: "header", content: header }];
  const chunks: Chunk[] = [];
  for (let start = 1; start < rows.length; start += targetRows) {
    const end = Math.min(rows.length, start + targetRows);
    chunks.push({
      idx: chunks.length,
      headingPath: `rows ${start}-${end - 1}`,
      content: [header, ...rows.slice(start, end)].join("\n"),
    });
  }
  return chunks;
}

function splitSections(md: string): Array<{ headingPath: string | null; content: string }> {
  const lines = md.split("\n");
  const path: string[] = [];
  const sections: Array<{ headingPath: string | null; content: string[] }> = [{ headingPath: null, content: [] }];
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      path.splice(level - 1);
      path[level - 1] = heading[2]!.trim();
      sections.push({ headingPath: path.filter(Boolean).join(" > "), content: [line] });
    } else {
      sections.at(-1)!.content.push(line);
    }
  }
  return sections.map((section) => ({ headingPath: section.headingPath, content: section.content.join("\n") }));
}
