import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**", "data/**"],
    // Vitest's external ESM loader loses Zod's named exports under Bun.
    server: { deps: { inline: ["zod"] } },
  },
});
