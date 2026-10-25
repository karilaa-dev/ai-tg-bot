import { fixtureUuid } from "./uuid-fixtures.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GenerativeResponse } from "../../src/web/client/openui-response.js";
import { savedRestaurantOpenUi } from "./openui-saved-fixture.js";

it("renders the saved restaurant comparison with its forward reference and all table cells", () => {
  const html = renderToStaticMarkup(createElement(GenerativeResponse, { source: savedRestaurantOpenUi }));
  expect(html).toContain("Downtown Bellevue, WA · Quick picks");
  expect(html.match(/<th\s/gu)).toHaveLength(4);
  expect(html.match(/<tr\s/gu)).toHaveLength(5);
  expect(html.match(/<td\s/gu)).toHaveLength(16);
  for (const restaurant of ["Din Tai Fung", "Monsoon", "Carmine’s", "Seastar"]) expect(html).toContain(restaurant);
  expect(html).not.toContain("Stack(");
});

it("uses the OpenUI renderer to render trusted Kumo components with literal untrusted text", () => {
  const source = 'root = Stack([Card("Comparison", [Text("<script>alert(1)</script>"), Table("Plans", ["Name", "Price"], [["Basic", "$10"]]), Button("Learn more", "Tell me more about Basic")])])';
  const html = renderToStaticMarkup(createElement(GenerativeResponse, { source, onAction: () => undefined }));
  expect(html).toContain("Comparison");
  expect(html).toContain("<table");
  expect(html).toContain("<caption");
  expect(html).toContain("Learn more");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("href=");
  expect(html).not.toContain("Stack(");
});

it("contains partial, malformed, and unsupported programs so the surrounding fallback remains usable", () => {
  for (const source of ['root = Stack([', 'root = Stack([Html("<img src=x onerror=alert(1)>")])', 'root = Stack([root])']) {
    const html = renderToStaticMarkup(createElement("div", null, "Fallback answer", createElement(GenerativeResponse, { source })));
    expect(html).toBe("<div>Fallback answer</div>");
  }
});

it("disables follow-up controls when the surrounding view cannot send messages", () => {
  const html = renderToStaticMarkup(createElement(GenerativeResponse, { source: 'root = Stack([Button("More", "Show more")])' }));
  expect(html).toContain('disabled=""');
});

it("renders accessible charts, metric grids and ordered steps from trusted visual components", () => {
  const source = 'root = Stack([Grid([Metric("Distance", "9 km", "Valley route"), Metric("Time", "3 hours", "With breaks")]), BarChart("Distance by route", ["Valley", "Ridge"], ["9", "14"], "km"), Steps("Plan", ["Start", "Lunch"], ["At the trailhead", "By the lake"])])';
  const html = renderToStaticMarkup(createElement(GenerativeResponse, { source }));
  expect(html).toContain("9 km");
  expect(html).toContain("14 km");
  expect(html).toContain("Distance by route");
  expect(html).toContain("width:100%");
  expect(html).toContain("<ol");
  expect(html).toContain("At the trailhead");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("NaN");
  const zero = renderToStaticMarkup(createElement(GenerativeResponse, { source: 'root = Stack([BarChart("Count", ["A"], ["0"], "items")])' }));
  expect(zero).toContain("width:0%");
});

it("keeps image descriptions visible without an authenticated source and never puts file references in img URLs", () => {
  const source = `root = Stack([Image("file:${fixtureUuid(42)}", "A lake <script>alert(1)</script>", "Trail photograph")])`;
  const html = renderToStaticMarkup(createElement(GenerativeResponse, { source, language: "ru" }));
  expect(html).toContain("Trail photograph");
  expect(html).toContain("Изображение недоступно");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain('<img');
  expect(html).not.toContain('src="file:');
  expect(html).not.toContain("<script");
});
