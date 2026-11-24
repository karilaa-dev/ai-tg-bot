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
const icons = [];
for (const size of [192, 512]) {
  const bytes = await readFile(`src/web/pwa/icon-${size}.png`);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const name = `icon-${size}-${hash}.png`;
  const target = path.join(output, name);
  await writeFile(target, bytes);
  assets.set(`/${name}`, target);
  icons.push({ src: `/${name}`, sizes: `${size}x${size}`, type: "image/png" });
}
const manifestPath = path.join(output, "chat.webmanifest");
await writeFile(manifestPath, JSON.stringify({
  id: "/chat/", start_url: "/chat/", scope: "/chat/", name: "AI KaRiLaA", short_name: "AI KaRiLaA",
  display: "standalone", theme_color: "#ffffff", background_color: "#ffffff", icons,
}));
assets.set("/chat.webmanifest", manifestPath);
const page = path.join(output, "index.html");
const head = `<meta name="theme-color" content="#ffffff"><link rel="manifest" href="/chat.webmanifest"><link rel="apple-touch-icon" href="${icons[0]!.src}">`;
await writeFile(page, template.replace("</head>", `${head}</head>`));
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
