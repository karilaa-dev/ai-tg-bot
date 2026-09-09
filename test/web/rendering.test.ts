import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

// The real code block is covered by the browser check; isolate Markdown safety here.
vi.mock("../../src/web/client/components/ui/code-block.js", () => ({ default: ({ code }: { code: string }) => createElement("pre", null, code) }));
import { FileAttachment } from "../../src/web/client/file-attachment.js";
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


it("renders image information as a closed disclosure without a filename card", () => {
  const html = renderToStaticMarkup(createElement(FileAttachment, {
    file: { id: 1, kind: "image", name: "long-telegram-file-id.jpg", mimeType: "image/jpeg", size: 50, caption: null, description: "A cat <script>unsafe</script>" },
    maxBytes: 20 * 1024 * 1024, load: () => {},
  }));
  expect(html).toContain('class="image-frame"');
  expect(html).toContain('<summary>Image details</summary>');
  expect(html).not.toContain('data-slot="attachment-title"');
  expect(html).not.toMatch(/<details[^>]*open/);
  expect(html).not.toContain("<script>");
});

it("provides an audio player without autoplay and an expandable escaped transcription", () => {
  const html = renderToStaticMarkup(createElement(FileAttachment, {
    file: { id: 2, kind: "audio", name: "voice.ogg", mimeType: "audio/ogg", size: 50, caption: null, transcription: '<script>speech</script> & text' },
    state: { status: "ready", url: "blob:test", mime: "audio/ogg; codecs=opus" }, maxBytes: 20 * 1024 * 1024, load: () => {},
  }));
  expect(html).toContain('<audio');
  expect(html).toContain('controls=""');
  expect(html).toContain('preload="auto"');
  expect(html).not.toMatch(/autoplay/i);
  expect(html).toContain('<summary>Transcription</summary>');
  expect(html).not.toMatch(/<details[^>]*open/);
  expect(html).toContain('&lt;script&gt;speech&lt;/script&gt; &amp; text');
});
