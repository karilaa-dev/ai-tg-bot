import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

// The real code block is covered by the browser check; isolate Markdown safety here.
vi.mock("../../src/web/client/components/ui/code-block.js", () => ({ default: ({ code }: { code: string }) => createElement("pre", null, code) }));
import { RichText } from "../../src/web/client/rich-text.js";

it("renders message formatting without active HTML, unsafe links, or external image loads", () => {
  const html = renderToStaticMarkup(createElement(RichText, { text: '**Hello**\n\n<script>window.pwned=true</script>\n\n<img src="https://example.test/track" onerror="alert(1)">\n\n![tracking](https://example.test/image.png)\n\n[unsafe](javascript:alert(1))\n\n[safe](https://example.test)\n\n```html\n<script>literal code</script>\n```' }));
  expect(html).toContain("<strong>Hello</strong>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('href="https://example.test"');
  expect(html).toContain("&lt;script&gt;literal code&lt;/script&gt;");
});
