import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Unit tests for the web app: fast, no database, no browser. Runs `*.test.ts`
 * under src (picked up by `pnpm test` via turbo). Integration tests
 * (`*.int.test.ts`, real Postgres) live in vitest.int.config.ts and run
 * separately via `test:int`.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.int.test.ts", "node_modules/**"],
    environment: "node",
  },
});
