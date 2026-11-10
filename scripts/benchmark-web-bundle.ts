import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { chromium, type BrowserContext } from "playwright-core";

// Measures the JavaScript each website route downloads before it is usable.
// Usage: bun scripts/benchmark-web-bundle.ts [checkout]
// The checkout's own production build is served by its synthetic HTTP fixture
// (test/web/http-smoke.ts); every route starts from an empty browser cache.
const root = path.resolve(process.argv[2] ?? process.cwd());

async function run(command: string[], cwd: string): Promise<void> {
  const child = spawn(process.execPath, command, { cwd, stdio: ["ignore", "ignore", "inherit"] });
  const [code] = await once(child, "exit") as [number | null];
  if (code !== 0) throw new Error(`${command.join(" ")} failed with ${code}`);
}

const compressed = (bytes: Buffer) => ({
  raw: bytes.length,
  gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
});

await run(["scripts/build-web.ts"], root);
const output = path.join(root, "dist/web");
const emitted = await Promise.all((await readdir(output)).filter((name) => name.endsWith(".js")).sort()
  .map(async (name) => ({ name, bytes: (await stat(path.join(output, name))).size })));

const server = spawn(process.execPath, ["test/web/http-smoke.ts", "--browser"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
const stopped = once(server, "exit");
const browser = await chromium.launch({ headless: true });
try {
  let url: string | undefined;
  for await (const line of createInterface({ input: server.stdout! })) {
    if (line.startsWith("Preview: ")) { url = line.slice("Preview: ".length); break; }
  }
  if (!url) throw new Error("The HTTP fixture did not start.");
  const origin = new URL(url).origin;

  // Time to usable is noisy on a local server; report the median of several cold runs.
  type ContextState = Awaited<ReturnType<BrowserContext["storageState"]>>;
  async function measure(name: string, visit: (context: BrowserContext) => Promise<void>, state?: () => Promise<ContextState>, runs = 4) {
    const results = [];
    for (let index = 0; index < runs; index++) results.push(await measureOnce(name, visit, await state?.()));
    const times = results.map((result) => result.usableMs).sort((a, b) => a - b);
    return { ...results[0]!, usableMs: undefined, usableMsRuns: times, usableMsMedian: times[Math.floor(times.length / 2)] };
  }

  async function measureOnce(name: string, visit: (context: BrowserContext) => Promise<void>, storageState?: ContextState) {
    // A new context has an empty HTTP cache; a returning visit keeps only cookies and local storage.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState });
    const scripts = new Map<string, { status: number; cacheControl: string | null; contentType: string | null; body: Buffer }>();
    context.on("response", (response) => {
      const target = new URL(response.url());
      if (target.origin !== origin || !target.pathname.endsWith(".js")) return;
      void response.body().then((body) => scripts.set(target.pathname, {
        status: response.status(), cacheControl: response.headers()["cache-control"] ?? null,
        contentType: response.headers()["content-type"] ?? null, body,
      }));
    });
    const started = performance.now();
    await visit(context);
    const usableMs = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await context.close();
    const files = [...scripts].map(([pathname, script]) => ({ path: pathname, status: script.status, cacheControl: script.cacheControl,
      contentType: script.contentType, ...compressed(script.body) })).sort((a, b) => a.path.localeCompare(b.path));
    const total = files.reduce((sum, file) => ({ raw: sum.raw + file.raw, gzip: sum.gzip + file.gzip, brotli: sum.brotli + file.brotli }),
      { raw: 0, gzip: 0, brotli: 0 });
    return { route: name, requests: files.length, javascript: total, usableMs: Math.round(usableMs), files };
  }

  const signIn = async (context: BrowserContext, start: string, landmark: (page: Awaited<ReturnType<BrowserContext["newPage"]>>) => Promise<void>) => {
    const page = await context.newPage();
    await page.goto(new URL(start, url).href);
    await page.getByRole("link", { name: "Sign in with Telegram", exact: true }).click();
    await landmark(page);
  };
  let returning: ContextState | undefined;
  const routes = [
    await measure("signed-out sign-in page", async (context) => {
      const page = await context.newPage();
      await page.goto(new URL("/", url).href);
      await page.getByRole("link", { name: "Sign in with Telegram", exact: true }).waitFor();
    }),
    await measure("signed-in chat", (context) => signIn(context, "/", async (page) => {
      await page.getByRole("button", { name: "New chat", exact: true }).waitFor();
    })),
    await measure("admin dashboard", (context) => signIn(context, "/admin", async (page) => {
      await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
    })),
    await measure("returning signed-in chat (cold cache)", async (context) => {
      const page = await context.newPage();
      await page.goto(new URL("/", url).href);
      await page.getByRole("button", { name: "New chat", exact: true }).waitFor();
    }, async () => {
      // Sign in once (the fixture rate-limits sign-ins) and reuse the cookies and local storage.
      if (!returning) {
        const context = await browser.newContext();
        await signIn(context, "/", async (page) => { await page.getByRole("button", { name: "New chat", exact: true }).waitFor(); });
        returning = await context.storageState();
        await context.close();
      }
      return returning;
    }),
  ];
  process.stdout.write(`${JSON.stringify({
    checkout: path.basename(root),
    runtime: `bun ${Bun.version}`,
    browser: `chromium ${browser.version()}`,
    emitted: { files: emitted, totalBytes: emitted.reduce((sum, file) => sum + file.bytes, 0) },
    routes,
  }, null, 2)}\n`);
} finally {
  server.kill("SIGTERM");
  await stopped;
  await browser.close();
}
