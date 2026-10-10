import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ headless: true });
const server = spawn(process.execPath, ["test/web/http-smoke.ts", "--browser"], {
  stdio: ["ignore", "pipe", "inherit"], timeout: 120_000,
});
const stopped = once(server, "exit");
try {
  let url: string | undefined;
  for await (const line of createInterface({ input: server.stdout })) {
    if (line.startsWith("Preview: ")) { url = line.slice("Preview: ".length); break; }
  }
  assert.ok(url, "The browser fixture must start successfully");
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  const token = page.getByLabel("Admin token", { exact: true });
  const submit = page.getByRole("button", { name: "Sign in", exact: true });
  await token.waitFor();
  assert.equal(await token.evaluate(input => getComputedStyle(input).fontSize), "16px");
  assert.equal(await submit.isDisabled(), true);
  await token.fill("rejected-token");
  const rejection = page.waitForResponse(response => response.url().endsWith("/api/auth/login"));
  await submit.click();
  assert.equal((await rejection).status(), 401);
  const error = page.getByRole("alert");
  await error.waitFor();
  assert.equal(await error.textContent(), "That admin token was not accepted. Check it and try again.");
  assert.equal(await token.inputValue(), "");
  assert.equal(await submit.isDisabled(), true);

  await token.fill("  preview-admin-token  ");
  await error.waitFor({ state: "hidden" });
  const acceptance = page.waitForResponse(response => response.url().endsWith("/api/auth/login"));
  await token.press("Enter");
  assert.equal((await acceptance).status(), 200);
  await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
  assert.equal(await token.count(), 0);

  const thinking = page.getByRole("button", { name: "3 tool calls", exact: true });
  await thinking.waitFor();
  assert.equal(await thinking.getAttribute("aria-expanded"), "false");
  await thinking.focus();
  await thinking.press("Enter");
  const toolDetails = page.getByRole("region", { name: "Thinking and tool details" });
  await toolDetails.waitFor();
  const reply = page.locator(".message").filter({ has: thinking });
  await reply.locator(".message-usage > button").click();
  const usageDetails = reply.getByRole("region", { name: "Usage details" });
  await usageDetails.getByRole("button", { name: "1 recorded call", exact: true }).click();
  const call = usageDetails.locator(".usage-call");
  assert.equal(await call.getAttribute("open"), null);
  assert.equal(await call.getByText("Requested tier", { exact: true }).isVisible(), false);
  await call.locator("summary").focus();
  await page.keyboard.press("Enter");
  await call.getByText("Requested tier", { exact: true }).waitFor();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const region of [toolDetails, usageDetails]) {
      const bounds = await region.evaluate(node => ({ height: node.getBoundingClientRect().height, scroll: node.scrollHeight, client: node.clientHeight, width: node.scrollWidth, clientWidth: node.clientWidth }));
      assert(bounds.height <= 320, `Details stay compact at ${width}px`);
      assert(bounds.scroll > bounds.client, "Long details scroll internally");
      assert(bounds.width <= bounds.clientWidth, `Details have no horizontal overflow at ${width}px`);
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No transcript overflow at ${width}px`);
  }
  await thinking.click();
  await toolDetails.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Usage", exact: true }).first().click();
  await page.getByRole("img", { name: "Daily stacked token counts", exact: false }).waitFor();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => [...document.querySelectorAll<SVGSVGElement>(".usage-chart svg")].every(svg => Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 1));
    const labels = await page.locator(".usage-chart text").evaluateAll(nodes => nodes.map(node => {
      if (!(node instanceof SVGTextElement)) throw new Error("Chart labels must be SVG text");
      const scale = node.getScreenCTM();
      const bounds = node.getBoundingClientRect();
      const chart = node.closest("svg")!.getBoundingClientRect();
      return {
        size: parseFloat(getComputedStyle(node).fontSize) * (scale?.a ?? 0),
        inside: bounds.left >= chart.left - 1 && bounds.right <= chart.right + 1 && bounds.top >= chart.top - 1 && bounds.bottom <= chart.bottom + 1,
      };
    }));
    assert.equal(labels.length, 10);
    assert(labels.every(label => Math.abs(label.size - 14) < 0.1), `Readable chart labels at ${width}px`);
    assert(labels.every(label => label.inside), `Unclipped chart labels at ${width}px`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}px`);
  }
  const slider = page.getByRole("slider", { name: "Inspect day", exact: false });
  await slider.focus();
  const selectedDay = await slider.getAttribute("aria-valuetext");
  await slider.press("ArrowLeft");
  assert.notEqual(await slider.getAttribute("aria-valuetext"), selectedDay);
  assert.deepEqual(errors, []);
  console.log("Browser smoke passed: sign-in retry, compact tool and usage details, keyboard disclosures, responsive charts, and keyboard day selection");
} finally {
  server.kill("SIGTERM");
  await stopped;
  await browser.close();
}
