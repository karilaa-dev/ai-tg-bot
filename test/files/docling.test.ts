import { afterEach, describe, expect, it, vi } from "vitest";
import { convertWithDocling } from "../../src/files/docling.js";

describe("docling client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the file-source payload expected by current docling-serve", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ document: { md_content: "converted" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const md = await convertWithDocling({
      config: { DOCLING_URL: "http://docling.test", DOCLING_TIMEOUT_MS: 300_000 },
      filename: "sample.pdf",
      bytes: Buffer.from("abc"),
    });

    expect(md).toBe("converted");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as {
      sources: Array<{ kind: string; base64_string: string; filename: string }>;
      options: Record<string, unknown>;
    };
    expect(body.sources).toEqual([
      { kind: "file", base64_string: Buffer.from("abc").toString("base64"), filename: "sample.pdf" },
    ]);
    expect(body.options).toMatchObject({ to_formats: ["md"], table_mode: "accurate", image_export_mode: "placeholder" });
  });

  it.runIf(process.env.TEST_DOCLING_URL)("converts a tiny PDF against docling-serve", async () => {
    const md = await convertWithDocling({
      config: { DOCLING_URL: process.env.TEST_DOCLING_URL!, DOCLING_TIMEOUT_MS: 300_000 },
      filename: "docling-smoke.pdf",
      bytes: makePdf("Docling integration smoke"),
    });

    expect(md).toMatch(/Docling integration smoke/i);
  }, 120_000);
});

function makePdf(text: string): Buffer {
  const stream = `BT\n/F1 24 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
