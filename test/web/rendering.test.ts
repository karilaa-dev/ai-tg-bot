import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

// The real code block is covered by the browser check; isolate Markdown safety here.
vi.mock("../../src/web/client/components/ui/code-block.js", () => ({ default: ({ code }: { code: string }) => createElement("pre", null, code) }));
import { FileAttachment } from "../../src/web/client/file-attachment.js";
import { RichText } from "../../src/web/client/rich-text.js";
import { MessageUsage, UsageGraphs, TokenBreakdown, FastModeSummary, UsageCalls } from "../../src/web/client/usage.js";
import { emptyUsage } from "../../src/web/usage.js";
import { AdminGate, LoginForm } from "../../src/web/client/auth.js";
import { trustedVerificationUri } from "../../src/web/client/codex-connection.js";
import { apiFetch, SESSION_EXPIRED_EVENT } from "../../src/web/client/api.js";

it("expires the workspace for private request failures without treating an incorrect sign-in token as session expiry", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
  try {
    await expect(apiFetch("/api/threads/1/files/2")).rejects.toMatchObject({ status: 401 });
    expect(dispatchEvent.mock.calls[0]?.[0].type).toBe(SESSION_EXPIRED_EVENT);
    dispatchEvent.mockClear();
    await expect(apiFetch("/api/auth/login", { method: "POST" })).rejects.toMatchObject({ status: 401 });
    expect(dispatchEvent).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it("sends the admin mutation guard alongside explicit sandbox consent", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  try {
    await apiFetch("/api/threads/1/files/2?sandbox=start", { method: "POST", headers: { "X-Conversation-Sandbox-Consent": "start" } });
    const options = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = new Headers(options.headers);
    expect(headers.get("X-Admin-Request")).toBe("1");
    expect(headers.get("X-Conversation-Sandbox-Consent")).toBe("start");
    expect(options.credentials).toBe("same-origin");
    expect(options.cache).toBe("no-store");
  } finally { vi.unstubAllGlobals(); }
});

it("does not render private workspace content before the admin session is checked", () => {
  const privateContent = vi.fn(() => createElement("div", null, "private conversation"));
  const html = renderToStaticMarkup(createElement(AdminGate, { children: privateContent }));
  expect(privateContent).not.toHaveBeenCalled();
  expect(html).not.toContain("private conversation");
  expect(html).toContain("Checking your session");
  const login = renderToStaticMarkup(createElement(LoginForm, { onSuccess: () => {} }));
  expect(login).toContain('type="password"');
  expect(login).toMatch(/autocomplete="current-password"/i);
});

it("only links device authorization to the trusted HTTPS OpenAI login host", () => {
  expect(trustedVerificationUri("https://auth.openai.com/codex/device")).toBe("https://auth.openai.com/codex/device");
  for (const value of [undefined, "javascript:alert(1)", "http://auth.openai.com/codex/device", "https://auth.openai.com.evil.test/codex/device", "https://evil.test/", "https://user:password@auth.openai.com/codex/device", "https://auth.openai.com:444/codex/device"]) {
    expect(trustedVerificationUri(value)).toBeNull();
  }
});

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

it("distinguishes missing cache-write reporting from an explicitly reported zero", () => {
  const missing = renderToStaticMarkup(createElement(TokenBreakdown, { usage: {
    ...emptyUsage(), recordedTurns: 1, cacheWriteUnreportedCalls: 2,
  } }));
  expect(missing).toContain("Reported cache writes</dt><dd>Not reported</dd>");
  expect(missing).toContain("Reported in 0 of 2 calls");
  const zero = renderToStaticMarkup(createElement(TokenBreakdown, { usage: {
    ...emptyUsage(), recordedTurns: 1, cacheWriteReportedCalls: 2,
  } }));
  expect(zero).toContain("Reported cache writes</dt><dd>0</dd>");
  expect(zero).toContain("Reported in 2 of 2 calls");
});

it("keeps partial cache counts exact and labels historical aggregates as usage records", () => {
  const html = renderToStaticMarkup(createElement(TokenBreakdown, { usage: {
    ...emptyUsage(), recordedTurns: 3, aggregateUsageEntries: 1,
    cacheReadTokens: 15_970_000, cacheWriteTokens: 21_294,
    cacheWriteReportedCalls: 1, cacheWriteUnreportedCalls: 2,
  } }));
  expect(html).toContain(numberForTest(15_970_000));
  expect(html).toContain(numberForTest(21_294));
  expect(html).toContain("Reported in 1 of 3 usage records");
});

it("preserves unknown historical fast mode and distinguishes requested from delivered service tier", () => {
  const modes = renderToStaticMarkup(createElement(FastModeSummary, { usage: {
    ...emptyUsage(), recordedTurns: 4, fastModeCalls: 1, standardModeCalls: 1, unknownFastModeCalls: 2,
  } }));
  expect(modes).toContain("Unknown <strong>2</strong>");
  const calls = renderToStaticMarkup(createElement(UsageCalls, { calls: [{
    provider: "openai-codex", model: "gpt-6-astra", inputTokens: 3200, outputTokens: 418,
    cacheReadTokens: 15_970_000, cacheWriteTokens: 0, cacheWriteReported: false,
    fastMode: true, requestedServiceTier: "priority", serviceTier: "default",
  }, { provider: "unknown", model: "Historical record", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, aggregate: true }] }));
  expect(calls).toContain("Fast mode on");
  expect(calls).toContain("Fast mode unknown");
  expect(calls).toContain("Requested tier</dt><dd>priority");
  expect(calls).toContain("Delivered tier</dt><dd>default");
  expect(calls).toContain(numberForTest(15_973_618));
  expect(calls).toContain("Reported cache writes</dt><dd>Not reported");
  expect(calls).toContain("This record combines usage");
});

const numberForTest = (value: number) => value.toLocaleString();

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
