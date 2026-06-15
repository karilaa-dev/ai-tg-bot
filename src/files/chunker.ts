export interface Chunk {
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

export function chunkCsv(raw: string, targetRows = 500): Chunk[] {
  const lines = raw.split(/\r?\n/);
  const header = lines[0] ?? "";
  const chunks: Chunk[] = [];
  for (let start = 1; start < lines.length; start += targetRows) {
    const end = Math.min(lines.length, start + targetRows);
    chunks.push({
      idx: chunks.length,
      headingPath: `rows ${start}-${end - 1}`,
      content: [header, ...lines.slice(start, end)].join("\n"),
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
