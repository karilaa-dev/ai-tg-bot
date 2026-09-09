import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const output = path.resolve("dist/web");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/web/client/app.tsx", "src/web/client/theme.ts"],
  outdir: output,
  target: "browser",
  minify: true,
  naming: "[name].[ext]",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) throw new AggregateError(result.logs, "Website build failed");
execFileSync("node", ["node_modules/@tailwindcss/cli/dist/index.mjs", "-i", "src/web/client/style.css", "-o", path.join(output, "style.css"), "--minify"], { stdio: "inherit" });
await writeFile(path.join(output, "index.html"), `<!doctype html>
<html lang="en" class="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><script src="/theme.js"></script><title>Conversations · Telegram bot</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
console.log("Website built in dist/web");
