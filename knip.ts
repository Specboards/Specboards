import type { KnipConfig } from "knip";

/**
 * Dead-code detection across the workspace: files nothing imports, exports
 * nothing consumes, dependencies nothing needs.
 *
 * This is the second half of the gate. `@typescript-eslint/no-unused-vars`
 * (see eslint.config.mjs) catches unused code *within* a file and runs on every
 * commit; it cannot see an exported symbol that no other file imports, which is
 * how a deleted route handler's orphaned imports sat in `api/v1/statuses`
 * unnoticed for months. knip answers the other half of that question.
 *
 * Every suppression below says why it is there. Keep it that way: an
 * unexplained ignore is indistinguishable from a bug someone silenced.
 */
const config: KnipConfig = {
  workspaces: {
    "apps/web": {
      // Tests are consumers, not products: a helper exported solely for a test
      // is used, not dead. Both vitest projects and the Playwright suite count.
      entry: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/**/*.int.test.ts",
        "e2e/**/*.spec.ts",
        "vitest.config.ts",
      ],
      // knip's vitest plugin loads vitest.config.ts in the root's module
      // context, where `vitest/config` (a workspace-level devDependency) does
      // not resolve, and the run dies. The entry patterns above already tell it
      // what the test files are, which is all the plugin was contributing.
      vitest: false,
    },
  },
  // System binaries, not npm ones: the TLS tests shell out to `openssl` to mint
  // throwaway certificates. (knip 6 resolves `scripts/*.sh` invoked by path on
  // its own, so those no longer need listing.)
  ignoreBinaries: ["openssl"],
};

export default config;
