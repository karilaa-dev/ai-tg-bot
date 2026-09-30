import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CODEX_HOME may contain downloaded plugins with their own test runners.
    // Discover application tests only, regardless of runtime cache contents.
    include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["dist/**", "node_modules/**"],
    // Vitest's external ESM loader loses Zod's named exports under Bun.
    server: { deps: { inline: ["zod"] } },
  },
});
