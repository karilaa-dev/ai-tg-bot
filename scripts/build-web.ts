import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { webAssetTypes } from "../src/web/asset-types.js";
import tailwind from "bun-plugin-tailwind";

const output = path.resolve("dist/web");
await rm(output, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/web/client/index.html"],
  outdir: output,
  target: "browser",
  publicPath: "/",
  minify: true,
  metafile: true,
  // Routes load with dynamic imports; shared code goes into hashed chunks.
  splitting: true,
  naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [tailwind],
});
if (!result.success) throw new AggregateError(result.logs, "Website build failed.");
const html = result.outputs.find(asset => path.extname(asset.path) === ".html");
if (!html) throw new Error("Website build did not emit HTML.");
const template = await html.text();
await rm(html.path);

// Follow the shell's emitted dependencies, stopping at the admin route boundary.
const outputs = result.metafile!.outputs;
const chatFiles = new Set<string>();
function include(name: string) {
  const info = outputs[name];
  if (!info || info.entryPoint === "src/web/client/admin-app.tsx" || chatFiles.has(name)) return;
  chatFiles.add(name);
  for (const dependency of info.imports) include(dependency.path);
  if (info.cssBundle) include(info.cssBundle);
}
for (const [name, info] of Object.entries(outputs)) {
  if (info.entryPoint === "src/web/client/index.html") include(name);
}
const assets = new Map<string, string>();
const sources = [template];
for (const name of chatFiles) {
  if (name.endsWith(".html")) continue;
  const file = path.join(output, name);
  assets.set(`/${path.basename(file)}`, file);
  sources.push(await readFile(file, "utf8"));
}
// Bun embeds file-loader URLs in the generated HTML, CSS and JS, outside its output import graph.
for (const file of result.outputs) {
  if (file.kind === "sourcemap") continue;
  if (!webAssetTypes[path.extname(file.path)]) throw new Error(`Unsupported website asset: ${file.path}`);
  const url = `/${path.basename(file.path)}`;
  if (file.kind === "asset" && sources.some(source => source.includes(url))) assets.set(url, file.path);
}
async function copyIcon(source: string) {
  const bytes = await readFile(`src/web/pwa/${source}.png`);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const name = `${source}-${hash}.png`;
  const target = path.join(output, name);
  await writeFile(target, bytes);
  return `/${name}`;
}
const icons = await Promise.all([
  { source: "icon-192", sizes: "192x192", purpose: "any" },
  { source: "icon-512", sizes: "512x512", purpose: "any" },
  { source: "icon-maskable-512", sizes: "512x512", purpose: "maskable" },
].map(async ({ source, sizes, purpose }) => ({ src: await copyIcon(source), sizes, type: "image/png", purpose })));
const appleIcon = await copyIcon("apple-touch-icon");
const launchColor = "#040a25";
const manifestPath = path.join(output, "chat.webmanifest");
await writeFile(manifestPath, JSON.stringify({
  id: "/chat/", start_url: "/chat/", scope: "/chat/", name: "AI KaRiLaA", short_name: "AI KaRiLaA",
  display: "standalone", theme_color: launchColor, background_color: launchColor, icons,
}));
assets.set("/chat.webmanifest", manifestPath);
const page = path.join(output, "index.html");
const head = [
  '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#101010">',
  '<meta name="theme-color" content="#ffffff">',
  '<link rel="manifest" href="/chat.webmanifest">',
  `<link rel="apple-touch-icon" sizes="180x180" href="${appleIcon}">`,
].join("");
await writeFile(page, template
  .replace("width=device-width, initial-scale=1", "width=device-width, initial-scale=1, viewport-fit=cover")
  .replace("</head>", `${head}</head>`));
await writeFile(path.join(output, "admin.html"), template);
assets.set("/chat/", page);

// Integrity also prevents a rolling deployment from installing a mix of two builds.
const precache = await Promise.all([...assets].sort(([a], [b]) => a.localeCompare(b)).map(async ([url, file]) => ({
  url, integrity: "sha256-" + createHash("sha256").update(await readFile(file)).digest("base64"),
})));
const worker = await readFile("src/web/pwa/service-worker.js", "utf8");
const revision = createHash("sha256").update(JSON.stringify(precache)).update(worker).digest("hex");
await writeFile(path.join(output, "service-worker.js"),
  `const revision = ${JSON.stringify(revision)};\nconst precache = ${JSON.stringify(precache)};\n${worker}`);
console.log("Website built in dist/web");
