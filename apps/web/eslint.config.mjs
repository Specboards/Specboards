import jsxA11y from "eslint-plugin-jsx-a11y";
import nextVitals from "eslint-config-next/core-web-vitals";

// Flat config. The repo had no ESLint config at all and relied on `next lint`
// (deprecated in Next 15.5, removed in 16), so this both modernizes linting and
// adds the jsx-a11y ruleset that guards our WCAG 2.2 AA work.
//
// eslint-config-next 16 ships a native flat-config array, so it is imported and
// spread directly. Before 16 it was eslintrc-shaped and had to be adapted with
// FlatCompat from @eslint/eslintrc; that shim is what broke on the 16 bump
// (the config it produced failed validation, and eslintrc's error formatter
// then died on a circular structure rather than reporting why).
const config = [
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
  ...nextVitals,
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
  {
    // Unused code was caught by nothing in this package, which is roughly
    // ninety per cent of the codebase. The root `eslint.config.mjs` configures
    // this rule as an error, but it excludes `apps/web/**` because this app
    // needs the Next and jsx-a11y rulesets that config has no use for, and the
    // exclusion silently took the rule with it. `noUnusedLocals` was not set
    // either. So a refactor could leave imports and locals behind and a clean
    // `pnpm lint` would say nothing, which is how #329's deleted route handler
    // went unnoticed: its three orphaned imports were the only evidence, and
    // no gate reported them.
    //
    // Same options as the root config, so the `_`-prefix convention means the
    // same thing in both places.
    files: ["**/*.{ts,tsx}"],
    rules: {
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
];

// The three React Compiler rules that used to be downgraded here are gone from
// this file, which is the point: they are back at the `error` that
// eslint-config-next sets, alongside the other thirteen.
//
// They were warnings because the upgrade to eslint-plugin-react-hooks 7 found
// 34 `set-state-in-effect` across 30 files, 6 `immutability` and 1 `refs`, and
// rewriting the effect plumbing of 30 components inside a version bump would
// have put real behaviour change in a PR nobody would review as such. That
// work has now happened on its own: three shared hooks
// (`useHydrated`, `useStoredValue`, `useResetOnChange`) replaced the patterns,
// and the two remaining sites carry a targeted disable explaining that the rule
// cannot see past an `await`.
//
// A number that is allowed to grow is not a gate, so there is no warning level
// left to drift back into.

export default config;
