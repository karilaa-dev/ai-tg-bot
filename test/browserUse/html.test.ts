import { describe, expect, it } from "vitest";
import { sanitizeOfficeHtml } from "../../src/browserUse/html.js";

describe("Browser Use Office HTML sanitization", () => {
  it("removes active and remote content while retaining inline images", () => {
    const sanitized = sanitizeOfficeHtml([
      "<!doctype html><html><head>",
      "<meta http-equiv='refresh' content='0;url=https://evil.example'>",
      "<script>steal()</script><style>.x{background:url(https://evil.example/x)}</style>",
      "</head><body onload='steal()'>",
      "<img src='https://evil.example/x.png' onerror='steal()'>",
      "<img src='data:image/png;base64,AA=='>",
      "<a href='https://evil.example'>link</a><iframe src='https://evil.example'></iframe>",
      "</body></html>",
    ].join(""));

    expect(sanitized).not.toContain("steal");
    expect(sanitized).not.toContain("evil.example");
    expect(sanitized).not.toContain("iframe");
    expect(sanitized).toContain("data:image/png;base64,AA==");
  });
});
