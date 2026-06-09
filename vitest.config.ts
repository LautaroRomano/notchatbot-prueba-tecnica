import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "edge-runtime",
    globals: false,
    server: { deps: { inline: ["convex-test"] } },
  },
});
