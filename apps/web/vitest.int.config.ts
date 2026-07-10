import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Integration tests (currently the two-tenant RLS isolation suite). Separate
 * config from any future unit setup because these need a real Postgres:
 * they run serially against DATABASE_URL (CI provides the service container;
 * locally, point it at a disposable postgres:16). Excluded from `pnpm test`;
 * run via `pnpm test:int` after migrations are applied.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.int.test.ts"],
    environment: "node",
    // One shared database: no parallel files or concurrent tests.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
