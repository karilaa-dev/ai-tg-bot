import { describe, expect, it, vi } from "vitest";
import { compactHtmlTables, compactMarkdownTables } from "../../src/telegram/compactTables.js";
import { editRich, sendRich, sendRichDraft } from "../../src/telegram/richApi.js";
import { renderAnswerDraft, renderDraft, renderFinal, variantsForRichRetry } from "../../src/telegram/render.js";

const table = "| Name | Value |\n| :--- | ---: |\n| **Bold** | `a\\|b` |";

describe("compact Telegram tables", () => {
  it("compacts Markdown tables while preserving inline formatting, alignment, and surrounding text", () => {
    const markdown = `Before **bold**\n\n${table}\n\nAfter $math$`;
    const result = compactMarkdownTables(markdown);
    expect(result).toBe('Before **bold**\n\n<table compact><tr><th align="left">Name</th><th align="right">Value</th></tr>'
      + '<tr><td align="left"><strong>Bold</strong></td><td align="right"><code>a|b</code></td></tr></table>\n\nAfter $math$');
    expect(compactMarkdownTables(result)).toBe(result);
  });

  it("preserves reference links, escaped text, strikethrough and Telegram inline HTML in cells", () => {
    const result = compactMarkdownTables('| Link | Detail |\n| --- | --- |\n| [Site][url] | ~~old~~ & <tg-spoiler>secret</tg-spoiler> |\n\n[url]: https://example.com');
    expect(result).toContain('<a href="https://example.com">Site</a>');
    expect(result).toContain('<del>old</del> &#x26; <tg-spoiler>secret</tg-spoiler>');
    expect(result).not.toMatch(/<\/?(?:thead|tbody)>/);
  });

  it("keeps formula source raw and renders highlights inside table cells", () => {
    const result = compactMarkdownTables('| Formula | Status |\n| --- | --- |\n| $x*y*z$ | ==**ready**== |');
    expect(result).toContain('<tg-math>x*y*z</tg-math>');
    expect(result).toContain('<mark><strong>ready</strong></mark>');
    expect(result).not.toContain('<em>');
    expect(compactMarkdownTables(result)).toBe(result);
  });

  it("leaves formula and highlight examples in code and escaped text literal", () => {
    const result = compactMarkdownTables('| Examples |\n| --- |\n| `$x*y*z$ ==literal==` and \\$price and \\==literal== |');
    expect(result).toContain('<code>$x*y*z$ ==literal==</code>');
    expect(result).not.toContain('<tg-math>');
    expect(result).not.toContain('<mark>');
  });

  it("gives table footnotes matching Telegram references, including references in surrounding prose", () => {
    const result = compactMarkdownTables('Also cited[^note].\n\n| Source |\n| --- |\n| Fact[^note] |\n\n[^note]: A **formatted** source.');
    expect(result).toContain('href="#compact-note-note"');
    expect(result.match(/href="#compact-note-note"/g)).toHaveLength(2);
    expect(result).toContain('<tg-reference name="compact-note-note">A <strong>formatted</strong> source.</tg-reference>');
    expect(result).not.toContain('user-content-fn');
    expect(result).not.toContain('[^note]');
    expect(compactMarkdownTables(result)).toBe(result);
  });

  it("compacts tables inside details, quotes and lists", () => {
    const markdown = `<details>\n<summary>Work</summary>\n\n${table}\n\n</details>\n\n`
      + table.split("\n").map(line => `> ${line}`).join("\n")
      + `\n\n- Item\n\n${table.split("\n").map(line => `  ${line}`).join("\n")}`;
    const result = compactMarkdownTables(markdown);
    expect(result.match(/<table compact>/g)).toHaveLength(3);
    expect(result).toContain("</details>");
    expect(result).toContain("> <table compact>");
    expect(result).toContain("- Item\n\n  <table compact>");
  });

  it.each(["```md\n", "~~~md\n", "    "])("preserves a code example starting with %s", opener => {
    const example = opener === "    "
      ? `${table}\n<table>`.split("\n").map(line => `    ${line}`).join("\n")
      : `${opener}${table}\n<table>\n${opener.slice(0, 3)}`;
    expect(compactMarkdownTables(example)).toBe(example);
  });

  it("preserves inline code, HTML code blocks, comments, and ordinary pipes", () => {
    for (const markdown of [
      "Example `<table>` with a pipe |", "<code><table></table></code>",
      "<pre><code><table>literal</table></code></pre>", "<!-- <table> -->",
      "Run `cat report.txt | head`",
    ]) expect(compactMarkdownTables(markdown)).toBe(markdown);
  });

  it("pads short rows and folds overflow into the last column without losing text", () => {
    expect(compactMarkdownTables("| a | b |\n| --- | --- |\n| 1 |\n| 2 | 3 | 4 |"))
      .toContain("<tr><td>1</td><td></td></tr><tr><td>2</td><td>3 | 4</td></tr>");
    const row = Array.from({ length: 22 }, (_, index) => `cell ${index}`).join(" | ");
    const result = compactMarkdownTables(`${row}\n${Array(22).fill("---").join(" | ")}\n${row}`);
    expect(result.match(/<th>/g)).toHaveLength(20);
    expect(result.match(/<td>/g)).toHaveLength(20);
    expect(result).toContain("cell 19 | cell 20 | cell 21");
  });

  it("compacts every HTML table without duplicating attributes or changing quoted values", () => {
    const html = '<table bordered data-label="a compact b"><tr><td>x</td></tr></table>'
      + '<TABLE COMPACT="false" striped><tr><td>y</td></tr></TABLE>';
    const result = compactHtmlTables(html);
    expect(result).toBe('<table bordered data-label="a compact b" compact><tr><td>x</td></tr></table>'
      + '<TABLE striped compact><tr><td>y</td></tr></TABLE>');
    expect(compactHtmlTables(result)).toBe(result);
  });

  it("applies compact tables to all draft and final rendering paths and retries", () => {
    const t = (key: string) => key;
    const payloads = [renderAnswerDraft(table), renderDraft({ thinkingMd: table, answerMd: table, elapsedMs: 0, t }),
      ...renderFinal({ thinkingLog: table, answerMd: table, elapsedMs: 0, t }), variantsForRichRetry(table)[0]];
    for (const payload of payloads) expect(payload?.markdown).toContain("<table compact>");
  });

  it.each(["markdown", "html"] as const)("compacts %s tables at send, draft and edit boundaries", async format => {
    const api = { raw: { sendRichMessage: vi.fn(async () => true), sendRichMessageDraft: vi.fn(async () => true),
      editMessageText: vi.fn(async () => true) } };
    const rich = format === "markdown" ? { markdown: table } : { html: "<table><tr><td>x</td></tr></table>" };
    const payload = { chat_id: 1, rich_message: rich };
    await sendRich(api, payload);
    await sendRichDraft(api, { ...payload, draft_id: 2 });
    await editRich(api, { ...payload, message_id: 3 });
    for (const method of Object.values(api.raw)) {
      expect(method).toHaveBeenCalledWith(expect.objectContaining({ rich_message: expect.objectContaining({
        [format]: expect.stringContaining("<table compact>"),
      }) }), ...(method === api.raw.sendRichMessageDraft ? [undefined] : []));
    }
  });
});
