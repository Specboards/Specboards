import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";
import jsxA11y from "eslint-plugin-jsx-a11y";

// Flat config. The repo had no ESLint config at all and relied on `next lint`
// (deprecated in Next 15.5, removed in 16), so this both modernizes linting and
// adds the jsx-a11y ruleset that guards our WCAG 2.2 AA work.
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

export default [
  {
    ignores: [
      ".next/**",
      "next-env.d.ts",
      "e2e/.tmp/**",
      "coverage/**",
      "public/**",
    ],
  },
  // next/core-web-vitals already registers the jsx-a11y plugin (under the
  // "jsx-a11y" namespace) with a subset of its rules enabled.
  ...compat.extends("next/core-web-vitals"),
  {
    files: ["**/*.{ts,tsx}"],
    // Apply the full jsx-a11y recommended ruleset on top. We reference the
    // recommended config's `rules` rather than spreading its whole flat config
    // so we do not re-register the plugin next already registered (which would
    // throw "Cannot redefine plugin").
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // Our design-system controls (Input/Select/Textarea) are custom
      // components, so the linter cannot see a <label><span>..</span><Input/>
      // </label> nesting as an association. Teach it the control names and
      // accept either nesting or htmlFor. Stage 5 adds explicit htmlFor/id
      // wiring on top via the FormField wrapper.
      "jsx-a11y/label-has-associated-control": [
        "error",
        {
          controlComponents: ["Input", "Select", "Textarea"],
          assert: "either",
          depth: 3,
        },
      ],
      // autoFocus is a genuine problem on page load, but every use here is the
      // first field of a drawer/dialog the user just opened, where moving focus
      // in is expected and correct. The rule cannot tell the two apart, so keep
      // it visible as a warning rather than a build-breaking error.
      "jsx-a11y/no-autofocus": ["warn", { ignoreNonDOM: true }],
    },
  },
];
