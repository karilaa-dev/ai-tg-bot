import type { BunPlugin } from "bun";

// OpenUI's optional inspector reads Node globals and loads external devtools.
// Disable only its development branches; keep React development mode and HMR.
const transpiler = new Bun.Transpiler({ loader: "js", define: {
  "process.env.NODE_ENV": '"production"',
  // Bun's dotted define does not cover the SDK's process.env["NODE_ENV"] access.
  "process.env": '{"NODE_ENV":"production"}',
} });

export default {
  name: "openui-browser",
  setup(build) {
    build.onLoad({ filter: /[/\\]@openuidev[/\\]react-lang[/\\]dist[/\\].*\.mjs$/ }, async ({ path }) => ({
      contents: await transpiler.transform(await Bun.file(path).text()),
      loader: "js",
    }));
  },
} satisfies BunPlugin;
