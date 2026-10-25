import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UiItem, UiLink } from "../../src/openui/library.js";
import { GenerativeResponse } from "../../src/web/client/openui-response.js";
import { openUiVisualExamples } from "./openui-visual-fixtures.js";

const render = (source: string, language: "en" | "ru" = "en") => renderToStaticMarkup(createElement(GenerativeResponse, { source, language }));

describe("causal Flow", () => {
  it("renders a connected chain with a labelled, non-color-only failure point", () => {
    const html = render(openUiVisualExamples.flow);
    expect(html).toContain("<ol");
    expect(html.match(/<li/gu)).toHaveLength(4);
    expect(html).toContain("Export script bug");
    expect(html).toContain("Failure point");
    expect(html).toContain("Warning sign");
    expect(html).toContain("border-kumo-danger");
    expect(html.match(/text-kumo-danger/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("could be recomputed from public certificates");
    expect(html).not.toContain("FlowStep(");
  });

  it("localizes status labels", () => {
    expect(render(openUiVisualExamples.flow, "ru")).toContain("Точка сбоя");
  });
});

describe("StatGrid", () => {
  it("renders every value in a compact panel with its note", () => {
    const html = render(openUiVisualExamples.stats);
    for (const value of ["4", "56", "66", "115", "155", "156", "230", "237"]) expect(html).toContain(`>${value}</span>`);
    expect(html).toContain("Actual private key values");
    expect(html).toContain("All eight keys were smaller than 256");
    expect(html).toContain("--stat-columns:4");
  });
});

describe("ItemList", () => {
  it("renders recommendation rows with facts, descriptions and safe source links", () => {
    const html = render(openUiVisualExamples.places);
    expect(html).toContain("Broiler Bay Hamburgers");
    expect(html).toContain(" · Burgers · $$");
    expect(html).toContain("homemade onion rings");
    expect(html).toContain('href="https://www.example.org/broiler-bay"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("(opens in a new tab)");
    expect(html).toContain("example.org");
    expect(html).not.toContain('src="file:');
    expect(html).not.toContain("<script");
  });

  it("keeps thumbnails behind the authenticated image renderer and rows without images compact", () => {
    const html = render(openUiVisualExamples.places);
    expect(html).toContain('data-file-image="42"');
    expect(html.match(/data-file-image=/gu)).toHaveLength(1);
    expect(html).not.toContain("<img");
  });

  it("rejects unsafe link targets and malformed thumbnails at the schema boundary", () => {
    for (const url of ["javascript:alert(1)", "http://example.org/", "https://user:pw@example.org/", "https://localhost/", "data:text/html,x", "/api/chat/threads/1", "file:42"]) {
      expect(UiLink.props.safeParse({ label: "Source", url }).success, url).toBe(false);
    }
    expect(UiLink.props.safeParse({ label: "Source", url: "https://www.example.org/a?b=c#d" }).success).toBe(true);
    for (const image of ["https://example.org/a.png", "file:0", "/tmp/a.png", "file:12abc"]) {
      expect(UiItem.props.safeParse({ title: "A", image, meta: [], description: "", links: [] }).success, image).toBe(false);
    }
  });

  it("does not render unsafe links even when the surrounding program is rejected", () => {
    const source = 'root = Stack([ItemList("Picks", [Item("A", "", [], "", [Link("Click", "javascript:alert(1)")])])])';
    expect(render(source)).toBe("");
  });
});

it("keeps legacy Steps rendering valid alongside the new components", () => {
  const html = render('root = Stack([Steps("Plan", ["Start", "Lunch"], ["At the trailhead", "By the lake"]), Flow("Why", [FlowStep("A", "", "default"), FlowStep("B", "", "issue")], "")])');
  expect(html).toContain("At the trailhead");
  expect(html).toContain("Failure point");
});
