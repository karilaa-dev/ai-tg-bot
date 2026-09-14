import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

// The real code block is covered by the browser check; isolate Markdown safety here.
vi.mock("../../src/web/client/components/ui/code-block.js", () => ({ default: ({ code }: { code: string }) => createElement("pre", null, code) }));
import { FileAttachment } from "../../src/web/client/file-attachment.js";
import { RichText } from "../../src/web/client/rich-text.js";
import { MessageUsage, UsageGraphs } from "../../src/web/client/usage.js";
import { emptyUsage } from "../../src/web/usage.js";

it("renders unavailable usage and partial estimates without fabricating a zero cost", () => {
  expect(renderToStaticMarkup(createElement(MessageUsage, {}))).toContain("Usage not recorded");
  const html = renderToStaticMarkup(createElement(MessageUsage, { usage: {
    ...emptyUsage(), totalTokens: 500, outputTokens: 500, recordedTurns: 1, unpricedTurns: 1,
    estimatedCostUsd: 0.00001, modelCalls: 2, models: [], reasoningTokens: 100,
  } }));
  expect(html).toContain("&lt;$0.0001");
  expect(html).toContain("partial");
  expect(html).toContain("Reasoning is included in output");
  expect(html).not.toMatch(/<details[^>]*open/);
});

it("renders empty and zero-value graphs with finite coordinates and a keyboard day selector", () => {
  expect(renderToStaticMarkup(createElement(UsageGraphs, { daily: [] }))).toBe("");
  const html = renderToStaticMarkup(createElement(UsageGraphs, { daily: [{ ...emptyUsage(), date: "2026-09-13" }] }));
  expect(html).not.toMatch(/NaN|Infinity/);
  expect(html).toContain('type="range"');
  expect(html).toContain('aria-valuetext="2026-09-13"');
  expect(html).toContain("Tokens per day");
  expect(html).toContain("Estimated cost per day");
});

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
  expect(html).not.toContain('class="file-card"');
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

it.each(["image", "audio"] as const)("shows a %s caption unless it is already in the message", kind => {
  const props = {
    file: { id: 1, kind, name: "media", mimeType: `${kind}/test`, size: 50, caption: "A separate <script>caption</script>" },
    messageText: "Here is the answer.", maxBytes: 20 * 1024 * 1024, load: () => {},
  };
  const html = renderToStaticMarkup(createElement(FileAttachment, props));
  expect(html).toContain('<p class="file-caption">A separate &lt;script&gt;caption&lt;/script&gt;</p>');
  expect(html).not.toContain("<script>");
  const duplicated = renderToStaticMarkup(createElement(FileAttachment, { ...props, messageText: props.file.caption }));
  expect(duplicated).not.toContain('class="file-caption"');
  for (const label of ["Generated image", "Attached file", "Attached files"]) {
    for (const messageAttachments of [[props.file], [props.file, { ...props.file, id: 2, caption: "Second, with comma" }]]) {
      const messageText = `${label}: ${messageAttachments.map(f => f.caption).join(", ")}`;
      const fallback = renderToStaticMarkup(createElement(FileAttachment, { ...props, messageText, messageAttachments }));
      expect(fallback).not.toContain('class="file-caption"');
    }
  }
});

it("renders unknown fenced-code languages as escaped plain text using the real code block", async () => {
  const { default: CodeBlock } = await vi.importActual<typeof import("../../src/web/client/components/ui/code-block.js")>("../../src/web/client/components/ui/code-block.js");
  for (const language of ["mermaid", "unknown-language", "text"]) {
    const html = renderToStaticMarkup(createElement(CodeBlock, { code: '<script>example</script>\ngraph TD; A --> B;', language, mode: "light" }));
    expect(html).toContain("graph TD; A --&gt; B;");
    expect(html).toContain("&lt;script&gt;example&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  }
});
