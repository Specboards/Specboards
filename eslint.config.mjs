import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Shared flat config for every workspace package EXCEPT `apps/web`, which keeps
 * its own (`apps/web/eslint.config.mjs`) because it needs the Next.js and
 * jsx-a11y rulesets this one has no use for.
 *
 * Until now these packages carried a `lint: eslint src` script with no eslint
 * installed and no config to run, so `pnpm lint` at the root failed and CI
 * linted only the web app. That left the code with the most reused logic
 * (`packages/core`, `packages/db`, `packages/git`) unchecked.
 *
 * Deliberately NOT type-aware: the type-checked rulesets need every package's
 * TS project built first, which would make linting depend on build order for
 * little gain over `pnpm typecheck`, which already runs on the same code.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      // Has its own config; linted by its own `lint` script.
      "apps/web/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // An `_`-prefixed name is the repo's existing convention for a parameter
      // kept for signature shape (see `deleteFeature(_scope, _emit)`), so the
      // rule should read it as intent rather than dead weight.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Test files reach for `any` when standing in for a store or a DB row, and
    // asserting on a shape that only exists in the test is not a type risk.
    files: ["**/*.test.ts", "**/*.int.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
