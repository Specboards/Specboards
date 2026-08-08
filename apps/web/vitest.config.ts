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
  // Matches the app's own JSX transform, so a `.tsx` test does not have to
  // import React to render a component that never does.
  esbuild: { jsx: "automatic" },
  test: {
    // `.tsx` too, so a server component whose correctness is in what it renders
    // (rather than in a helper it calls) can be asserted with react-dom/server.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["src/**/*.int.test.ts", "node_modules/**"],
    environment: "node",
  },
});
