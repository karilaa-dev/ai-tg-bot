import { rename, rm } from "node:fs/promises";
import path from "node:path";
import tailwind from "bun-plugin-tailwind";

const output = path.resolve("dist/web");
await rm(output, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/web/client/index.html"],
  outdir: output,
  target: "browser",
  minify: true,
  naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [tailwind],
});
if (!result.success) throw new AggregateError(result.logs, "Website build failed.");
const html = result.outputs.find(asset => path.extname(asset.path) === ".html");
if (!html) throw new Error("Website build did not emit HTML.");
await rename(html.path, path.join(output, "index.html"));
console.log("Website built in dist/web");
